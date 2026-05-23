import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters, keccak256, stringToHex } from "viem";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

const traitsPath = path.join(repoRoot, "config/traits.json");
const powerPath = path.join(repoRoot, "mining-sentinel/config/trait-power.json");
const generatedDir = path.join(repoRoot, "mining-sentinel/generated");
const loaderPath = path.join(generatedDir, "trait-registry-loader.json");
const reportPath = path.join(generatedDir, "trait-registry-report.md");
const csvPath = path.join(generatedDir, "trait-registry-rules.csv");

const defaultTraitBatchSize = 50;

function usage() {
  return `Usage:
  node mining-sentinel/scripts/build-trait-rules-registry.mjs --write

Options:
  --write                 Write registry loader JSON, CSV, and report.
  --trait-batch-size <n>  Trait setTraitValues batch size. Default ${defaultTraitBatchSize}.
`;
}

function parseArgs(argv) {
  const options = { write: false, traitBatchSize: defaultTraitBatchSize };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") {
      options.write = true;
    } else if (arg === "--trait-batch-size") {
      options.traitBatchSize = Number(argv[++index]);
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }

  if (!Number.isSafeInteger(options.traitBatchSize) || options.traitBatchSize <= 0) {
    throw new Error(`Invalid --trait-batch-size: ${options.traitBatchSize}`);
  }
  return options;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function toPosix(filePath) {
  return filePath.replaceAll("\\", "/");
}

function canonicalStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;

  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalStringify(item)}`).join(",")}}`;
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function hashJson(value) {
  return keccak256(stringToHex(canonicalStringify(value)));
}

function scoringInput(powerConfig) {
  return {
    version: powerConfig.version,
    collectionCap: powerConfig.collectionCap,
    tierValues: powerConfig.tierValues,
    layerWeightsBps: powerConfig.layerWeightsBps,
    synergyMultiplierScale: powerConfig.synergyMultiplierScale,
    maxSynergyMultiplierBps: powerConfig.maxSynergyMultiplierBps,
    layers: powerConfig.layers,
    synergies: powerConfig.synergies
  };
}

function buildRows({ traitsConfig, powerConfig }) {
  const layerRows = [...traitsConfig.layers]
    .sort((left, right) => left.order - right.order)
    .map((layer) => ({
      layerId: layer.id,
      name: layer.name,
      order: layer.order,
      required: Boolean(layer.required),
      weightBps: powerConfig.layerWeightsBps[layer.id]
    }));

  const traitRows = [];
  for (const layer of [...traitsConfig.layers].sort((left, right) => left.order - right.order)) {
    const traitTiers = powerConfig.layers[layer.id]?.traits ?? {};
    for (const option of layer.options ?? []) {
      const tier = traitTiers[option.id];
      const value = powerConfig.tierValues[tier];
      traitRows.push({
        layerId: layer.id,
        layerName: layer.name,
        traitId: option.id,
        traitName: option.name,
        tier,
        value,
        weightedValue: (value * powerConfig.layerWeightsBps[layer.id]) / 1000,
        file: option.file
      });
    }
  }

  const synergyRows = (powerConfig.synergies ?? []).map((synergy) => ({
    id: synergy.id,
    name: synergy.name,
    multiplierBps: synergy.multiplierBps,
    requires: synergy.requires
  }));

  return { layerRows, traitRows, synergyRows };
}

function validateRows({ layerRows, traitRows, synergyRows }) {
  const errors = [];
  for (const layer of layerRows) {
    if (!Number.isInteger(layer.weightBps) || layer.weightBps <= 0) {
      errors.push(`Invalid layer weight: ${layer.layerId}`);
    }
  }
  for (const trait of traitRows) {
    if (!trait.tier || !Number.isInteger(trait.value) || trait.value <= 0) {
      errors.push(`Invalid trait value: ${trait.layerId}.${trait.traitId}`);
    }
  }
  for (const synergy of synergyRows) {
    if (!Number.isInteger(synergy.multiplierBps) || synergy.multiplierBps < 10000 || synergy.multiplierBps > 40000) {
      errors.push(`Invalid synergy multiplier: ${synergy.id}`);
    }
  }
  return errors;
}

