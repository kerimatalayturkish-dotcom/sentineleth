import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const powerConfigPath = path.resolve(__dirname, "../config/trait-power.json");
const reportPath = path.resolve(__dirname, "../generated/trait-power-report.md");

const tierOrder = ["mythic", "legendary", "rare", "uncommon", "common"];
const expectedTierTotals = {
  mythic: 9,
  legendary: 13,
  rare: 28,
  uncommon: 29,
  common: 33
};

function formatMultiplier(multiplierBps) {
  return `${(multiplierBps / 10000).toFixed(2).replace(/\.00$/, "")}x`;
}

function toPosixPath(filePath) {
  return filePath.replaceAll("\\", "/");
}

function weightLabel(weightBps) {
  return (weightBps / 1000).toFixed(1).replace(/\.0$/, "");
}

function weightedValue(tierValue, weightBps) {
  return (tierValue * weightBps) / 1000;
}

function addError(errors, message) {
  errors.push(message);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function buildTraitsIndex(traitsConfig) {
  const layers = new Map();
  for (const layer of traitsConfig.layers ?? []) {
    layers.set(layer.id, {
      id: layer.id,
      name: layer.name,
      required: Boolean(layer.required),
      order: layer.order,
      traitIds: new Set((layer.options ?? []).map((option) => option.id)),
      options: layer.options ?? []
    });
  }
  return layers;
}

function validateCoverage({ traitsLayers, powerConfig }) {
  const errors = [];
  const warnings = [];
  const totals = Object.fromEntries(tierOrder.map((tier) => [tier, 0]));
  const layerSummaries = [];
  const validTiers = new Set(Object.keys(powerConfig.tierValues ?? {}));
  validTiers.delete("none");

  for (const [layerId, traitsLayer] of traitsLayers) {
    const powerLayer = powerConfig.layers?.[layerId];
    if (!powerLayer) {
      addError(errors, `Missing power layer: ${layerId}`);
      continue;
    }

    const traitTierMap = powerLayer.traits ?? {};
    const powerTraitIds = new Set(Object.keys(traitTierMap));
    const counts = Object.fromEntries(tierOrder.map((tier) => [tier, 0]));

    for (const traitId of traitsLayer.traitIds) {
      if (!powerTraitIds.has(traitId)) {
        addError(errors, `Missing trait tier: ${layerId}.${traitId}`);
        continue;
      }

      const tier = traitTierMap[traitId];
      if (!validTiers.has(tier)) {
        addError(errors, `Invalid tier for ${layerId}.${traitId}: ${tier}`);
        continue;
      }

      counts[tier] += 1;
      totals[tier] += 1;
    }

    for (const traitId of powerTraitIds) {
      if (!traitsLayer.traitIds.has(traitId)) {
        addError(errors, `Power config has extra trait not in traits.json: ${layerId}.${traitId}`);
      }
    }

    if (!Number.isInteger(powerConfig.layerWeightsBps?.[layerId])) {
      addError(errors, `Missing integer layer weight: ${layerId}`);
    }

    layerSummaries.push({
      layerId,
      name: traitsLayer.name,
      required: traitsLayer.required,
      order: traitsLayer.order,
      optionCount: traitsLayer.traitIds.size,
      weightBps: powerConfig.layerWeightsBps?.[layerId],
      counts
    });
  }

  for (const layerId of Object.keys(powerConfig.layers ?? {})) {
    if (!traitsLayers.has(layerId)) {
      addError(errors, `Power config has extra layer not in traits.json: ${layerId}`);
    }
  }

  for (const tier of tierOrder) {
    if (totals[tier] !== expectedTierTotals[tier]) {
      addError(errors, `Tier total mismatch for ${tier}: expected ${expectedTierTotals[tier]}, got ${totals[tier]}`);
    }
  }

  const layerWeightTotal = Object.values(powerConfig.layerWeightsBps ?? {}).reduce((sum, value) => sum + value, 0);
  if (layerWeightTotal !== 8000) {
    warnings.push(`Layer weights sum to ${weightLabel(layerWeightTotal)} instead of 8.0`);
  }

  return { errors, warnings, totals, layerSummaries };
}

function validateSynergies({ traitsLayers, powerConfig }) {
  const errors = [];
  const warnings = [];
  const seenIds = new Set();
  const synergies = powerConfig.synergies ?? [];

  if (synergies.length !== 12) {
    warnings.push(`Expected 12 synergies, found ${synergies.length}`);
  }

  for (const synergy of synergies) {
    if (!synergy.id) {
      addError(errors, `Synergy is missing id: ${JSON.stringify(synergy)}`);
      continue;
    }
    if (seenIds.has(synergy.id)) {
      addError(errors, `Duplicate synergy id: ${synergy.id}`);
    }
    seenIds.add(synergy.id);

    if (!Number.isInteger(synergy.multiplierBps) || synergy.multiplierBps < 10000) {
      addError(errors, `Invalid multiplier for ${synergy.id}: ${synergy.multiplierBps}`);
    }
    if (synergy.multiplierBps > powerConfig.maxSynergyMultiplierBps) {
      addError(errors, `Synergy ${synergy.id} exceeds max multiplier cap`);
    }

    for (const requirement of synergy.requires ?? []) {
      const layer = traitsLayers.get(requirement.layer);
      if (!layer) {
        addError(errors, `Synergy ${synergy.id} references unknown layer: ${requirement.layer}`);
        continue;
      }

      for (const traitId of requirement.anyOf ?? []) {
        if (!layer.traitIds.has(traitId)) {
          addError(errors, `Synergy ${synergy.id} references unknown trait: ${requirement.layer}.${traitId}`);
        }
      }
    }
  }

  return { errors, warnings };
}

function createReport({ powerConfig, coverage, synergyValidation }) {
  const totalTraits = Object.values(coverage.totals).reduce((sum, value) => sum + value, 0);
  const lines = [];

  lines.push("# Mining Sentinel Trait Power Report");
  lines.push("");
  lines.push(`Generated from \`${toPosixPath(path.relative(repoRoot, powerConfigPath))}\`.`);
  lines.push(`Traits source: \`${powerConfig.traitsSource}\`.`);
  lines.push(`Collection cap: ${powerConfig.collectionCap}.`);
  lines.push(`Catalog coverage: ${totalTraits} traits.`);
  lines.push("");

  lines.push("## Tier Distribution");
  lines.push("");
  lines.push("| Tier | Count | Base Value |");
  lines.push("| --- | ---: | ---: |");
  for (const tier of tierOrder) {
    lines.push(`| ${tier} | ${coverage.totals[tier]} | ${powerConfig.tierValues[tier]} |`);
  }
  lines.push("");

  lines.push("## Layer Values");
  lines.push("");
  lines.push("Weighted values are `tier value * layer weight`.");
  lines.push("");
  lines.push("| Layer | Required | Traits | Weight | Common | Uncommon | Rare | Legendary | Mythic |");
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const layer of coverage.layerSummaries.sort((a, b) => a.order - b.order)) {
    lines.push([
      `| ${layer.layerId}`,
      layer.required ? "yes" : "no",
      layer.optionCount,
      weightLabel(layer.weightBps),
      weightedValue(powerConfig.tierValues.common, layer.weightBps),
      weightedValue(powerConfig.tierValues.uncommon, layer.weightBps),
      weightedValue(powerConfig.tierValues.rare, layer.weightBps),
      weightedValue(powerConfig.tierValues.legendary, layer.weightBps),
      `${weightedValue(powerConfig.tierValues.mythic, layer.weightBps)} |`
    ].join(" | "));
  }
  lines.push("");

  lines.push("## Layer Tier Counts");
  lines.push("");
  lines.push("| Layer | Mythic | Legendary | Rare | Uncommon | Common |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const layer of coverage.layerSummaries.sort((a, b) => a.order - b.order)) {
    lines.push(`| ${layer.layerId} | ${layer.counts.mythic} | ${layer.counts.legendary} | ${layer.counts.rare} | ${layer.counts.uncommon} | ${layer.counts.common} |`);
  }
  lines.push("");

  lines.push("## Synergies");
  lines.push("");
  lines.push(`Synergy multipliers multiply together and clamp at ${formatMultiplier(powerConfig.maxSynergyMultiplierBps)}.`);
  lines.push("");
  lines.push("| ID | Multiplier | Requirements |");
  lines.push("| --- | ---: | --- |");
  for (const synergy of powerConfig.synergies) {
    const requirements = synergy.requires
      .map((requirement) => `${requirement.layer}: ${requirement.anyOf.join(" / ")}`)
      .join("; ");
    lines.push(`| ${synergy.id} | ${formatMultiplier(synergy.multiplierBps)} | ${requirements} |`);
  }
  lines.push("");

  lines.push("## Verification");
  lines.push("");
  lines.push(`Coverage errors: ${coverage.errors.length}.`);
  lines.push(`Synergy errors: ${synergyValidation.errors.length}.`);
  lines.push(`Warnings: ${coverage.warnings.length + synergyValidation.warnings.length}.`);
  lines.push("");

  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const powerConfig = await readJson(powerConfigPath);
  const traitsSourcePath = path.resolve(path.dirname(powerConfigPath), powerConfig.traitsSource);
  const traitsConfig = await readJson(traitsSourcePath);
  const traitsLayers = buildTraitsIndex(traitsConfig);

  const coverage = validateCoverage({ traitsLayers, powerConfig });
  const synergyValidation = validateSynergies({ traitsLayers, powerConfig });
  const errors = [...coverage.errors, ...synergyValidation.errors];
  const warnings = [...coverage.warnings, ...synergyValidation.warnings];

  if (args.has("--write-report")) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, createReport({ powerConfig, coverage, synergyValidation }));
  }

  const totalTraits = Object.values(coverage.totals).reduce((sum, value) => sum + value, 0);
  console.log(`Trait power coverage: ${totalTraits} traits across ${traitsLayers.size} layers`);
  console.log(`Tier totals: ${tierOrder.map((tier) => `${tier}=${coverage.totals[tier]}`).join(", ")}`);
  console.log(`Synergies: ${(powerConfig.synergies ?? []).length}`);
  if (args.has("--write-report")) {
    console.log(`Report written: ${toPosixPath(path.relative(repoRoot, reportPath))}`);
  }

  for (const warning of warnings) {
    console.warn(`WARN: ${warning}`);
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`ERROR: ${error}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});