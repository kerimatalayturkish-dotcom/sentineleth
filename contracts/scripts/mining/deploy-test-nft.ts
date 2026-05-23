import fs from "node:fs"
import path from "node:path"
import hre from "hardhat"

const { ethers } = hre

const DEFAULT_TEST_NFT_DEPLOYER = "0x7F2B4248E5F47fBfbB1f4599BE1d7E1c1eF08951"
const DEFAULT_TEST_NFT_SUPPLY = 20
const OPTIONAL_LAYER_PRESENT_THRESHOLD = 179
const MAX_COMBO_RETRIES = 32
const NAME_PAD_WIDTH = 5
const IMAGE_SIZE = 1024

const REPO_ROOT = path.resolve(__dirname, "../../..")
const TRAITS_PATH = path.join(REPO_ROOT, "config", "traits.json")
const LAYERS_DIR = path.join(REPO_ROOT, "public", "layers")
const COLLECTION_DIR = path.join(REPO_ROOT, "public", "collection")
const LOGO_PATH = path.join(COLLECTION_DIR, "logo.jpg")
const BANNER_PATH = path.join(COLLECTION_DIR, "banner.jpg")

type IrysNetwork = "devnet" | "mainnet"

interface TraitOption {
  id: string
  name: string
  file: string
}

interface TraitLayer {
  id: string
  name: string
  order: number
  required: boolean
  options: TraitOption[]
}

interface TraitsConfig {
  layers: TraitLayer[]
}

type TraitSelection = Record<string, string>

const IRYS_GATEWAY: Record<IrysNetwork, string> = {
  devnet: "https://devnet.irys.xyz",
  mainnet: "https://gateway.irys.xyz",
}

const COLLECTION_META = {
  name: "SentinelETH",
  description:
    "First agentic NFT collection on Ethereum. Mint via Claude AI through MCP. " +
    "Each Sentinel is a unique on-chain agent with deterministic traits, " +
    "lives forever on Ethereum + Irys.",
  external_link: process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://sentineleth.xyz",
  twitter_username: "SentinelTempo",
}

function optionalAddress(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed && ethers.isAddress(trimmed) ? ethers.getAddress(trimmed) : null
}

function positiveInteger(name: string, value: string | undefined, fallback: number): number {
  const trimmed = value?.trim()
  if (!trimmed) return fallback
  const parsed = Number(trimmed)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
  return parsed
}

function privateKeyFromEnv(name: string, value: string | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  const normalized = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) throw new Error(`${name} is invalid`)
  return normalized
}

function loadTraitsConfig(): TraitsConfig {
  const raw = fs.readFileSync(TRAITS_PATH, "utf8")
  return JSON.parse(raw) as TraitsConfig
}

function getLayers(config: TraitsConfig): TraitLayer[] {
  return [...config.layers].sort((left, right) => left.order - right.order)
}

function getLayerFile(config: TraitsConfig, layerId: string, optionId: string): string | null {
  const layer = config.layers.find((item) => item.id === layerId)
  if (!layer) return null
  const option = layer.options.find((item) => item.id === optionId)
  return option ? option.file : null
}

function getTraitAttributes(config: TraitsConfig, selection: TraitSelection) {
  return getLayers(config)
    .filter((layer) => selection[layer.id])
    .map((layer) => {
      const option = layer.options.find((item) => item.id === selection[layer.id])
      return { trait_type: layer.name, value: option?.name ?? selection[layer.id] }
    })
}

function seedForToken(contractAddress: string, tokenId: bigint, chainId: bigint): string {
  return ethers.solidityPackedKeccak256(
    ["address", "uint256", "uint256"],
    [contractAddress, tokenId, chainId],
  )
}

function selectionFromSeed(config: TraitsConfig, seed: string, attempt = 0): TraitSelection {
  const baseSeed = attempt === 0
    ? seed
    : ethers.solidityPackedKeccak256(["bytes32", "uint32"], [seed, attempt])

  const stream = byteStream(baseSeed)
  const selection: TraitSelection = {}
  for (const layer of getLayers(config)) {
    if (!layer.required) {
      const presenceByte = stream.next()
      if (presenceByte >= OPTIONAL_LAYER_PRESENT_THRESHOLD) continue
    }
    if (layer.options.length === 0) continue
    const randomUint32 = stream.nextUint32()
    selection[layer.id] = layer.options[randomUint32 % layer.options.length].id
  }
  return selection
}

function comboHash(config: TraitsConfig, selection: TraitSelection): string {
  const parts = getLayers(config)
    .filter((layer) => selection[layer.id])
    .map((layer) => `${layer.id}:${selection[layer.id]}`)
  return ethers.keccak256(ethers.toUtf8Bytes(parts.join("|")))
}

