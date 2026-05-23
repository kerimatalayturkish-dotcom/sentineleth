import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, encodeAbiParameters, http, keccak256, stringToHex } from "viem";
import { mainnet } from "viem/chains";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

const traitsPath = path.join(repoRoot, "config/traits.json");
const powerPath = path.join(repoRoot, "mining-sentinel/config/trait-power.json");
const generatedDir = path.join(repoRoot, "mining-sentinel/generated");
const defaultAuditPath = path.join(generatedDir, "minted-synergy-audit.json");
const loaderPath = path.join(generatedDir, "token-power-audit-loader.json");
const csvPath = path.join(generatedDir, "token-power-audit-powers.csv");
const reportPath = path.join(generatedDir, "token-power-audit-report.md");

const contractAddress = "0x531cb7619cea5e0b5a8454a08f56e725c1db273e";
const rpcUrl = process.env.SENTINEL_AUDIT_RPC_URL || "https://ethereum-rpc.publicnode.com";
const tokenUriBatchSize = 75;
const fetchConcurrency = 8;
const defaultRegistryBatchSize = 250;
const defaultPowerScale = 1000;

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

function usage() {
  return `Usage:
  node mining-sentinel/scripts/build-trait-registry.mjs --write
  node mining-sentinel/scripts/build-trait-registry.mjs --live --write
  node mining-sentinel/scripts/build-trait-registry.mjs --from-audit mining-sentinel/generated/minted-synergy-audit.json --write

Options:
  --write                 Write generated loader JSON, CSV, and report.
  --live                  Fetch tokenURI + metadata from the mainnet NFT contract.
  --from-audit <path>     Build from a cached minted-synergy-audit.json file. Default when --live is not set.
  --require-complete      Exit nonzero unless all 10,000 token powers are present and issue-free.
  --batch-size <number>   Token-power audit batch size. Default ${defaultRegistryBatchSize}.
  --power-scale <number>  Integer power scale. Default ${defaultPowerScale}.
`;
}

