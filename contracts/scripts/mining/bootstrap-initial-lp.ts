import hre from "hardhat"

const { ethers } = hre

const DEFAULT_INITIAL_SENTI = "200000"
const DEFAULT_INITIAL_ETH = "0.125"
const MIN_TICK = -887272
const MAX_TICK = 887272

function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function envFlag(name: string): boolean {
  const normalized = optionalText(process.env[name])?.toLowerCase()
  return normalized === "1" || normalized === "true" || normalized === "yes"
}

function optionalAddress(name: string, value: string | undefined): string | undefined {
  const trimmed = optionalText(value)
  if (!trimmed) return undefined
  if (!ethers.isAddress(trimmed)) throw new Error(`${name} invalid address`)
  return ethers.getAddress(trimmed)
}

function requireAddress(name: string, value: string | undefined): string {
  const address = optionalAddress(name, value)
  if (!address) throw new Error(`${name} missing/invalid`)
  return address
}

function integerFromEnv(name: string, fallback: number): number {
  const trimmed = optionalText(process.env[name])
  if (!trimmed) return fallback
  const parsed = Number(trimmed)
  if (!Number.isInteger(parsed)) throw new Error(`${name} invalid integer`)
  return parsed
}

function parseBigIntEnv(name: string, fallback: bigint): bigint {
  const trimmed = optionalText(process.env[name])
  if (!trimmed) return fallback
  return BigInt(trimmed)
}

function parseEtherEnv(name: string, fallback: string): bigint {
  return ethers.parseEther(optionalText(process.env[name]) || fallback)
}

function assertAddress(name: string, actual: string, expected: string) {
  if (ethers.getAddress(actual) !== ethers.getAddress(expected)) {
    throw new Error(`${name} mismatch: expected ${expected}, got ${actual}`)
  }
}