function byteStream(seedHex: string): { next(): number; nextUint32(): number } {
  let chunk = hexToBytes(seedHex)
  let offset = 0
  let counter = 0

  function ensure(size: number) {
    if (offset + size <= chunk.length) return
    counter += 1
    chunk = hexToBytes(
      ethers.solidityPackedKeccak256(["bytes32", "uint32"], [seedHex, counter]),
    )
    offset = 0
  }

  return {
    next(): number {
      ensure(1)
      return chunk[offset++]
    },
    nextUint32(): number {
      ensure(4)
      const value =
        (chunk[offset] << 24)
        | (chunk[offset + 1] << 16)
        | (chunk[offset + 2] << 8)
        | chunk[offset + 3]
      offset += 4
      return value >>> 0
    },
  }
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith("0x") ? hex.slice(2) : hex
  const out = new Uint8Array(normalized.length / 2)
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16)
  }
  return out
}

async function composeImage(config: TraitsConfig, selection: TraitSelection): Promise<Buffer> {
  const sharp = (await import("sharp")).default
  const files: string[] = []

  for (const layer of getLayers(config)) {
    const optionId = selection[layer.id]
    if (!optionId) continue
    const file = getLayerFile(config, layer.id, optionId)
    if (!file) continue
    const absolutePath = path.join(LAYERS_DIR, file)
    await fs.promises.access(absolutePath)
    files.push(absolutePath)
  }

  if (files.length === 0) throw new Error("composeImage: no layers selected")

  const [base, ...overlays] = files
  const overlayBuffers = await Promise.all(
    overlays.map((absolutePath) =>
      sharp(absolutePath)
        .resize(IMAGE_SIZE, IMAGE_SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer(),
    ),
  )

  let image = sharp(base).resize(IMAGE_SIZE, IMAGE_SIZE)
  if (overlayBuffers.length > 0) {
    image = image.composite(overlayBuffers.map((input) => ({ input })))
  }

  return image.png().toBuffer()
}

function resolveIrysNetwork(chainId: bigint): IrysNetwork {
  const explicit = (process.env.TEST_NFT_IRYS_NETWORK || "").trim().toLowerCase()
  if (explicit === "devnet" || explicit === "mainnet") return explicit
  if (explicit) throw new Error("TEST_NFT_IRYS_NETWORK must be devnet or mainnet")
  if (chainId === 11155111n) return "devnet"

  const fallback = (process.env.IRYS_NETWORK || "mainnet").trim().toLowerCase()
  if (fallback === "devnet" || fallback === "mainnet") return fallback
  throw new Error("IRYS_NETWORK must be devnet or mainnet")
}

function resolveIrysRpcUrl(network: IrysNetwork): string {
  if (network === "devnet") {
    const url = (process.env.TEST_NFT_IRYS_RPC_URL || process.env.IRYS_DEVNET_RPC_URL || "https://devnet.irys.xyz").trim()
    if (!url) throw new Error("Missing TEST_NFT_IRYS_RPC_URL or IRYS_DEVNET_RPC_URL for Irys devnet")
    return url
  }

  const url = (process.env.TEST_NFT_IRYS_RPC_URL || process.env.IRYS_RPC_URL || "https://uploader.irys.xyz").trim()
  if (!url) throw new Error("Missing TEST_NFT_IRYS_RPC_URL or IRYS_RPC_URL for Irys mainnet")
  return url
}

function resolveIrysPrivateKey(): string {
  const key = privateKeyFromEnv(
    "TEST_NFT_IRYS_PRIVATE_KEY or IRYS_PRIVATE_KEY",
    process.env.TEST_NFT_IRYS_PRIVATE_KEY || process.env.IRYS_PRIVATE_KEY,
  )
  if (!key) throw new Error("Missing TEST_NFT_IRYS_PRIVATE_KEY or IRYS_PRIVATE_KEY")
  return key
}

async function createIrysUploader(network: IrysNetwork, rpcUrl: string, key: string): Promise<unknown> {
  const { Uploader } = await import("@irys/upload")
  const { Ethereum } = await import("@irys/upload-ethereum")

  if (network === "devnet") {
    return Uploader(Ethereum)
      .withWallet(key)
      .withRpc(rpcUrl)
      .devnet()
  }

  return Uploader(Ethereum)
    .withWallet(key)
    .withRpc(rpcUrl)
}

function gatewayUrl(network: IrysNetwork, id: string): string {
  return `${IRYS_GATEWAY[network]}/${id}`
}

async function uploadToIrys(
  uploader: unknown,
  network: IrysNetwork,
  data: Uint8Array | string,
  tags: Array<{ name: string; value: string }>,
): Promise<string> {
  const receipt = await (uploader as { upload: (payload: Uint8Array | string, opts: { tags: Array<{ name: string; value: string }> }) => Promise<{ id?: string }> }).upload(data, { tags })
  const id = String(receipt?.id ?? "")
  if (!id) throw new Error("Irys upload returned no id")
  return gatewayUrl(network, id)
}

async function logIrysBalance(uploader: unknown) {
  const irys = uploader as {
    getLoadedBalance?: () => Promise<unknown>
    utils?: { fromAtomic?: (value: unknown) => { toString(): string } }
  }
  if (!irys.getLoadedBalance) return

  const balance = await irys.getLoadedBalance()
  const human = irys.utils?.fromAtomic
    ? irys.utils.fromAtomic(balance).toString()
    : String(balance)
  console.log(`  irys balance     : ${human}`)
}

async function uploadCollectionMetadata(uploader: unknown, network: IrysNetwork): Promise<string> {
  for (const filePath of [LOGO_PATH, BANNER_PATH]) {
    if (!fs.existsSync(filePath)) throw new Error(`Missing file: ${filePath}`)
  }

  const logoBytes = fs.readFileSync(LOGO_PATH)
  const logoUrl = await uploadToIrys(uploader, network, logoBytes, [
    { name: "Content-Type", value: "image/jpeg" },
    { name: "App-Name", value: "SentinelETH" },
    { name: "Type", value: "collection-logo" },
  ])

  const bannerBytes = fs.readFileSync(BANNER_PATH)
  const bannerUrl = await uploadToIrys(uploader, network, bannerBytes, [
    { name: "Content-Type", value: "image/jpeg" },
    { name: "App-Name", value: "SentinelETH" },
    { name: "Type", value: "collection-banner" },
  ])

  const metadata = {
    ...COLLECTION_META,
    image: logoUrl,
    banner_image_url: bannerUrl,
  }

  return uploadToIrys(uploader, network, JSON.stringify(metadata), [
    { name: "Content-Type", value: "application/json" },
    { name: "App-Name", value: "SentinelETH" },
    { name: "Type", value: "collection-metadata" },
  ])
}

async function buildTokenUris(
  uploader: unknown,
  network: IrysNetwork,
  config: TraitsConfig,
  contractAddress: string,
  chainId: bigint,
  supply: number,
): Promise<string[]> {
  const usedCombos = new Set<string>()
  const tokenUris: string[] = []

  for (let index = 0; index < supply; index += 1) {
    const tokenId = BigInt(index + 1)
    const seed = seedForToken(contractAddress, tokenId, chainId)

    let selection: TraitSelection | null = null
    let chosenAttempt = 0
    let chosenHash = ""

    for (let attempt = 0; attempt < MAX_COMBO_RETRIES; attempt += 1) {
      const candidate = selectionFromSeed(config, seed, attempt)
      const hash = comboHash(config, candidate)
      if (!usedCombos.has(hash)) {
        selection = candidate
        chosenAttempt = attempt
        chosenHash = hash
        break
      }
    }

    if (!selection) {
      selection = selectionFromSeed(config, seed, MAX_COMBO_RETRIES - 1)
      chosenAttempt = MAX_COMBO_RETRIES - 1
      chosenHash = comboHash(config, selection)
      console.log(`  token ${tokenId.toString().padStart(NAME_PAD_WIDTH, "0")} collision retries exhausted, accepting duplicate`)
    }

    usedCombos.add(chosenHash)

    const imageBuffer = await composeImage(config, selection)
    const imageUrl = await uploadToIrys(uploader, network, imageBuffer, [
      { name: "Content-Type", value: "image/png" },
      { name: "App-Name", value: "SentinelETH" },
      { name: "Type", value: "image" },
    ])

    const paddedId = tokenId.toString().padStart(NAME_PAD_WIDTH, "0")
    const metadataUrl = await uploadToIrys(uploader, network, JSON.stringify({
      name: `SentinelETH #${paddedId}`,
      description:
        "SentinelETH — a 10,000-piece on-chain ERC-721A collection. Minted via Claude.ai through the SentinelETH MCP.",
      image: imageUrl,
      external_url: process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://sentineleth.xyz",
      attributes: getTraitAttributes(config, selection),
    }), [
      { name: "Content-Type", value: "application/json" },
      { name: "App-Name", value: "SentinelETH" },
      { name: "Type", value: "metadata" },
    ])

    tokenUris.push(metadataUrl)
    console.log(
      `  token ${paddedId}      : ${metadataUrl} (traits ${Object.keys(selection).length}, reroll ${chosenAttempt})`,
    )
  }

  return tokenUris
}

async function main() {
  const network = await ethers.provider.getNetwork()
  if (network.chainId !== 11155111n && process.env.ALLOW_NON_SEPOLIA_TEST_NFT_DEPLOY !== "true") {
    throw new Error(`Refusing test NFT deploy on chain ${network.chainId}; use Sepolia or set ALLOW_NON_SEPOLIA_TEST_NFT_DEPLOY=true`)
  }

  const expectedDeployer = optionalAddress(process.env.TEST_NFT_DEPLOYER_ADDRESS) || DEFAULT_TEST_NFT_DEPLOYER
  const testNftDeployerKey = privateKeyFromEnv(
    "TEST_NFT_DEPLOYER_PRIVATE_KEY or TESTNET_DEPLOYER_PRIVATE_KEY or MINING_ADMIN_PRIVATE_KEY or SERVER_PRIVATE_KEY",
    process.env.TEST_NFT_DEPLOYER_PRIVATE_KEY
      || process.env.TESTNET_DEPLOYER_PRIVATE_KEY
      || process.env.MINING_ADMIN_PRIVATE_KEY
      || process.env.SERVER_PRIVATE_KEY,
  )
  const [defaultDeployer] = await ethers.getSigners()
  const deployer = testNftDeployerKey
    ? new ethers.Wallet(testNftDeployerKey, ethers.provider)
    : defaultDeployer

  if (ethers.getAddress(deployer.address) !== expectedDeployer) {
    throw new Error(
      `Wrong test NFT deployer: got ${deployer.address}, expected ${expectedDeployer}. ` +
      "Set TEST_NFT_DEPLOYER_PRIVATE_KEY locally for that address, or update TEST_NFT_DEPLOYER_ADDRESS.",
    )
  }

  const recipient = optionalAddress(process.env.TEST_NFT_RECIPIENT) || deployer.address
  const supply = positiveInteger("TEST_NFT_SUPPLY", process.env.TEST_NFT_SUPPLY, DEFAULT_TEST_NFT_SUPPLY)
  const traitsConfig = loadTraitsConfig()
  const irysNetwork = resolveIrysNetwork(network.chainId)
  const irysRpcUrl = resolveIrysRpcUrl(irysNetwork)
  const irysPrivateKey = resolveIrysPrivateKey()

  console.log("Preparing SentinelETHTestnet")
  console.log(`  network          : ${network.name} (${network.chainId})`)
  console.log(`  deployer         : ${deployer.address}`)
  console.log(`  recipient        : ${recipient}`)
  console.log(`  supply           : ${supply}`)
  console.log(`  traits source    : ${TRAITS_PATH}`)
  console.log(`  layers dir       : ${LAYERS_DIR}`)
  console.log(`  irys network     : ${irysNetwork}`)
  console.log(`  irys rpc         : ${irysRpcUrl}`)

  const uploader = await createIrysUploader(irysNetwork, irysRpcUrl, irysPrivateKey)
  await logIrysBalance(uploader)

  const contractUri = process.env.TEST_NFT_CONTRACT_URI?.trim() || await uploadCollectionMetadata(uploader, irysNetwork)
  console.log(`  contract uri     : ${contractUri}`)

  const TestNft = await ethers.getContractFactory("SentinelETHTestnet", deployer)
  const testNft = await TestNft.deploy(supply, contractUri)
  console.log(`  deploy tx        : ${testNft.deploymentTransaction()?.hash}`)
  await testNft.waitForDeployment()
  const address = await testNft.getAddress()
  console.log(`  contract         : ${address}`)

  const tokenUris = await buildTokenUris(
    uploader,
    irysNetwork,
    traitsConfig,
    address,
    network.chainId,
    supply,
  )
  console.log(`  metadata uploaded: ${tokenUris.length} tokenURIs`)

  const mintTx = await testNft.mintBatch(recipient, tokenUris)
  console.log(`  mint tx          : ${mintTx.hash}`)
  await mintTx.wait()

  console.log(`\nDeployed test NFT: ${address}`)
  console.log(`Minted ${supply} NFTs to: ${recipient}`)
  console.log("\nUse this for Sepolia-only mining tests:")
  console.log("  NEXT_PUBLIC_NFT_SOURCE_CHAIN_ID=11155111")
  console.log("  NEXT_PUBLIC_NFT_SOURCE_CHAIN_NAME=Sepolia")
  console.log(`  NEXT_PUBLIC_NFT_SOURCE_CONTRACT_ADDRESS=${address}`)
  console.log("  NFT_SOURCE_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com")
  console.log("  NEXT_PUBLIC_NFT_SOURCE_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com")
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})