import hre from "hardhat"

import { assertSentiHookBindings, predictCoreDeploymentAddresses } from "./hook-binding-utils"

const { ethers } = hre

const DEFAULT_UNISWAP_PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3"

function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function envFlag(name: string): boolean {
  const normalized = optionalText(process.env[name])?.toLowerCase()
  return normalized === "1" || normalized === "true" || normalized === "yes"
}

function integerFromEnv(name: string, fallback: number): number {
  const trimmed = optionalText(process.env[name])
  if (!trimmed) return fallback
  const parsed = Number(trimmed)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} invalid integer`)
  }
  return parsed
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

function assertSame(name: string, actual: unknown, expected: unknown) {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${name} mismatch: expected ${expected}, got ${actual}`)
  }
}

function assertAddress(name: string, actual: string, expected: string) {
  if (ethers.getAddress(actual) !== ethers.getAddress(expected)) {
    throw new Error(`${name} mismatch: expected ${expected}, got ${actual}`)
  }
}

function optionalExpectedDeployer(): string | undefined {
  return optionalAddress(
    "TESTNET_DEPLOYER_ADDRESS or TEST_NFT_DEPLOYER_ADDRESS",
    process.env.TESTNET_DEPLOYER_ADDRESS || process.env.TEST_NFT_DEPLOYER_ADDRESS,
  )
}

function sameAddress(left: string, right: string) {
  return ethers.getAddress(left) === ethers.getAddress(right)
}

function deriveCoreDeploymentAddresses(input: {
  deployerAddress: string
  currentNonce: number
  resumeTokenAddress?: string
  resumeManagerAddress?: string
  resumeMinerAddress?: string
}) {
  const predictedFromCurrentNonce = predictCoreDeploymentAddresses(input.deployerAddress, input.currentNonce)

  if (!input.resumeTokenAddress) {
    if (input.resumeManagerAddress || input.resumeMinerAddress) {
      throw new Error("MINING_CORE_RESUME_MANAGER_ADDRESS and MINING_CORE_RESUME_MINER_ADDRESS require MINING_CORE_RESUME_TOKEN_ADDRESS")
    }
    return predictedFromCurrentNonce
  }

  if (!input.resumeManagerAddress) {
    return {
      tokenAddress: input.resumeTokenAddress,
      managerAddress: predictedFromCurrentNonce.tokenAddress,
      minerAddress: predictedFromCurrentNonce.managerAddress,
    }
  }

  if (!input.resumeMinerAddress) {
    return {
      tokenAddress: input.resumeTokenAddress,
      managerAddress: input.resumeManagerAddress,
      minerAddress: predictedFromCurrentNonce.tokenAddress,
    }
  }

  return {
    tokenAddress: input.resumeTokenAddress,
    managerAddress: input.resumeManagerAddress,
    minerAddress: input.resumeMinerAddress,
  }
}

async function waitForTx(label: string, txPromise: Promise<{ hash: string; wait: () => Promise<unknown> }>) {
  const tx = await txPromise
  console.log(`  ${label}: ${tx.hash}`)
  await tx.wait()
}

async function deployFromFactory(
  contractLabel: string,
  factory: Awaited<ReturnType<typeof ethers.getContractFactory>>,
  args: unknown[],
) {
  const deployRequest = await factory.getDeployTransaction(...args)
  if (!deployRequest.data) {
    throw new Error(`Unable to build ${contractLabel} deployment bytecode`)
  }

  const tx = await factory.runner!.sendTransaction(deployRequest)
  console.log(`  ${contractLabel} deploy tx: ${tx.hash}`)
  const receipt = await tx.wait()
  const address = receipt?.contractAddress
  if (!address || !ethers.isAddress(address)) {
    throw new Error(`${contractLabel} deployment receipt missing contractAddress`)
  }

  return factory.attach(address)
}

async function validateTraitRegistry(address: string) {
  const registry = await ethers.getContractAt("TraitRegistry", address)
  assertSame("trait registry finalized", await registry.finalized(), true)
  const rulesCommitment = await registry.rulesCommitment()
  console.log(`  trait registry  : ${address}`)
  console.log(`  rulesCommitment : ${rulesCommitment}`)
}

