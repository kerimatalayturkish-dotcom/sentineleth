import { readFileSync } from "node:fs"
import path from "node:path"
import { ethers } from "hardhat"
import type { BaseContract, ContractFactory, Signer } from "ethers"

type FoundryArtifact = {
  abi: readonly unknown[]
  bytecode?: {
    object: string
  }
}

type AnyContract = BaseContract & Record<string, any>

const CONTRACTS_ROOT = path.resolve(__dirname, "..", "..")
const V4_CORE_OUT = "node_modules/@uniswap/v4-core/out"
const V4_PERIPHERY_OUT = "node_modules/@uniswap/v4-periphery/foundry-out"
const PERMIT2_DEPLOYER_SOURCE = "node_modules/@uniswap/v4-periphery/lib/permit2/test/utils/DeployPermit2.sol"
const PERMIT2_ALLOWANCE_ARTIFACT = `${V4_PERIPHERY_OUT}/IAllowanceTransfer.sol/IAllowanceTransfer.default.json`
const MASK_128 = (1n << 128n) - 1n
const MASK_256 = (1n << 256n) - 1n
const HOOK_FLAGS = (1n << 7n) | (1n << 6n) | (1n << 3n) | (1n << 2n)
const HOOK_MASK = (1n << 14n) - 1n

export const DEFAULT_POOL_FEE = 3000
export const DEFAULT_TICK_SPACING = 60
export const SQRT_PRICE_1_1 = 79228162514264337593543950336n
export const MIN_PRICE_LIMIT = 4295128740n
export const MAX_PRICE_LIMIT = 1461446703485210103287273052203988822378723970341n
export const DEFAULT_LIQUIDITY_PARAMS = {
  tickLower: -120,
  tickUpper: 120,
  liquidityDelta: 10n ** 18n,
  salt: ethers.ZeroHash,
}
export const DEFAULT_SWAP_SETTINGS = {
  takeClaims: false,
  settleUsingBurn: false,
}

function readFoundryArtifact(relativePath: string): FoundryArtifact {
  const artifactPath = path.join(CONTRACTS_ROOT, relativePath)
  return JSON.parse(readFileSync(artifactPath, "utf8")) as FoundryArtifact
}

function artifactBytecode(artifact: FoundryArtifact): string {
  const object = artifact.bytecode?.object
  if (!object) throw new Error("Missing bytecode in Foundry artifact")
  return object.startsWith("0x") ? object : `0x${object}`
}

function encodePush(value: number): string {
  const hex = value.toString(16).padStart(value.toString(16).length + (value.toString(16).length % 2), "0")
  const size = hex.length / 2

  if (size === 0 || size > 32) throw new Error("Unsupported PUSH width")

  return (0x5f + size).toString(16) + hex
}

function buildInitCode(runtimeBytecode: string): string {
  const runtime = runtimeBytecode.startsWith("0x") ? runtimeBytecode.slice(2) : runtimeBytecode
  const runtimeLength = runtime.length / 2

  let runtimeOffset = 0
  while (true) {
    const sizePush = encodePush(runtimeLength)
    const offsetPush = encodePush(runtimeOffset)
    const prefix = `${sizePush}${offsetPush}5f39${sizePush}5ff3`
    const nextOffset = prefix.length / 2

    if (nextOffset === runtimeOffset) {
      return `0x${prefix}${runtime}`
    }

    runtimeOffset = nextOffset
  }
}

function readPermit2RuntimeBytecode(): string {
  const sourcePath = path.join(CONTRACTS_ROOT, PERMIT2_DEPLOYER_SOURCE)
  const source = readFileSync(sourcePath, "utf8")
  const match = source.match(/bytes memory bytecode\s*=\s*hex"([0-9a-fA-F]+)";/s)

  if (!match) throw new Error("Unable to extract Permit2 bytecode from DeployPermit2.sol")

  return `0x${match[1]}`
}

export function getFoundryFactory(relativePath: string, signer: Signer): ContractFactory {
  const artifact = readFoundryArtifact(relativePath)
  return new ethers.ContractFactory(artifact.abi as any[], artifactBytecode(artifact), signer)
}

async function deployFoundryContract(relativePath: string, signer: Signer, args: unknown[] = []): Promise<AnyContract> {
  const factory = getFoundryFactory(relativePath, signer)
  const contract = await factory.deploy(...args)
  await contract.waitForDeployment()
  return contract as AnyContract
}

async function deployPermit2Contract(signer: Signer): Promise<AnyContract> {
  const artifact = readFoundryArtifact(PERMIT2_ALLOWANCE_ARTIFACT)
  const factory = new ethers.ContractFactory(
    artifact.abi as any[],
    buildInitCode(readPermit2RuntimeBytecode()),
    signer,
  )
  const contract = await factory.deploy()
  await contract.waitForDeployment()
  return contract as AnyContract
}

