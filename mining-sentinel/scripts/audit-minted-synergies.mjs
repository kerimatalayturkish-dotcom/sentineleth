import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const traitsPath = path.join(repoRoot, "config/traits.json");
const powerPath = path.join(repoRoot, "mining-sentinel/config/trait-power.json");
const generatedDir = path.join(repoRoot, "mining-sentinel/generated");
const reportPath = path.join(generatedDir, "minted-synergy-audit.md");
const jsonPath = path.join(generatedDir, "minted-synergy-audit.json");

const contractAddress = "0x531cb7619cea5e0b5a8454a08f56e725c1db273e";
const rpcUrl = process.env.SENTINEL_AUDIT_RPC_URL || "https://ethereum-rpc.publicnode.com";
const batchSize = 75;
const fetchConcurrency = 8;

const abi = [
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }]
  },
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ type: "uint256", name: "tokenId" }],
    outputs: [{ type: "string" }]
  }
];

const tierOrder = ["mythic", "legendary", "rare", "uncommon", "common"];

function toPosix(filePath) {
  return filePath.replaceAll("\\", "/");
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function run() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, run);
  await Promise.all(workers);
  return results;
}

function buildIndexes(traitsConfig) {
  const layerByName = new Map();
  const layerById = new Map();
  const traitByLayerAndValue = new Map();

  for (const layer of traitsConfig.layers) {
    layerByName.set(layer.name, layer);
    layerById.set(layer.id, layer);
    const byValue = new Map();
    for (const option of layer.options) {
      byValue.set(option.name, option.id);
      byValue.set(option.id, option.id);
    }
    traitByLayerAndValue.set(layer.id, byValue);
  }

  return { layerByName, layerById, traitByLayerAndValue };
}

function normalizeMetadataUrl(uri) {
  if (!uri) return "";
  if (uri.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${uri.slice("ipfs://".length)}`;
  if (uri.startsWith("ar://")) return `https://arweave.net/${uri.slice("ar://".length)}`;
  return uri;
}

function candidateMetadataUrls(url) {
  const urls = [url];
  const match = url.match(/^https:\/\/gateway\.irys\.xyz\/(.+)$/);
  if (match) {
    urls.push(`https://arweave.net/${match[1]}`);
  }
  return urls;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const errors = [];
  for (const candidateUrl of candidateMetadataUrls(url)) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(candidateUrl, {
          headers: { accept: "application/json" }
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
        return await response.json();
      } catch (error) {
        errors.push(`${candidateUrl} attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`);
        await delay(250 * attempt);
      }
    }
  }
  throw new Error(errors.join(" | "));
}

function parseMetadata({ tokenId, tokenURI, metadata, indexes, powerConfig }) {
  const traitIdsByLayer = {};
  const rows = [];
  const unknownTraits = [];
  const duplicateLayers = [];
  let basePower = 0;

  for (const attribute of metadata.attributes ?? []) {
    const traitType = String(attribute.trait_type ?? "");
    const value = String(attribute.value ?? "");
    const layer = indexes.layerByName.get(traitType);
    if (!layer) {
      unknownTraits.push({ traitType, value, reason: "unknown trait_type" });
      continue;
    }

    if (traitIdsByLayer[layer.id]) {
      duplicateLayers.push(layer.id);
    }

    const traitId = indexes.traitByLayerAndValue.get(layer.id).get(value);
    if (!traitId) {
      unknownTraits.push({ traitType, value, reason: "unknown value for known layer" });
      continue;
    }

    const tier = powerConfig.layers[layer.id]?.traits?.[traitId];
    if (!tier) {
      unknownTraits.push({ traitType, value, layer: layer.id, traitId, reason: "missing from trait-power config" });
      continue;
    }

    const tierValue = powerConfig.tierValues[tier];
    const weight = powerConfig.layerWeightsBps[layer.id] / 1000;
    const contribution = tierValue * weight;
    traitIdsByLayer[layer.id] = traitId;
    basePower += contribution;
    rows.push({ layer: layer.id, traitType, value, traitId, tier, tierValue, weight, contribution });
  }

  const missingRequiredLayers = [];
  for (const layer of indexes.layerById.values()) {
    if (layer.required && !traitIdsByLayer[layer.id]) {
      missingRequiredLayers.push(layer.id);
    }
  }

  const synergies = powerConfig.synergies.filter((synergy) =>
    synergy.requires.every((requirement) => requirement.anyOf.includes(traitIdsByLayer[requirement.layer]))
  );

  let multiplierBps = powerConfig.synergyMultiplierScale;
  for (const synergy of synergies) {
    multiplierBps = Math.floor((multiplierBps * synergy.multiplierBps) / powerConfig.synergyMultiplierScale);
  }
  multiplierBps = Math.min(multiplierBps, powerConfig.maxSynergyMultiplierBps);
  const finalPower = (basePower * multiplierBps) / powerConfig.synergyMultiplierScale;

  return {
    tokenId,
    name: metadata.name ?? `SentinelETH #${String(tokenId).padStart(5, "0")}`,
    tokenURI,
    image: metadata.image ?? null,
    attributesCount: metadata.attributes?.length ?? 0,
    rows,
    traitIdsByLayer,
    unknownTraits,
    duplicateLayers,
    missingRequiredLayers,
    synergies: synergies.map((synergy) => ({ id: synergy.id, name: synergy.name, multiplierBps: synergy.multiplierBps })),
    basePower,
    multiplierBps,
    finalPower
  };
}