async function main() {
  const [deployer] = await ethers.getSigners()
  const network = await ethers.provider.getNetwork()
  const chainId = network.chainId
  const isLocal = chainId === 31337n || chainId === 1337n

  if (chainId === 1n && !envFlag("MINING_CONFIRM_MAINNET_DEPLOY")) {
    throw new Error("Refusing mainnet deploy without MINING_CONFIRM_MAINNET_DEPLOY=true")
  }

  const currentBlock = BigInt(await ethers.provider.getBlockNumber())
  const currentNonce = await ethers.provider.getTransactionCount(deployer.address, "pending")
  const expectedDeployer = optionalExpectedDeployer()
  if (!isLocal && expectedDeployer) {
    assertAddress("mining core deployer", deployer.address, expectedDeployer)
  }
  const admin = isLocal
    ? optionalAddress("MINING_ADMIN_SAFE_ADDRESS", process.env.MINING_ADMIN_SAFE_ADDRESS || process.env.NEXT_PUBLIC_MINING_ADMIN_SAFE_ADDRESS) ?? deployer.address
    : requireAddress(
      "MINING_ADMIN_SAFE_ADDRESS or NEXT_PUBLIC_MINING_ADMIN_SAFE_ADDRESS",
      process.env.MINING_ADMIN_SAFE_ADDRESS || process.env.NEXT_PUBLIC_MINING_ADMIN_SAFE_ADDRESS,
    )
  const opsSafe = isLocal
    ? optionalAddress("MINING_OPS_SAFE_ADDRESS", process.env.MINING_OPS_SAFE_ADDRESS || process.env.NEXT_PUBLIC_MINING_OPS_SAFE_ADDRESS) ?? admin
    : requireAddress(
      "MINING_OPS_SAFE_ADDRESS or NEXT_PUBLIC_MINING_OPS_SAFE_ADDRESS",
      process.env.MINING_OPS_SAFE_ADDRESS || process.env.NEXT_PUBLIC_MINING_OPS_SAFE_ADDRESS,
    )
  const backendSigner = isLocal
    ? optionalAddress("MINING_BACKEND_SIGNER_ADDRESS", process.env.MINING_BACKEND_SIGNER_ADDRESS || process.env.NEXT_PUBLIC_MINING_BACKEND_SIGNER_ADDRESS) ?? deployer.address
    : requireAddress(
      "MINING_BACKEND_SIGNER_ADDRESS or NEXT_PUBLIC_MINING_BACKEND_SIGNER_ADDRESS",
      process.env.MINING_BACKEND_SIGNER_ADDRESS || process.env.NEXT_PUBLIC_MINING_BACKEND_SIGNER_ADDRESS,
    )
  const poolManagerAddress = isLocal
    ? optionalAddress("NEXT_PUBLIC_UNISWAP_V4_POOL_MANAGER_ADDRESS", process.env.NEXT_PUBLIC_UNISWAP_V4_POOL_MANAGER_ADDRESS)
    : requireAddress(
      "NEXT_PUBLIC_UNISWAP_V4_POOL_MANAGER_ADDRESS",
      process.env.NEXT_PUBLIC_UNISWAP_V4_POOL_MANAGER_ADDRESS,
    )
  const sentiHook = isLocal
    ? optionalAddress("NEXT_PUBLIC_SENTI_HOOK_ADDRESS", process.env.NEXT_PUBLIC_SENTI_HOOK_ADDRESS) ?? ethers.ZeroAddress
    : requireAddress("NEXT_PUBLIC_SENTI_HOOK_ADDRESS", process.env.NEXT_PUBLIC_SENTI_HOOK_ADDRESS)
  let positionManagerAddress = isLocal
    ? optionalAddress("NEXT_PUBLIC_UNISWAP_V4_POSITION_MANAGER_ADDRESS", process.env.NEXT_PUBLIC_UNISWAP_V4_POSITION_MANAGER_ADDRESS)
    : requireAddress(
      "NEXT_PUBLIC_UNISWAP_V4_POSITION_MANAGER_ADDRESS",
      process.env.NEXT_PUBLIC_UNISWAP_V4_POSITION_MANAGER_ADDRESS,
    )
  let permit2Address = optionalAddress(
    "UNISWAP_PERMIT2_ADDRESS or NEXT_PUBLIC_UNISWAP_PERMIT2_ADDRESS",
    process.env.UNISWAP_PERMIT2_ADDRESS || process.env.NEXT_PUBLIC_UNISWAP_PERMIT2_ADDRESS,
  )
  const poolFee = integerFromEnv("SENTI_V4_POOL_FEE", 3000)
  const poolTickSpacing = integerFromEnv("SENTI_V4_POOL_TICK_SPACING", 60)
  const sentiIsCurrency0 = envFlag("SENTI_V4_POOL_SENTI_IS_CURRENCY0")
  const compoundMinEthToCompound = ethers.parseEther(optionalText(process.env.SENTI_COMPOUND_MIN_ETH) || "0.5")
  const compoundCooldown = integerFromEnv("SENTI_COMPOUND_COOLDOWN", 3600)
  const compoundMaxEthPerCompound = ethers.parseEther(optionalText(process.env.SENTI_COMPOUND_MAX_ETH) || "2")
  const compoundMaxSentiPerCompound = ethers.parseEther(optionalText(process.env.SENTI_COMPOUND_MAX_SENTI) || "1000")
  const compoundMaxDeadlineWindow = integerFromEnv("SENTI_COMPOUND_MAX_DEADLINE_WINDOW", 600)
  const traitRegistry = optionalAddress(
    "NEXT_PUBLIC_TRAIT_REGISTRY_ADDRESS",
    process.env.MINING_TRAIT_REGISTRY_ADDRESS || process.env.NEXT_PUBLIC_TRAIT_REGISTRY_ADDRESS,
  )
  const resumeTokenAddress = optionalAddress("MINING_CORE_RESUME_TOKEN_ADDRESS", process.env.MINING_CORE_RESUME_TOKEN_ADDRESS)
  const resumeManagerAddress = optionalAddress("MINING_CORE_RESUME_MANAGER_ADDRESS", process.env.MINING_CORE_RESUME_MANAGER_ADDRESS)
  const resumeMinerAddress = optionalAddress("MINING_CORE_RESUME_MINER_ADDRESS", process.env.MINING_CORE_RESUME_MINER_ADDRESS)

  console.log("Deploying mining core")
  console.log(`  network         : ${network.name} (chainId ${chainId})`)
  console.log(`  deployer        : ${deployer.address}`)
  console.log(`  admin           : ${admin}`)
  console.log(`  ops safe        : ${opsSafe}`)
  console.log(`  backend signer  : ${backendSigner}`)
  console.log(`  pool manager    : ${poolManagerAddress}`)
  console.log(`  senti hook      : ${sentiHook}`)
  console.log(`  position mgr    : ${positionManagerAddress}`)
  console.log(`  permit2         : ${permit2Address}`)
  console.log(`  current nonce   : ${currentNonce}`)
  console.log(`  current block   : ${currentBlock}`)

  if (!isLocal && !traitRegistry) {
    throw new Error("NEXT_PUBLIC_TRAIT_REGISTRY_ADDRESS is required before non-local PatrolMiner deployment")
  }
  if (traitRegistry && (!isLocal || envFlag("MINING_CHECK_TRAIT_REGISTRY"))) {
    await validateTraitRegistry(traitRegistry)
  } else {
    console.log("  trait registry  : (not checked on local deploy)")
  }

  const expectedCoreAddresses = !isLocal
    ? deriveCoreDeploymentAddresses({
      deployerAddress: deployer.address,
      currentNonce,
      resumeTokenAddress,
      resumeManagerAddress,
      resumeMinerAddress,
    })
    : undefined
  if (expectedCoreAddresses) {
    console.log(`  expected SENTI  : ${expectedCoreAddresses.tokenAddress}`)
    console.log(`  expected manager: ${expectedCoreAddresses.managerAddress}`)
    console.log(`  expected miner  : ${expectedCoreAddresses.minerAddress}`)
    await assertSentiHookBindings(deployer, {
      hookAddress: sentiHook,
      poolManagerAddress: poolManagerAddress!,
      sentiTokenAddress: expectedCoreAddresses.tokenAddress,
      feeRecipientAddress: expectedCoreAddresses.managerAddress,
      poolFee,
      tickSpacing: poolTickSpacing,
    })
    console.log("  hook binding    : matches expected core deployment sequence")
  }

  let token = resumeTokenAddress
    ? await ethers.getContractAt("SENTI", resumeTokenAddress)
    : null
  if (token) {
    console.log(`  resume SENTI    : ${resumeTokenAddress}`)
  } else {
    const SENTI = await ethers.getContractFactory("SENTI")
    token = await deployFromFactory("SENTI", SENTI, [deployer.address])
  }
  const tokenAddress = await token.getAddress()
  console.log(`  SENTI           : ${tokenAddress}`)

  if (isLocal && !permit2Address) {
    const MockPermit2 = await ethers.getContractFactory("MockPermit2")
    const mockPermit2 = await MockPermit2.deploy()
    console.log(`  mock permit2 tx : ${mockPermit2.deploymentTransaction()?.hash}`)
    await mockPermit2.waitForDeployment()
    permit2Address = await mockPermit2.getAddress()
    console.log(`  MockPermit2     : ${permit2Address}`)
  }

  if (isLocal && !positionManagerAddress) {
    const MockPositionManager = await ethers.getContractFactory("MockPositionManager")
    const mockPositionManager = await MockPositionManager.deploy()
    console.log(`  mock pos mgr tx : ${mockPositionManager.deploymentTransaction()?.hash}`)
    await mockPositionManager.waitForDeployment()
    positionManagerAddress = await mockPositionManager.getAddress()
    console.log(`  MockPositionManager: ${positionManagerAddress}`)
  }

  const resolvedPermit2Address = permit2Address ?? DEFAULT_UNISWAP_PERMIT2_ADDRESS
  if (!positionManagerAddress) {
    throw new Error("NEXT_PUBLIC_UNISWAP_V4_POSITION_MANAGER_ADDRESS missing/invalid")
  }

  const poolKey = sentiIsCurrency0
    ? {
        currency0: tokenAddress,
        currency1: ethers.ZeroAddress,
        fee: poolFee,
        tickSpacing: poolTickSpacing,
        hooks: sentiHook,
      }
    : {
        currency0: ethers.ZeroAddress,
        currency1: tokenAddress,
        fee: poolFee,
        tickSpacing: poolTickSpacing,
        hooks: sentiHook,
      }

  let manager = resumeManagerAddress
    ? await ethers.getContractAt("SentiLiquidityManager", resumeManagerAddress)
    : null
  if (manager) {
    console.log(`  resume manager  : ${resumeManagerAddress}`)
  } else {
    const SentiLiquidityManager = await ethers.getContractFactory("SentiLiquidityManager")
    manager = await deployFromFactory("manager", SentiLiquidityManager, [
      admin,
      opsSafe,
      tokenAddress,
      positionManagerAddress,
      resolvedPermit2Address,
      poolKey,
      {
        minEthToCompound: compoundMinEthToCompound,
        compoundCooldown,
        maxEthPerCompound: compoundMaxEthPerCompound,
        maxSentiPerCompound: compoundMaxSentiPerCompound,
        maxDeadlineWindow: compoundMaxDeadlineWindow,
      },
    ])
  }
  const managerAddress = await manager.getAddress()
  console.log(`  SentiLiquidityManager: ${managerAddress}`)

  if (expectedCoreAddresses) {
    assertAddress("expected SENTI address", tokenAddress, expectedCoreAddresses.tokenAddress)
    assertAddress("expected manager address", managerAddress, expectedCoreAddresses.managerAddress)
    await assertSentiHookBindings(deployer, {
      hookAddress: sentiHook,
      poolManagerAddress: poolManagerAddress!,
      sentiTokenAddress: tokenAddress,
      feeRecipientAddress: managerAddress,
      poolFee,
      tickSpacing: poolTickSpacing,
    })
  }

  let miner = resumeMinerAddress
    ? await ethers.getContractAt("PatrolMiner", resumeMinerAddress)
    : null
  if (miner) {
    console.log(`  resume miner    : ${resumeMinerAddress}`)
  } else {
    const PatrolMiner = await ethers.getContractFactory("PatrolMiner")
    miner = await deployFromFactory("miner", PatrolMiner, [tokenAddress, admin, backendSigner])
  }
  const minerAddress = await miner.getAddress()
  console.log(`  PatrolMiner     : ${minerAddress}`)

  if (expectedCoreAddresses) {
    assertAddress("expected PatrolMiner address", minerAddress, expectedCoreAddresses.minerAddress)
  }

  assertAddress("PatrolMiner senti", await miner.senti(), tokenAddress)
  assertAddress("PatrolMiner admin", await miner.admin(), admin)
  const contractSigner = await miner.getFunction("signer")()
  assertAddress("PatrolMiner signer", contractSigner, backendSigner)
  assertSame("PatrolMiner miningStartBlock", await miner.miningStartBlock(), 0n)
  assertSame("PatrolMiner rewardedRounds", await miner.rewardedRounds(), 0n)
  assertAddress("SENTI initial minter", await token.minter(), deployer.address)
  assertSame("SENTI minterLocked before handoff", await token.minterLocked(), false)

  const phaseOneSupply = await miner.PHASE_ONE_SUPPLY()
  const initialLiquiditySupply = await miner.INITIAL_LIQUIDITY_SUPPLY()
  const mineableSupply = await miner.MINEABLE_SUPPLY()
  const liquidityManagerReserveSupply = await miner.LIQUIDITY_MANAGER_RESERVE_SUPPLY()
  const maxAiAgentReservedSupply = await miner.MAX_AI_AGENT_RESERVED_SUPPLY()
  const aiAgentReservedSupply = await miner.aiAgentReservedSupply()
  const maxSupply = await token.MAX_SUPPLY()
  assertSame("PatrolMiner mineable allocation", mineableSupply, phaseOneSupply - initialLiquiditySupply)
  assertSame("PatrolMiner aiAgentReservedSupply", aiAgentReservedSupply, maxAiAgentReservedSupply)
  assertSame(
    "SENTI allocation total",
    mineableSupply + initialLiquiditySupply + liquidityManagerReserveSupply + maxAiAgentReservedSupply,
    maxSupply,
  )

  const managerReserveBalance = await token.balanceOf(managerAddress)
  if (managerReserveBalance === 0n) {
    await waitForTx("SENTI.mint(liquidity manager reserve)", token.mint(managerAddress, liquidityManagerReserveSupply))
  } else {
    console.log(`  manager reserve : already present (${managerReserveBalance})`)
  }
  assertSame("SENTI manager reserve balance", await token.balanceOf(managerAddress), liquidityManagerReserveSupply)

  const currentMinter = await token.minter()
  const currentMinterLocked = await token.minterLocked()
  if (sameAddress(currentMinter, deployer.address) && !currentMinterLocked) {
    await waitForTx("SENTI.transferMinter", token.transferMinter(minerAddress))
  } else {
    console.log(`  SENTI minter    : already set to ${currentMinter} (locked=${currentMinterLocked})`)
  }
  assertAddress("SENTI locked minter", await token.minter(), minerAddress)
  assertSame("SENTI minterLocked", await token.minterLocked(), true)

  console.log("Mining core deployed and minter handoff locked")
  console.log("Mining is not started yet; call PatrolMiner.startMining() from /admin when ready.")
  console.log("")
  console.log("Add to env:")
  console.log(`NEXT_PUBLIC_SENTI_TOKEN_ADDRESS=${tokenAddress}`)
  console.log(`NEXT_PUBLIC_PATROL_MINER_ADDRESS=${minerAddress}`)
  console.log(`NEXT_PUBLIC_SENTI_LIQUIDITY_MANAGER_ADDRESS=${managerAddress}`)
  console.log(`NEXT_PUBLIC_SENTI_HOOK_ADDRESS=${sentiHook}`)
  console.log(`NEXT_PUBLIC_UNISWAP_V4_POSITION_MANAGER_ADDRESS=${positionManagerAddress}`)
  console.log(`NEXT_PUBLIC_MINING_BACKEND_SIGNER_ADDRESS=${backendSigner}`)
  console.log("")
  console.log("Manager bootstrap:")
  console.log(`SENTI_V4_POOL_FEE=${poolFee}`)
  console.log(`SENTI_V4_POOL_TICK_SPACING=${poolTickSpacing}`)
  console.log(`SENTI_V4_POOL_SENTI_IS_CURRENCY0=${sentiIsCurrency0}`)
  console.log(`UNISWAP_PERMIT2_ADDRESS=${resolvedPermit2Address}`)
  console.log(`SENTI_COMPOUND_MIN_ETH=${ethers.formatEther(compoundMinEthToCompound)}`)
  console.log(`SENTI_COMPOUND_COOLDOWN=${compoundCooldown}`)
  console.log(`SENTI_COMPOUND_MAX_ETH=${ethers.formatEther(compoundMaxEthPerCompound)}`)
  console.log(`SENTI_COMPOUND_MAX_SENTI=${ethers.formatEther(compoundMaxSentiPerCompound)}`)
  console.log(`SENTI_COMPOUND_MAX_DEADLINE_WINDOW=${compoundMaxDeadlineWindow}`)
  console.log("")
  console.log("Mining allocation:")
  console.log(`MINEABLE_SUPPLY=${mineableSupply}`)
  console.log(`INITIAL_LIQUIDITY_SUPPLY=${initialLiquiditySupply}`)
  console.log(`LIQUIDITY_MANAGER_RESERVE_SUPPLY=${liquidityManagerReserveSupply}`)
  console.log(`MAX_AI_AGENT_RESERVED_SUPPLY=${maxAiAgentReservedSupply}`)
  console.log(`MAX_REWARD_ROUNDS=${await miner.MAX_REWARD_ROUNDS()}`)
  console.log("")
  console.log("Verify with:")
  const networkName = network.name === "unknown" ? "<network>" : network.name
  console.log(`npx hardhat verify --network ${networkName} ${tokenAddress} ${deployer.address}`)
  console.log(`npx hardhat verify --network ${networkName} ${minerAddress} ${tokenAddress} ${admin} ${backendSigner}`)
  console.log(`Manager constructor args: ${admin} ${opsSafe} ${tokenAddress} ${positionManagerAddress} ${resolvedPermit2Address} <poolKey> <compoundConfig>`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})