function decodeSigned128(value: bigint): bigint {
  return value >= (1n << 127n) ? value - (1n << 128n) : value
}

function normalizePackedInt256(value: bigint): bigint {
  return value < 0 ? value + (MASK_256 + 1n) : value
}

export function decodePackedBalanceDelta(delta: bigint) {
  const normalized = normalizePackedInt256(delta)
  return {
    amount0: decodeSigned128((normalized >> 128n) & MASK_128),
    amount1: decodeSigned128(normalized & MASK_128),
  }
}

export function decodePackedBeforeSwapDelta(delta: bigint) {
  const normalized = normalizePackedInt256(delta)
  return {
    specified: decodeSigned128((normalized >> 128n) & MASK_128),
    unspecified: decodeSigned128(normalized & MASK_128),
  }
}

export async function deployCoreV4(signer: Signer) {
  const owner = await signer.getAddress()
  const poolManager = await deployFoundryContract(`${V4_CORE_OUT}/PoolManager.sol/PoolManager.json`, signer, [owner])
  const swapRouter = await deployFoundryContract(
    `${V4_CORE_OUT}/PoolSwapTest.sol/PoolSwapTest.json`,
    signer,
    [await poolManager.getAddress()],
  )
  const modifyLiquidityRouter = await deployFoundryContract(
    `${V4_CORE_OUT}/PoolModifyLiquidityTest.sol/PoolModifyLiquidityTest.json`,
    signer,
    [await poolManager.getAddress()],
  )

  return { poolManager, swapRouter, modifyLiquidityRouter }
}

export async function deployPositionManagerFixture(signer: Signer, poolManagerAddress: string) {
  const permit2 = await deployPermit2Contract(signer)
  const permit2Address = await permit2.getAddress()

  const weth = await deployFoundryContract(`${V4_PERIPHERY_OUT}/WETH.sol/WETH.default.json`, signer)
  const positionDescriptor = await deployFoundryContract(
    `${V4_PERIPHERY_OUT}/PositionDescriptor.sol/PositionDescriptor.json`,
    signer,
    [poolManagerAddress, await weth.getAddress(), ethers.encodeBytes32String("ETH")],
  )
  const positionManager = await deployFoundryContract(
    `${V4_PERIPHERY_OUT}/PositionManager.sol/PositionManager.json`,
    signer,
    [poolManagerAddress, permit2Address, 100_000, await positionDescriptor.getAddress(), await weth.getAddress()],
  )

  return { permit2, permit2Address, weth, positionDescriptor, positionManager }
}

export function makeCanonicalNativePoolKey(tokenAddress: string, hookAddress: string) {
  return {
    currency0: ethers.ZeroAddress,
    currency1: tokenAddress,
    fee: DEFAULT_POOL_FEE,
    tickSpacing: DEFAULT_TICK_SPACING,
    hooks: hookAddress,
  }
}

export async function mineAndDeploySentiHook(options: {
  deployerSigner: Signer
  create2DeployerAddress: string
  poolManagerAddress: string
  sentiTokenAddress: string
  feeRecipientAddress: string
  poolFee?: number
  tickSpacing?: number
}) {
  const SentiHook = await ethers.getContractFactory("SentiHook", options.deployerSigner)
  const deployTx = await SentiHook.getDeployTransaction(
    options.poolManagerAddress,
    options.sentiTokenAddress,
    options.feeRecipientAddress,
    options.poolFee ?? DEFAULT_POOL_FEE,
    options.tickSpacing ?? DEFAULT_TICK_SPACING,
  )

  if (!deployTx.data) throw new Error("Unable to build SentiHook init code")

  const initCode = deployTx.data
  const initCodeHash = ethers.keccak256(initCode)
  const create2Deployer = await ethers.getContractAt(
    "MockCreate2Deployer",
    options.create2DeployerAddress,
    options.deployerSigner,
  )

  for (let salt = 0; salt < 160_444; salt += 1) {
    const paddedSalt = ethers.zeroPadValue(ethers.toBeHex(salt), 32)
    const hookAddress = ethers.getCreate2Address(options.create2DeployerAddress, paddedSalt, initCodeHash)
    if ((BigInt(hookAddress) & HOOK_MASK) !== HOOK_FLAGS) continue

    await create2Deployer.deploy(paddedSalt, initCode)
    return ethers.getContractAt("SentiHook", hookAddress, options.deployerSigner)
  }

  throw new Error("Unable to mine hook address for test")
}