function formatMultiplier(multiplierBps) {
  return `${(multiplierBps / 10000).toFixed(2).replace(/\.00$/, "")}x`;
}

function createReport(audit) {
  const lines = [];
  const synergyTokens = audit.tokens.filter((token) => token.synergies.length > 0);
  const issueTokens = audit.tokens.filter((token) =>
    token.unknownTraits.length > 0 || token.duplicateLayers.length > 0 || token.missingRequiredLayers.length > 0
  );
  const topPower = [...audit.tokens].sort((a, b) => b.finalPower - a.finalPower).slice(0, 20);

  lines.push("# Minted SentinelETH Synergy Audit");
  lines.push("");
  lines.push(`Generated: ${audit.generatedAt}`);
  lines.push(`Contract: ${audit.contractAddress}`);
  lines.push(`Trait power config: \`${toPosix(path.relative(repoRoot, powerPath))}\``);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Total supply reported by contract: ${audit.totalSupply}`);
  lines.push(`- Token IDs checked: ${audit.tokenIdsChecked.length}`);
  lines.push(`- Metadata fetched: ${audit.tokens.length}`);
  lines.push(`- Empty tokenURI results: ${audit.emptyTokenURI.length}`);
  lines.push(`- tokenURI call failures: ${audit.tokenURIFailures.length}`);
  lines.push(`- Metadata fetch failures: ${audit.metadataFailures.length}`);
  lines.push(`- Tokens with unknown/missing traits: ${issueTokens.length}`);
  lines.push(`- Tokens with synergy multiplier: ${synergyTokens.length}`);
  lines.push("");

  lines.push("## Synergy Matches");
  lines.push("");
  if (synergyTokens.length === 0) {
    lines.push("No minted tokens currently match a synergy combo.");
  } else {
    lines.push("| Token | Base Power | Multiplier | Final Power | Synergies |");
    lines.push("| ---: | ---: | ---: | ---: | --- |");
    for (const token of synergyTokens) {
      lines.push(`| ${token.tokenId} | ${token.basePower} | ${formatMultiplier(token.multiplierBps)} | ${token.finalPower} | ${token.synergies.map((synergy) => synergy.id).join(", ")} |`);
    }
  }
  lines.push("");

  lines.push("## Unknown Or Missing Traits");
  lines.push("");
  if (issueTokens.length === 0) {
    lines.push("No unknown trait types, unknown values, missing required layers, or duplicate layers were found in fetched metadata.");
  } else {
    lines.push("| Token | Issues |");
    lines.push("| ---: | --- |");
    for (const token of issueTokens) {
      const issues = [
        ...token.unknownTraits.map((trait) => `${trait.reason}: ${trait.traitType}=${trait.value}`),
        ...token.missingRequiredLayers.map((layer) => `missing required layer: ${layer}`),
        ...token.duplicateLayers.map((layer) => `duplicate layer: ${layer}`)
      ];
      lines.push(`| ${token.tokenId} | ${issues.join("; ")} |`);
    }
  }
  lines.push("");

  lines.push("## Top Power Tokens");
  lines.push("");
  lines.push("| Rank | Token | Base Power | Multiplier | Final Power | Traits |");
  lines.push("| ---: | ---: | ---: | ---: | ---: | --- |");
  topPower.forEach((token, index) => {
    const traits = token.rows.map((row) => `${row.layer}:${row.traitId}`).join("; ");
    lines.push(`| ${index + 1} | ${token.tokenId} | ${token.basePower} | ${formatMultiplier(token.multiplierBps)} | ${token.finalPower} | ${traits} |`);
  });
  lines.push("");

  if (audit.emptyTokenURI.length > 0) {
    lines.push("## Empty Token URIs");
    lines.push("");
    lines.push(audit.emptyTokenURI.join(", "));
    lines.push("");
  }

  if (audit.metadataFailures.length > 0) {
    lines.push("## Metadata Fetch Failures");
    lines.push("");
    lines.push("| Token | URI | Error |");
    lines.push("| ---: | --- | --- |");
    for (const failure of audit.metadataFailures) {
      lines.push(`| ${failure.tokenId} | ${failure.tokenURI} | ${failure.error} |`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const [traitsConfig, powerConfig] = await Promise.all([readJson(traitsPath), readJson(powerPath)]);
  const indexes = buildIndexes(traitsConfig);
  const client = createPublicClient({ chain: mainnet, transport: http(rpcUrl) });

  const totalSupply = Number(await client.readContract({ address: contractAddress, abi, functionName: "totalSupply" }));
  const tokenIds = Array.from({ length: totalSupply }, (_, index) => index + 1);

  const tokenURIs = [];
  const tokenURIFailures = [];
  for (const ids of chunk(tokenIds, batchSize)) {
    const results = await client.multicall({
      allowFailure: true,
      contracts: ids.map((tokenId) => ({
        address: contractAddress,
        abi,
        functionName: "tokenURI",
        args: [BigInt(tokenId)]
      }))
    });

    results.forEach((result, index) => {
      const tokenId = ids[index];
      if (result.status === "success") {
        tokenURIs.push({ tokenId, tokenURI: result.result });
      } else {
        tokenURIFailures.push({ tokenId, error: result.error?.shortMessage ?? result.error?.message ?? "unknown error" });
      }
    });
  }

  const emptyTokenURI = tokenURIs.filter((item) => !item.tokenURI).map((item) => item.tokenId);
  const uriItems = tokenURIs.filter((item) => item.tokenURI);
  const metadataFailures = [];
  const tokens = [];

  await mapConcurrent(uriItems, fetchConcurrency, async (item) => {
    const metadataUrl = normalizeMetadataUrl(item.tokenURI);
    try {
      const metadata = await fetchJson(metadataUrl);
      tokens.push(parseMetadata({ tokenId: item.tokenId, tokenURI: item.tokenURI, metadata, indexes, powerConfig }));
    } catch (error) {
      metadataFailures.push({ tokenId: item.tokenId, tokenURI: item.tokenURI, error: error instanceof Error ? error.message : String(error) });
    }
  });

  tokens.sort((a, b) => a.tokenId - b.tokenId);
  const audit = {
    generatedAt: new Date().toISOString(),
    contractAddress,
    totalSupply,
    tokenIdsChecked: tokenIds,
    emptyTokenURI,
    tokenURIFailures,
    metadataFailures,
    tokens
  };

  await mkdir(generatedDir, { recursive: true });
  await writeFile(jsonPath, JSON.stringify(audit, null, 2));
  await writeFile(reportPath, createReport(audit));

  const synergyCount = tokens.filter((token) => token.synergies.length > 0).length;
  const issueCount = tokens.filter((token) => token.unknownTraits.length > 0 || token.duplicateLayers.length > 0 || token.missingRequiredLayers.length > 0).length;
  console.log(`Contract totalSupply: ${totalSupply}`);
  console.log(`Metadata fetched: ${tokens.length}`);
  console.log(`Empty tokenURI: ${emptyTokenURI.length}`);
  console.log(`tokenURI failures: ${tokenURIFailures.length}`);
  console.log(`Metadata fetch failures: ${metadataFailures.length}`);
  console.log(`Tokens with unknown/missing trait issues: ${issueCount}`);
  console.log(`Tokens with synergy multiplier: ${synergyCount}`);
  console.log(`Report: ${toPosix(path.relative(repoRoot, reportPath))}`);
  console.log(`JSON: ${toPosix(path.relative(repoRoot, jsonPath))}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});