function rulesCommitment({ traitsSourceHash, powerConfigHash, synergyRulesHash, collectionCap, layerCount, traitCount, synergyCount }) {
  return keccak256(encodeAbiParameters(
    [
      { name: "version", type: "uint256" },
      { name: "traitsSourceHash", type: "bytes32" },
      { name: "powerConfigHash", type: "bytes32" },
      { name: "synergyRulesHash", type: "bytes32" },
      { name: "collectionCap", type: "uint256" },
      { name: "layerCount", type: "uint16" },
      { name: "traitCount", type: "uint16" },
      { name: "synergyCount", type: "uint16" }
    ],
    [1n, traitsSourceHash, powerConfigHash, synergyRulesHash, BigInt(collectionCap), layerCount, traitCount, synergyCount]
  ));
}

function makeLoader({ traitsConfig, powerConfig, rows, options }) {
  const traitsSourceHash = hashJson(traitsConfig);
  const powerConfigHash = hashJson(scoringInput(powerConfig));
  const synergyRulesHash = hashJson(powerConfig.synergies ?? []);
  const commitment = rulesCommitment({
    traitsSourceHash,
    powerConfigHash,
    synergyRulesHash,
    collectionCap: powerConfig.collectionCap,
    layerCount: rows.layerRows.length,
    traitCount: rows.traitRows.length,
    synergyCount: rows.synergyRows.length
  });

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    reviewStatus: "draft-current-config",
    contract: {
      name: "TraitRegistry",
      constructorArgs: [
        "<ADMIN_SAFE_ADDRESS>",
        traitsSourceHash,
        powerConfigHash,
        synergyRulesHash,
        commitment,
        powerConfig.collectionCap,
        rows.layerRows.length,
        rows.traitRows.length,
        rows.synergyRows.length
      ],
      methods: [
        "setLayerWeights(string[] layerIds,uint32[] weightsBps)",
        "setTraitValues(string[] layerIds,string[] traitIds,uint32[] values)",
        "setSynergyMultipliers(string[] synergyIds,uint32[] multipliersBps)",
        "finalize()"
      ]
    },
    sourceFiles: {
      traits: toPosix(path.relative(repoRoot, traitsPath)),
      powerConfig: toPosix(path.relative(repoRoot, powerPath))
    },
    hashes: {
      traitsSourceHash,
      powerConfigHash,
      synergyRulesHash,
      rulesCommitment: commitment
    },
    collectionCap: powerConfig.collectionCap,
    counts: {
      layers: rows.layerRows.length,
      traits: rows.traitRows.length,
      synergies: rows.synergyRows.length
    },
    layerWeights: {
      layerIds: rows.layerRows.map((row) => row.layerId),
      weightsBps: rows.layerRows.map((row) => row.weightBps)
    },
    traitValueBatches: chunk(rows.traitRows, options.traitBatchSize).map((batch, index) => ({
      index,
      count: batch.length,
      layerIds: batch.map((row) => row.layerId),
      traitIds: batch.map((row) => row.traitId),
      values: batch.map((row) => row.value)
    })),
    synergyMultipliers: {
      synergyIds: rows.synergyRows.map((row) => row.id),
      multipliersBps: rows.synergyRows.map((row) => row.multiplierBps)
    },
    rows
  };
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function createCsv({ layerRows, traitRows, synergyRows }) {
  const lines = [["kind", "layerId", "traitOrSynergyId", "name", "tier", "value", "weightBps", "weightedValue", "requirements"].join(",")];
  for (const layer of layerRows) {
    lines.push(["layer", layer.layerId, "", layer.name, "", "", layer.weightBps, "", ""].map(csvEscape).join(","));
  }
  for (const trait of traitRows) {
    lines.push(["trait", trait.layerId, trait.traitId, trait.traitName, trait.tier, trait.value, "", trait.weightedValue, ""].map(csvEscape).join(","));
  }
  for (const synergy of synergyRows) {
    const requirements = synergy.requires.map((requirement) => `${requirement.layer}:${requirement.anyOf.join("/")}`).join(";");
    lines.push(["synergy", "", synergy.id, synergy.name, "", synergy.multiplierBps, "", "", requirements].map(csvEscape).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function createReport(loader, errors) {
  const lines = [];
  lines.push("# Trait Registry Rules Report");
  lines.push("");
  lines.push(`Generated: ${loader.generatedAt}`);
  lines.push(`Review status: ${loader.reviewStatus}`);
  lines.push(`Collection cap: ${loader.collectionCap}`);
  lines.push(`Layer count: ${loader.counts.layers}`);
  lines.push(`Trait count: ${loader.counts.traits}`);
  lines.push(`Synergy count: ${loader.counts.synergies}`);
  lines.push("");
  lines.push("## Hashes");
  lines.push("");
  lines.push(`traitsSourceHash: \`${loader.hashes.traitsSourceHash}\``);
  lines.push(`powerConfigHash: \`${loader.hashes.powerConfigHash}\``);
  lines.push(`synergyRulesHash: \`${loader.hashes.synergyRulesHash}\``);
  lines.push(`rulesCommitment: \`${loader.hashes.rulesCommitment}\``);
  lines.push("");
  lines.push("## Deployment Shape");
  lines.push("");
  lines.push("Deploy `TraitRegistry` with `constructorArgs`, then call `setLayerWeights`, each `traitValueBatches` item via `setTraitValues`, `setSynergyMultipliers`, and finally `finalize()`.");
  lines.push("");
  lines.push("## Validation");
  lines.push("");
  lines.push(`Errors: ${errors.length}`);
  if (errors.length > 0) {
    for (const error of errors) lines.push(`- ${error}`);
  }
  lines.push("");
  lines.push("## Layer Weights");
  lines.push("");
  lines.push("| Layer | Weight Bps |");
  lines.push("| --- | ---: |");
  for (const layer of loader.rows.layerRows) lines.push(`| ${layer.layerId} | ${layer.weightBps} |`);
  lines.push("");
  lines.push("## Synergy Multipliers");
  lines.push("");
  lines.push("| Synergy | Multiplier Bps | Requirements |");
  lines.push("| --- | ---: | --- |");
  for (const synergy of loader.rows.synergyRows) {
    const requirements = synergy.requires.map((requirement) => `${requirement.layer}: ${requirement.anyOf.join(" / ")}`).join("; ");
    lines.push(`| ${synergy.id} | ${synergy.multiplierBps} | ${requirements} |`);
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [traitsConfig, powerConfig] = await Promise.all([readJson(traitsPath), readJson(powerPath)]);
  const rows = buildRows({ traitsConfig, powerConfig });
  const errors = validateRows(rows);
  const loader = makeLoader({ traitsConfig, powerConfig, rows, options });

  if (options.write) {
    await mkdir(generatedDir, { recursive: true });
    await writeFile(loaderPath, JSON.stringify(loader, null, 2));
    await writeFile(csvPath, createCsv(rows));
    await writeFile(reportPath, createReport(loader, errors));
  }

  console.log(`TraitRegistry rules: ${loader.counts.traits} traits, ${loader.counts.layers} layers, ${loader.counts.synergies} synergies`);
  console.log(`rulesCommitment: ${loader.hashes.rulesCommitment}`);
  console.log(`Validation errors: ${errors.length}`);
  if (options.write) {
    console.log(`Loader: ${toPosix(path.relative(repoRoot, loaderPath))}`);
    console.log(`CSV: ${toPosix(path.relative(repoRoot, csvPath))}`);
    console.log(`Report: ${toPosix(path.relative(repoRoot, reportPath))}`);
  }
  if (errors.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});