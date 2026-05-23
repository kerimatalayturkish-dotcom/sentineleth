import hre from "hardhat"
import fs from "fs"
import path from "path"

const { ethers } = hre

type TraitRegistryLoader = {
  version: number
  generatedAt: string
  reviewStatus: string
  contract: {
    name: string
    constructorArgs: [string, string, string, string, string, number, number, number, number]
  }
  hashes: {
    traitsSourceHash: string
    powerConfigHash: string
    synergyRulesHash: string
    rulesCommitment: string
  }
  counts: {
    layers: number
    traits: number
    synergies: number
  }
  layerWeights: {
    layerIds: string[]
    weightsBps: number[]
  }
  traitValueBatches: Array<{
    index: number
    count: number
    layerIds: string[]
    traitIds: string[]
    values: number[]
  }>
  synergyMultipliers: {
    synergyIds: string[]
    multipliersBps: number[]
  }
}

function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function envFlag(name: string): boolean {
  const normalized = optionalText(process.env[name])?.toLowerCase()
  return normalized === "1" || normalized === "true" || normalized === "yes"
}

function requireAddress(name: string, value: string | undefined): string {
  const trimmed = optionalText(value)
  if (!trimmed || !ethers.isAddress(trimmed)) {
    throw new Error(`${name} missing/invalid`)
  }
  return ethers.getAddress(trimmed)
}