function bigIntToNumber(name: string, value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${name} too large for number conversion`)
  return Number(value)
}

function minUsableTick(tickSpacing: number): number {
  return Math.ceil(MIN_TICK / tickSpacing) * tickSpacing
}

function maxUsableTick(tickSpacing: number): number {
  return Math.floor(MAX_TICK / tickSpacing) * tickSpacing
}

function integerSqrt(value: bigint): bigint {
  if (value < 0n) throw new Error("square root of negative value")
  if (value < 2n) return value

  let x0 = value
  let x1 = (x0 + value / x0) >> 1n
  while (x1 < x0) {
    x0 = x1
    x1 = (x0 + value / x0) >> 1n
  }
  return x0
}

function encodeSqrtPriceX96(amount0: bigint, amount1: bigint): bigint {
  if (amount0 <= 0n || amount1 <= 0n) throw new Error("initial LP amounts must be positive")
  return integerSqrt((amount1 << 192n) / amount0)
}

async function waitForTx(label: string, txPromise: Promise<{ hash: string; wait: () => Promise<unknown> }>) {
  const tx = await txPromise
  console.log(`  ${label}: ${tx.hash}`)
  await tx.wait()
}

function logBootstrapError(error: unknown) {
  const details = error as {
    shortMessage?: string
    reason?: string
    data?: string
    errorName?: string
    errorArgs?: unknown[]
    cause?: { shortMessage?: string; reason?: string; data?: string; message?: string }
    message?: string
  }

  console.error("bootstrapInitialPosition preflight failed")
  if (details.shortMessage) console.error(`  shortMessage: ${details.shortMessage}`)
  if (details.reason) console.error(`  reason      : ${details.reason}`)
  if (details.errorName) console.error(`  errorName   : ${details.errorName}`)
  if (details.errorArgs) console.error(`  errorArgs   : ${JSON.stringify(details.errorArgs)}`)
  if (details.data) console.error(`  data        : ${details.data}`)
  if (details.cause?.shortMessage) console.error(`  cause.short : ${details.cause.shortMessage}`)
  if (details.cause?.reason) console.error(`  cause.reason: ${details.cause.reason}`)
  if (details.cause?.data) console.error(`  cause.data  : ${details.cause.data}`)
  if (details.cause?.message) console.error(`  cause.msg   : ${details.cause.message}`)
  if (details.message) console.error(`  message     : ${details.message}`)
}

async function main() {
  const [deployer] = await ethers.getSigners()
  const network = await ethers.provider.getNetwork()
  const chainId = network.chainId
  const isLocal = chainId === 31337n || chainId === 1337n

  if (chainId === 1n && !envFlag("MINING_CONFIRM_MAINNET_DEPLOY")) {
    throw new Error("Refusing mainnet bootstrap without MINING_CONFIRM_MAINNET_DEPLOY=true")
  }
  if (!isLocal && chainId !== 11155111n && chainId !== 1n && !envFlag("ALLOW_NON_SEPOLIA_SENTI_BOOTSTRAP")) {
    throw new Error("Refusing non-Sepolia bootstrap without ALLOW_NON_SEPOLIA_SENTI_BOOTSTRAP=true")
  }

  const expectedDeployer = optionalAddress(
    "TESTNET_DEPLOYER_ADDRESS or TEST_NFT_DEPLOYER_ADDRESS",
    process.env.TESTNET_DEPLOYER_ADDRESS || process.env.TEST_NFT_DEPLOYER_ADDRESS,
  )
  if (expectedDeployer) {
    assertAddress("bootstrap deployer", deployer.address, expectedDeployer)
  }

  const tokenAddress = requireAddress("NEXT_PUBLIC_SENTI_TOKEN_ADDRESS", process.env.NEXT_PUBLIC_SENTI_TOKEN_ADDRESS)
  const minerAddress = requireAddress("NEXT_PUBLIC_PATROL_MINER_ADDRESS", process.env.NEXT_PUBLIC_PATROL_MINER_ADDRESS)
  const managerAddress = requireAddress(
    "NEXT_PUBLIC_SENTI_LIQUIDITY_MANAGER_ADDRESS",
    process.env.NEXT_PUBLIC_SENTI_LIQUIDITY_MANAGER_ADDRESS,
  )

  const initialSenti = parseEtherEnv("SENTI_INITIAL_LP_SENTI", DEFAULT_INITIAL_SENTI)
  const initialEth = parseEtherEnv("SENTI_INITIAL_LP_ETH", DEFAULT_INITIAL_ETH)

  const token = await ethers.getContractAt("SENTI", tokenAddress)
  const miner = await ethers.getContractAt("PatrolMiner", minerAddress)
  const manager = await ethers.getContractAt("SentiLiquidityManager", managerAddress)
  const poolKeyResult = await manager.poolKey()
  const poolKey = {
    currency0: poolKeyResult.currency0,
    currency1: poolKeyResult.currency1,
    fee: poolKeyResult.fee,
    tickSpacing: poolKeyResult.tickSpacing,
    hooks: poolKeyResult.hooks,
  }
  const sentiIsCurrency0 = await manager.sentiIsCurrency0()
  const tickSpacing = Number(poolKey.tickSpacing)
  const amount0Desired = sentiIsCurrency0 ? initialSenti : initialEth
  const amount1Desired = sentiIsCurrency0 ? initialEth : initialSenti
  const sqrtPriceX96 = parseBigIntEnv("SENTI_INITIAL_LP_SQRT_PRICE_X96", encodeSqrtPriceX96(amount0Desired, amount1Desired))
  const tickLower = integerFromEnv("SENTI_INITIAL_LP_TICK_LOWER", minUsableTick(tickSpacing))
  const tickUpper = integerFromEnv("SENTI_INITIAL_LP_TICK_UPPER", maxUsableTick(tickSpacing))

  if (tickLower >= tickUpper) {
    throw new Error(`invalid tick range: ${tickLower} >= ${tickUpper}`)
  }

  const positionManagerAddress = await manager.positionManager()
  const permit2Address = await manager.permit2()
  const positionManager = new ethers.Contract(
    positionManagerAddress,
    [
      "function ownerOf(uint256 tokenId) view returns (address)",
      "function initializePool((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key, uint160 sqrtPriceX96) returns (int24)",
    ],
    deployer,
  )
  const permit2 = new ethers.Contract(
    permit2Address,
    [
      "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
    ],
    deployer,
  )

  assertAddress("PatrolMiner senti", await miner.senti(), tokenAddress)
  assertAddress("SentiLiquidityManager senti", await manager.senti(), tokenAddress)
  const minerAdmin = await miner.admin()
  const managerAdminSafe = await manager.adminSafe()
  const signerCanRunFullBootstrap =
    ethers.getAddress(minerAdmin) === ethers.getAddress(deployer.address)
    && ethers.getAddress(managerAdminSafe) === ethers.getAddress(deployer.address)

  const existingTrackedTokenId = await manager.trackedPositionTokenId()
  if (existingTrackedTokenId !== 0n) {
    throw new Error(`trackedPositionTokenId already set: ${existingTrackedTokenId}`)
  }

  const initialLiquidityMinted = await miner.initialLiquidityMinted()
  const managerBalanceBefore = await token.balanceOf(managerAddress)

  console.log("Bootstrapping SENTI/ETH initial LP")
  console.log(`  network         : ${network.name} (chainId ${chainId})`)
  console.log(`  deployer        : ${deployer.address}`)
  console.log(`  senti token     : ${tokenAddress}`)
  console.log(`  patrol miner    : ${minerAddress}`)
  console.log(`  miner admin     : ${minerAdmin}`)
  console.log(`  lp manager      : ${managerAddress}`)
  console.log(`  manager admin   : ${managerAdminSafe}`)
  console.log(`  position manager: ${positionManagerAddress}`)
  console.log(`  permit2         : ${permit2Address}`)
  console.log(`  senti amount    : ${ethers.formatEther(initialSenti)}`)
  console.log(`  eth amount      : ${ethers.formatEther(initialEth)}`)
  console.log(`  amount0 desired : ${amount0Desired}`)
  console.log(`  amount1 desired : ${amount1Desired}`)
  console.log(`  sqrtPriceX96    : ${sqrtPriceX96}`)
  console.log(`  tick range      : [${tickLower}, ${tickUpper}]`)

  const tokenPermit2Allowance = await token.allowance(managerAddress, permit2Address)
  const permit2Allowance = await permit2.allowance(managerAddress, tokenAddress, positionManagerAddress)
  console.log(`  token->permit2  : ${tokenPermit2Allowance}`)
  console.log(`  permit2->posm   : amount=${permit2Allowance.amount} expiration=${permit2Allowance.expiration} nonce=${permit2Allowance.nonce}`)

  if (!initialLiquidityMinted) {
    await waitForTx("PatrolMiner.mintInitialLiquidity", miner.mintInitialLiquidity(managerAddress))
    const managerBalanceAfterMint = await token.balanceOf(managerAddress)
    if (managerBalanceAfterMint - managerBalanceBefore < initialSenti) {
      throw new Error("initial liquidity mint did not credit the expected SENTI seed to the manager")
    }
  } else {
    console.log("  PatrolMiner initial LP seed already minted; reusing manager balance")
  }

  const maxDeadlineWindow = await manager.maxDeadlineWindow()
  const defaultDeadlineOffset = Math.min(300, bigIntToNumber("maxDeadlineWindow", maxDeadlineWindow))
  const deadlineOffset = integerFromEnv("SENTI_INITIAL_LP_DEADLINE_OFFSET", defaultDeadlineOffset)
  if (deadlineOffset <= 0 || BigInt(deadlineOffset) > maxDeadlineWindow) {
    throw new Error(`SENTI_INITIAL_LP_DEADLINE_OFFSET must be between 1 and ${maxDeadlineWindow}`)
  }

  const latestBlock = await ethers.provider.getBlock("latest")
  if (!latestBlock) throw new Error("latest block unavailable")
  const deadline = BigInt(latestBlock.timestamp + deadlineOffset)
  const mintInitialLiquidityData = miner.interface.encodeFunctionData("mintInitialLiquidity", [managerAddress])
  const bootstrapInitialPositionData = manager.interface.encodeFunctionData("bootstrapInitialPosition", [
    sqrtPriceX96,
    tickLower,
    tickUpper,
    amount0Desired,
    amount1Desired,
    deadline,
  ])

  if (!signerCanRunFullBootstrap) {
    console.log("")
    console.log("Safe/manual execution required for bootstrap")
    console.log(`  current signer   : ${deployer.address}`)
    if (!initialLiquidityMinted) {
      console.log("  step 1 target    : PatrolMiner")
      console.log(`  step 1 from      : ${minerAdmin}`)
      console.log(`  step 1 to        : ${minerAddress}`)
      console.log("  step 1 value     : 0")
      console.log(`  step 1 data      : ${mintInitialLiquidityData}`)
    }
    console.log("  step 2 target    : SentiLiquidityManager")
    console.log(`  step 2 from      : ${managerAdminSafe}`)
    console.log(`  step 2 to        : ${managerAddress}`)
    console.log(`  step 2 value     : ${initialEth}`)
    console.log(`  step 2 data      : ${bootstrapInitialPositionData}`)
    console.log("  note             : no transactions were sent because the current signer does not control every required admin role")
    return
  }

  try {
    const initializeTick = await positionManager.initializePool.staticCall(poolKey, sqrtPriceX96)
    console.log(`  initializePool preflight tick: ${initializeTick}`)
  } catch (error) {
    logBootstrapError(error)
    throw error
  }

  try {
    await waitForTx(
      "SentiLiquidityManager.bootstrapInitialPosition",
      manager.bootstrapInitialPosition(sqrtPriceX96, tickLower, tickUpper, amount0Desired, amount1Desired, deadline, {
        value: initialEth,
      }),
    )
  } catch (error) {
    logBootstrapError(error)
    throw error
  }

  const trackedTokenId = await manager.trackedPositionTokenId()
  const owner = await positionManager.ownerOf(trackedTokenId)
  assertAddress("tracked position owner", owner, managerAddress)

  console.log("Initial LP bootstrap complete")
  console.log(`  tracked tokenId : ${trackedTokenId}`)
  console.log(`  manager owner   : ${owner}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})