function parseArgs(argv) {
  const options = {
    write: false,
    live: false,
    auditPath: defaultAuditPath,
    requireComplete: false,
    batchSize: defaultRegistryBatchSize,
    powerScale: defaultPowerScale
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") {
      options.write = true;
    } else if (arg === "--live") {
      options.live = true;
    } else if (arg === "--from-audit") {
      options.auditPath = path.resolve(repoRoot, argv[++index] ?? "");
    } else if (arg === "--require-complete") {
      options.requireComplete = true;
    } else if (arg === "--batch-size") {
      options.batchSize = Number(argv[++index]);
    } else if (arg === "--power-scale") {
      options.powerScale = Number(argv[++index]);
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }

  if (!Number.isSafeInteger(options.batchSize) || options.batchSize <= 0) {
    throw new Error(`Invalid --batch-size: ${options.batchSize}`);
  }
  if (!Number.isSafeInteger(options.powerScale) || options.powerScale <= 0 || options.powerScale > 100000) {
    throw new Error(`Invalid --power-scale: ${options.powerScale}`);
  }

  return options;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function toPosix(filePath) {
  return filePath.replaceAll("\\", "/");
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

  for (const layer of traitsConfig.layers ?? []) {
    layerByName.set(layer.name, layer);
    layerById.set(layer.id, layer);
    const byValue = new Map();
    for (const option of layer.options ?? []) {
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
  if (match) urls.push(`https://arweave.net/${match[1]}`);
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
        const response = await fetch(candidateUrl, { headers: { accept: "application/json" } });
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
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
  const unknownTraits = [];
  const duplicateLayers = [];

  for (const attribute of metadata.attributes ?? []) {
    const traitType = String(attribute.trait_type ?? "");
    const value = String(attribute.value ?? "");
    const layer = indexes.layerByName.get(traitType);
    if (!layer) {
      unknownTraits.push({ traitType, value, reason: "unknown trait_type" });
      continue;
    }

    if (traitIdsByLayer[layer.id]) duplicateLayers.push(layer.id);

    const traitId = indexes.traitByLayerAndValue.get(layer.id)?.get(value);
    if (!traitId) {
      unknownTraits.push({ traitType, value, reason: "unknown value for known layer" });
      continue;
    }

    if (!powerConfig.layers[layer.id]?.traits?.[traitId]) {
      unknownTraits.push({ traitType, value, layer: layer.id, traitId, reason: "missing from trait-power config" });
      continue;
    }

    traitIdsByLayer[layer.id] = traitId;
  }

  const missingRequiredLayers = [];
  for (const layer of indexes.layerById.values()) {
    if (layer.required && !traitIdsByLayer[layer.id]) missingRequiredLayers.push(layer.id);
  }

  return {
    tokenId,
    name: metadata.name ?? `SentinelETH #${String(tokenId).padStart(5, "0")}`,
    tokenURI,
    image: metadata.image ?? null,
    traitIdsByLayer,
    unknownTraits,
    duplicateLayers,
    missingRequiredLayers
  };
}

function hasTokenIssues(token) {
  return token.unknownTraits.length > 0 || token.duplicateLayers.length > 0 || token.missingRequiredLayers.length > 0;
}

function computePower({ token, indexes, powerConfig, powerScale }) {
  let basePowerMilli = 0;
  const rows = [];
  const issues = [...(token.unknownTraits ?? [])];

  for (const layer of [...indexes.layerById.values()].sort((a, b) => a.order - b.order)) {
    const traitId = token.traitIdsByLayer?.[layer.id];
    if (!traitId) continue;

    const tier = powerConfig.layers[layer.id]?.traits?.[traitId];
    const tierValue = powerConfig.tierValues?.[tier];
    const weightBps = powerConfig.layerWeightsBps?.[layer.id];

    if (!tier || !Number.isFinite(tierValue) || !Number.isInteger(weightBps)) {
      issues.push({ layer: layer.id, traitId, reason: "cannot score trait" });
      continue;
    }

    const contributionMilli = tierValue * weightBps;
    basePowerMilli += contributionMilli;
    rows.push({ layer: layer.id, traitId, tier, tierValue, weightBps, contributionMilli });
  }

  const synergies = (powerConfig.synergies ?? []).filter((synergy) =>
    synergy.requires.every((requirement) => requirement.anyOf.includes(token.traitIdsByLayer?.[requirement.layer]))
  );

  let multiplierBps = powerConfig.synergyMultiplierScale;
  for (const synergy of synergies) {
    multiplierBps = Math.floor((multiplierBps * synergy.multiplierBps) / powerConfig.synergyMultiplierScale);
  }
  multiplierBps = Math.min(multiplierBps, powerConfig.maxSynergyMultiplierBps);

  const scaledPower = Math.floor(
    (basePowerMilli * multiplierBps * powerScale) /
      (1000 * powerConfig.synergyMultiplierScale)
  );

  return {
    tokenId: token.tokenId,
    name: token.name,
    tokenURI: token.tokenURI,
    image: token.image ?? null,
    traitIdsByLayer: token.traitIdsByLayer,
    rows,
    unknownTraits: token.unknownTraits ?? [],
    duplicateLayers: token.duplicateLayers ?? [],
    missingRequiredLayers: token.missingRequiredLayers ?? [],
    issues,
    synergies: synergies.map((synergy) => ({ id: synergy.id, name: synergy.name, multiplierBps: synergy.multiplierBps })),
    basePowerMilli,
    basePower: basePowerMilli / 1000,
    multiplierBps,
    scaledPower,
    displayPower: scaledPower / powerScale
  };
}

function canonicalStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;

  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalStringify(item)}`).join(",")}}`;
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

function commitmentFor({ tokens, powerConfig, powerScale }) {
  const powerConfigHash = keccak256(stringToHex(canonicalStringify(scoringInput(powerConfig))));
  const table = tokens.map((token) => [BigInt(token.tokenId), token.scaledPower]);
  const finalPowerTableHash = keccak256(encodeAbiParameters(
    [
      {
        type: "tuple[]",
        components: [
          { name: "tokenId", type: "uint256" },
          { name: "power", type: "uint32" }
        ]
      }
    ],
    [table]
  ));

  const traitsCommitment = keccak256(encodeAbiParameters(
    [
      { name: "version", type: "uint256" },
      { name: "powerConfigHash", type: "bytes32" },
      { name: "collectionCap", type: "uint256" },
      { name: "powerScale", type: "uint32" },
      { name: "finalPowerTableHash", type: "bytes32" }
    ],
    [1n, powerConfigHash, BigInt(powerConfig.collectionCap), powerScale, finalPowerTableHash]
  ));

  return { powerConfigHash, finalPowerTableHash, traitsCommitment };
}

function makeBatches(tokens, batchSize) {
  return chunk(tokens, batchSize).map((batch, index) => ({
    index,
    count: batch.length,
    startTokenId: batch[0]?.tokenId ?? null,
    endTokenId: batch.at(-1)?.tokenId ?? null,
    tokenIds: batch.map((token) => token.tokenId),
    powers: batch.map((token) => token.scaledPower)
  }));
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function createCsv(tokens) {
  const lines = [
    ["tokenId", "scaledPower", "displayPower", "basePower", "multiplierBps", "synergies", "traits", "name", "tokenURI"].join(",")
  ];
  for (const token of tokens) {
    const traits = Object.entries(token.traitIdsByLayer ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([layer, traitId]) => `${layer}:${traitId}`)
      .join(";");
    lines.push([
      token.tokenId,
      token.scaledPower,
      token.displayPower,
      token.basePower,
      token.multiplierBps,
      token.synergies.map((synergy) => synergy.id).join(";"),
      traits,
      token.name,
      token.tokenURI
    ].map(csvEscape).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function createReport(loader) {
  const issueTokens = loader.tokens.filter((token) => token.issueCount > 0);
  const topTokens = [...loader.tokens].sort((a, b) => b.scaledPower - a.scaledPower).slice(0, 20);
  const lines = [];

  lines.push("# Token Power Audit Report");
  lines.push("");
  lines.push(`Generated: ${loader.generatedAt}`);
  lines.push(`Source: ${loader.source.kind}`);
  if (loader.source.path) lines.push(`Source file: \`${loader.source.path}\``);
  lines.push(`Collection cap: ${loader.collectionCap}`);
  lines.push(`Total supply/source token count: ${loader.source.totalSupply}`);
  lines.push(`Token powers generated: ${loader.tokenCount}`);
  lines.push(`Power scale: ${loader.powerScale}`);
  lines.push(`Complete 10K token-power audit: ${loader.readyForFinalize ? "yes" : "no"}`);
  lines.push("");

  lines.push("## Commitment");
  lines.push("");
  lines.push(`traitsCommitment: \`${loader.traitsCommitment}\``);
  lines.push(`powerConfigHash: \`${loader.powerConfigHash}\``);
  lines.push(`finalPowerTableHash: \`${loader.finalPowerTableHash}\``);
  lines.push("");

  lines.push("## Issue Summary");
  lines.push("");
  lines.push(`- Empty tokenURI: ${loader.issues.emptyTokenURI.length}`);
  lines.push(`- tokenURI failures: ${loader.issues.tokenURIFailures.length}`);
  lines.push(`- Metadata failures: ${loader.issues.metadataFailures.length}`);
  lines.push(`- Tokens with trait issues: ${issueTokens.length}`);
  lines.push(`- Missing token IDs for complete 10K registry: ${loader.issues.missingTokenIds.length}`);
  lines.push("");

  lines.push("## Loader Batches");
  lines.push("");
  lines.push(`Batch size: ${loader.batchSize}`);
  lines.push(`Batch count: ${loader.batches.length}`);
  lines.push("");

  lines.push("## Top Power Tokens");
  lines.push("");
  lines.push("| Rank | Token | Scaled Power | Display Power | Multiplier | Synergies |");
  lines.push("| ---: | ---: | ---: | ---: | ---: | --- |");
  topTokens.forEach((token, index) => {
    lines.push(`| ${index + 1} | ${token.tokenId} | ${token.scaledPower} | ${token.displayPower} | ${token.multiplierBps} | ${token.synergies.join(", ")} |`);
  });
  lines.push("");

  if (loader.issues.emptyTokenURI.length > 0) {
    lines.push("## Empty Token URIs");
    lines.push("");
    lines.push(loader.issues.emptyTokenURI.join(", "));
    lines.push("");
  }

  if (loader.issues.missingTokenIds.length > 0) {
    lines.push("## Missing Token IDs");
    lines.push("");
    lines.push("The registry is draft-only until every token ID from 1 to collectionCap has a scored metadata row.");
    lines.push("");
    lines.push(loader.issues.missingTokenIds.slice(0, 200).join(", "));
    if (loader.issues.missingTokenIds.length > 200) {
      lines.push("");
      lines.push(`...and ${loader.issues.missingTokenIds.length - 200} more.`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

async function loadFromAudit({ auditPath }) {
  const audit = await readJson(auditPath);
  return {
    source: {
      kind: "audit-cache",
      path: toPosix(path.relative(repoRoot, auditPath)),
      generatedAt: audit.generatedAt,
      contractAddress: audit.contractAddress,
      totalSupply: audit.totalSupply
    },
    rawTokens: audit.tokens ?? [],
    emptyTokenURI: audit.emptyTokenURI ?? [],
    tokenURIFailures: audit.tokenURIFailures ?? [],
    metadataFailures: audit.metadataFailures ?? []
  };
}

async function loadFromLive({ indexes, powerConfig }) {
  const client = createPublicClient({ chain: mainnet, transport: http(rpcUrl) });
  const totalSupply = Number(await client.readContract({ address: contractAddress, abi, functionName: "totalSupply" }));
  const tokenIds = Array.from({ length: totalSupply }, (_, index) => index + 1);
  const tokenURIs = [];
  const tokenURIFailures = [];

  for (const ids of chunk(tokenIds, tokenUriBatchSize)) {
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
  const rawTokens = [];

  await mapConcurrent(uriItems, fetchConcurrency, async (item) => {
    const metadataUrl = normalizeMetadataUrl(item.tokenURI);
    try {
      const metadata = await fetchJson(metadataUrl);
      rawTokens.push(parseMetadata({ tokenId: item.tokenId, tokenURI: item.tokenURI, metadata, indexes, powerConfig }));
    } catch (error) {
      metadataFailures.push({ tokenId: item.tokenId, tokenURI: item.tokenURI, error: error instanceof Error ? error.message : String(error) });
    }
  });

  rawTokens.sort((a, b) => a.tokenId - b.tokenId);
  return {
    source: {
      kind: "live-mainnet",
      contractAddress,
      rpcUrl,
      totalSupply
    },
    rawTokens,
    emptyTokenURI,
    tokenURIFailures,
    metadataFailures
  };
}

function buildLoader({ sourceData, indexes, powerConfig, options }) {
  const tokens = sourceData.rawTokens
    .map((token) => computePower({ token, indexes, powerConfig, powerScale: options.powerScale }))
    .sort((a, b) => a.tokenId - b.tokenId);

  const tokenIds = new Set(tokens.map((token) => token.tokenId));
  const missingTokenIds = [];
  for (let tokenId = 1; tokenId <= powerConfig.collectionCap; tokenId += 1) {
    if (!tokenIds.has(tokenId)) missingTokenIds.push(tokenId);
  }

  const issueTokenCount = tokens.filter((token) => hasTokenIssues(token) || token.issues.length > 0).length;
  const readyForFinalize =
    tokens.length === powerConfig.collectionCap &&
    missingTokenIds.length === 0 &&
    sourceData.emptyTokenURI.length === 0 &&
    sourceData.tokenURIFailures.length === 0 &&
    sourceData.metadataFailures.length === 0 &&
    issueTokenCount === 0;

  const { powerConfigHash, finalPowerTableHash, traitsCommitment } = commitmentFor({ tokens, powerConfig, powerScale: options.powerScale });
  const batches = makeBatches(tokens, options.batchSize);

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: sourceData.source,
    contract: {
      name: "TokenPowerAudit",
      note: "Audit output only. The v1 TraitRegistry stores trait rules, not per-token powers."
    },
    collectionCap: powerConfig.collectionCap,
    tokenCount: tokens.length,
    powerScale: options.powerScale,
    batchSize: options.batchSize,
    readyForFinalize,
    powerConfigHash,
    finalPowerTableHash,
    traitsCommitment,
    issues: {
      emptyTokenURI: sourceData.emptyTokenURI,
      tokenURIFailures: sourceData.tokenURIFailures,
      metadataFailures: sourceData.metadataFailures,
      missingTokenIds,
      tokenIssues: tokens
        .filter((token) => hasTokenIssues(token) || token.issues.length > 0)
        .map((token) => ({
          tokenId: token.tokenId,
          unknownTraits: token.unknownTraits,
          duplicateLayers: token.duplicateLayers,
          missingRequiredLayers: token.missingRequiredLayers,
          issues: token.issues
        }))
    },
    batches,
    tokens: tokens.map((token) => ({
      tokenId: token.tokenId,
      scaledPower: token.scaledPower,
      displayPower: token.displayPower,
      basePower: token.basePower,
      multiplierBps: token.multiplierBps,
      synergies: token.synergies.map((synergy) => synergy.id),
      traitIdsByLayer: token.traitIdsByLayer,
      issueCount: token.unknownTraits.length + token.duplicateLayers.length + token.missingRequiredLayers.length + token.issues.length,
      name: token.name,
      tokenURI: token.tokenURI
    })),
    debug: {
      files: {
        traits: toPosix(path.relative(repoRoot, traitsPath)),
        powerConfig: toPosix(path.relative(repoRoot, powerPath))
      }
    }
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [traitsConfig, powerConfig] = await Promise.all([readJson(traitsPath), readJson(powerPath)]);
  const indexes = buildIndexes(traitsConfig);
  const sourceData = options.live
    ? await loadFromLive({ indexes, powerConfig })
    : await loadFromAudit({ auditPath: options.auditPath });

  const loader = buildLoader({ sourceData, indexes, powerConfig, options });
  if (options.requireComplete && !loader.readyForFinalize) {
    throw new Error("Token-power audit is not complete. Run without --require-complete for draft output.");
  }

  if (options.write) {
    await mkdir(generatedDir, { recursive: true });
    await writeFile(loaderPath, JSON.stringify(loader, null, 2));
    await writeFile(csvPath, createCsv(loader.tokens));
    await writeFile(reportPath, createReport(loader));
  }

  console.log(`Source: ${loader.source.kind}${loader.source.path ? ` (${loader.source.path})` : ""}`);
  console.log(`Token powers generated: ${loader.tokenCount}/${loader.collectionCap}`);
  console.log(`Complete 10K audit: ${loader.readyForFinalize ? "yes" : "no"}`);
  console.log(`traitsCommitment: ${loader.traitsCommitment}`);
  console.log(`Batches: ${loader.batches.length} x up to ${loader.batchSize}`);
  console.log(`Empty tokenURI: ${loader.issues.emptyTokenURI.length}`);
  console.log(`Metadata failures: ${loader.issues.metadataFailures.length}`);
  console.log(`Missing token IDs: ${loader.issues.missingTokenIds.length}`);
  if (options.write) {
    console.log(`Loader: ${toPosix(path.relative(repoRoot, loaderPath))}`);
    console.log(`CSV: ${toPosix(path.relative(repoRoot, csvPath))}`);
    console.log(`Report: ${toPosix(path.relative(repoRoot, reportPath))}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});