function requireBytes32(name: string, value: string): string {
  if (!/^0x[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error(`${name} missing/invalid bytes32`)
  }
  return value
}

function requirePositiveUint(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function assertSame(name: string, actual: unknown, expected: unknown) {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${name} mismatch: expected ${expected}, got ${actual}`)
  }
}

function assertEqualLengths(name: string, ...items: Array<unknown[]>) {
  const [first, ...rest] = items
  for (const item of rest) {
    if (item.length !== first.length) {
      throw new Error(`${name} length mismatch`)
    }
  }
}

function readLoader(): TraitRegistryLoader {
  const contractsRoot = path.resolve(__dirname, "../..")
  const repoRoot = path.resolve(contractsRoot, "..")
  const loaderPath = optionalText(process.env.TRAIT_REGISTRY_LOADER)
    ? path.resolve(process.env.TRAIT_REGISTRY_LOADER as string)
    : path.join(repoRoot, "mining-sentinel/generated/trait-registry-loader.json")

  if (!fs.existsSync(loaderPath)) {
    throw new Error(`TraitRegistry loader not found: ${loaderPath}. Run pnpm mining:registry:build first.`)
  }

  const loader = JSON.parse(fs.readFileSync(loaderPath, "utf8")) as TraitRegistryLoader
  if (loader.version !== 1) throw new Error(`Unsupported loader version: ${loader.version}`)
  if (loader.contract?.name !== "TraitRegistry") throw new Error(`Unsupported contract: ${loader.contract?.name}`)

  requireBytes32("traitsSourceHash", loader.hashes.traitsSourceHash)
  requireBytes32("powerConfigHash", loader.hashes.powerConfigHash)
  requireBytes32("synergyRulesHash", loader.hashes.synergyRulesHash)
  requireBytes32("rulesCommitment", loader.hashes.rulesCommitment)
  assertSame("constructor traitsSourceHash", loader.contract.constructorArgs[1], loader.hashes.traitsSourceHash)
  assertSame("constructor powerConfigHash", loader.contract.constructorArgs[2], loader.hashes.powerConfigHash)
  assertSame("constructor synergyRulesHash", loader.contract.constructorArgs[3], loader.hashes.synergyRulesHash)
  assertSame("constructor rulesCommitment", loader.contract.constructorArgs[4], loader.hashes.rulesCommitment)

  requirePositiveUint("collectionCap", loader.contract.constructorArgs[5])
  assertSame("layer count", loader.contract.constructorArgs[6], loader.counts.layers)
  assertSame("trait count", loader.contract.constructorArgs[7], loader.counts.traits)
  assertSame("synergy count", loader.contract.constructorArgs[8], loader.counts.synergies)
  assertEqualLengths("layerWeights", loader.layerWeights.layerIds, loader.layerWeights.weightsBps)
  assertEqualLengths("synergyMultipliers", loader.synergyMultipliers.synergyIds, loader.synergyMultipliers.multipliersBps)

  for (const batch of loader.traitValueBatches) {
    assertEqualLengths(`traitValueBatches[${batch.index}]`, batch.layerIds, batch.traitIds, batch.values)
    if (batch.count !== batch.layerIds.length) {
      throw new Error(`traitValueBatches[${batch.index}] count mismatch`)
    }
  }

  return loader
}

async function waitForTx(label: string, txPromise: Promise<{ hash: string; wait: () => Promise<unknown> }>) {
  const tx = await txPromise
  console.log(`  ${label}: ${tx.hash}`)
  await tx.wait()
}

async function deployRegistry(
  traitRegistryFactory: Awaited<ReturnType<typeof ethers.getContractFactory>>,
  admin: string,
  loader: TraitRegistryLoader,
) {
  const deployRequest = await traitRegistryFactory.getDeployTransaction(
    admin,
    loader.hashes.traitsSourceHash,
    loader.hashes.powerConfigHash,
    loader.hashes.synergyRulesHash,
    loader.hashes.rulesCommitment,
    loader.contract.constructorArgs[5],
    loader.counts.layers,
    loader.counts.traits,
    loader.counts.synergies,
  )

  if (!deployRequest.data) {
    throw new Error("Unable to build TraitRegistry deployment bytecode")
  }

  const tx = await traitRegistryFactory.runner!.sendTransaction(deployRequest)
  console.log(`  deploy tx        : ${tx.hash}`)
  const receipt = await tx.wait()
  const address = receipt?.contractAddress
  if (!address || !ethers.isAddress(address)) {
    throw new Error("TraitRegistry deployment receipt missing contractAddress")
  }

  return {
    address: ethers.getAddress(address),
    registry: traitRegistryFactory.attach(address),
  }
}

async function main() {
  const loader = readLoader()
  const [deployer] = await ethers.getSigners()
  const network = await ethers.provider.getNetwork()
  const isLocal = network.chainId === 31337n || network.chainId === 1337n

  if (loader.reviewStatus !== "approved" && !isLocal && !envFlag("TRAIT_REGISTRY_ALLOW_DRAFT")) {
    throw new Error(
      `Loader reviewStatus is ${loader.reviewStatus}. Set TRAIT_REGISTRY_ALLOW_DRAFT=true for testnet drafts, or approve/regenerate before mainnet.`
    )
  }

  const admin = optionalText(process.env.TRAIT_REGISTRY_ADMIN_ADDRESS)
    ? requireAddress("TRAIT_REGISTRY_ADMIN_ADDRESS", process.env.TRAIT_REGISTRY_ADMIN_ADDRESS)
    : deployer.address
  if (admin.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(
      "This script loads and finalizes the registry, so TRAIT_REGISTRY_ADMIN_ADDRESS must be the deployer. To use a Safe as admin, execute the generated loader calls through the Safe instead."
    )
  }

  console.log("Deploying TraitRegistry")
  console.log(`  network          : ${network.name} (chainId ${network.chainId})`)
  console.log(`  deployer         : ${deployer.address}`)
  console.log(`  admin            : ${admin}`)
  console.log(`  reviewStatus     : ${loader.reviewStatus}`)
  console.log(`  rulesCommitment  : ${loader.hashes.rulesCommitment}`)
  console.log(`  counts           : ${loader.counts.layers} layers, ${loader.counts.traits} traits, ${loader.counts.synergies} synergies`)

  const TraitRegistry = await ethers.getContractFactory("TraitRegistry")
  const resumeAddress = optionalText(process.env.TRAIT_REGISTRY_RESUME_ADDRESS)
  const { address, registry } = resumeAddress
    ? {
        address: requireAddress("TRAIT_REGISTRY_RESUME_ADDRESS", resumeAddress),
        registry: TraitRegistry.attach(requireAddress("TRAIT_REGISTRY_RESUME_ADDRESS", resumeAddress)),
      }
    : await deployRegistry(TraitRegistry, admin, loader)

  if (resumeAddress) {
    console.log(`  resume registry  : ${address}`)
  } else {
    console.log(`  deployed         : ${address}`)
  }

  assertSame("admin", await registry.admin(), admin)
  assertSame("traitsSourceHash", await registry.traitsSourceHash(), loader.hashes.traitsSourceHash)
  assertSame("powerConfigHash", await registry.powerConfigHash(), loader.hashes.powerConfigHash)
  assertSame("synergyRulesHash", await registry.synergyRulesHash(), loader.hashes.synergyRulesHash)
  assertSame("rulesCommitment", await registry.rulesCommitment(), loader.hashes.rulesCommitment)

  if (await registry.finalized()) {
    console.log("TraitRegistry already finalized")
    console.log("")
    console.log("Add to env:")
    console.log(`NEXT_PUBLIC_TRAIT_REGISTRY_ADDRESS=${address}`)
    return
  }

  await waitForTx("setLayerWeights", registry.setLayerWeights(loader.layerWeights.layerIds, loader.layerWeights.weightsBps))
  for (const batch of loader.traitValueBatches) {
    await waitForTx(`setTraitValues[${batch.index}]`, registry.setTraitValues(batch.layerIds, batch.traitIds, batch.values))
  }
  await waitForTx("setSynergyMultipliers", registry.setSynergyMultipliers(loader.synergyMultipliers.synergyIds, loader.synergyMultipliers.multipliersBps))

  assertSame("configuredLayerCount", await registry.configuredLayerCount(), loader.counts.layers)
  assertSame("configuredTraitCount", await registry.configuredTraitCount(), loader.counts.traits)
  assertSame("configuredSynergyCount", await registry.configuredSynergyCount(), loader.counts.synergies)

  await waitForTx("finalize", registry.finalize())
  assertSame("finalized", await registry.finalized(), true)

  console.log("TraitRegistry finalized")
  console.log("")
  console.log("Add to env:")
  console.log(`NEXT_PUBLIC_TRAIT_REGISTRY_ADDRESS=${address}`)
  console.log("")
  console.log("Verify with:")
  console.log(
    `npx hardhat verify --network ${network.name === "unknown" ? "<network>" : network.name} ${address} ${admin} ${loader.hashes.traitsSourceHash} ${loader.hashes.powerConfigHash} ${loader.hashes.synergyRulesHash} ${loader.hashes.rulesCommitment} ${loader.contract.constructorArgs[5]} ${loader.counts.layers} ${loader.counts.traits} ${loader.counts.synergies}`
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})