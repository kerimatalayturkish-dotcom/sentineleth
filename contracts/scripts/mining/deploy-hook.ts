import hre from "hardhat"

import { predictCoreDeploymentAddresses } from "./hook-binding-utils"

const { ethers } = hre

const CREATE2_DEPLOYER = "0x4e59b44847b379578588920cA78FbF26c0B4956C"
const HOOK_FLAG_MASK = (1n << 14n) - 1n

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

function computeCreate2Address(deployer: string, salt: string, initCodeHash: string): string {
  return ethers.getCreate2Address(deployer, salt, initCodeHash)
}

function hasFlags(address: string, flags: bigint): boolean {
  return (BigInt(address) & HOOK_FLAG_MASK) === flags
}

async function main() {
  const [deployer] = await ethers.getSigners()
  const network = await ethers.provider.getNetwork()
  const chainId = network.chainId
  const isLocal = chainId === 31337n || chainId === 1337n

  if (chainId === 1n && !envFlag("MINING_CONFIRM_MAINNET_DEPLOY")) {
    throw new Error("Refusing mainnet hook deploy without MINING_CONFIRM_MAINNET_DEPLOY=true")
  }

  const positionManagerAddress = requireAddress(
    "NEXT_PUBLIC_UNISWAP_V4_POSITION_MANAGER_ADDRESS",
    process.env.NEXT_PUBLIC_UNISWAP_V4_POSITION_MANAGER_ADDRESS,
  )
  const poolManagerAddress = requireAddress(
    "NEXT_PUBLIC_UNISWAP_V4_POOL_MANAGER_ADDRESS",
    process.env.NEXT_PUBLIC_UNISWAP_V4_POOL_MANAGER_ADDRESS,
  )
  const currentNonce = await ethers.provider.getTransactionCount(deployer.address, "pending")
  const { tokenAddress: predictedTokenAddress, managerAddress: predictedManagerAddress, minerAddress: predictedMinerAddress } =
    predictCoreDeploymentAddresses(deployer.address, currentNonce + 1)
  const poolFee = integerFromEnv("SENTI_V4_POOL_FEE", 3000)
  const poolTickSpacing = integerFromEnv("SENTI_V4_POOL_TICK_SPACING", 60)

  const flags =
    (1n << 7n)
    | (1n << 6n)
    | (1n << 3n)
    | (1n << 2n)

  const SentiHook = await ethers.getContractFactory("SentiHook")
  const deployTx = await SentiHook.getDeployTransaction(
    poolManagerAddress,
    predictedTokenAddress,
    predictedManagerAddress,
    poolFee,
    poolTickSpacing,
  )
  if (!deployTx.data) {
    throw new Error("Unable to build SentiHook deployment bytecode")
  }

  const initCode = deployTx.data
  const initCodeHash = ethers.keccak256(initCode)

  let hookAddress: string | undefined
  let salt: string | undefined
  for (let candidate = 0; candidate < 160_444; candidate += 1) {
    const candidateSalt = ethers.zeroPadValue(ethers.toBeHex(candidate), 32)
    const predictedAddress = computeCreate2Address(CREATE2_DEPLOYER, candidateSalt, initCodeHash)
    if (hasFlags(predictedAddress, flags)) {
      hookAddress = predictedAddress
      salt = candidateSalt
      break
    }
  }

  if (!hookAddress || !salt) {
    throw new Error("Unable to mine a valid hook address")
  }

  console.log("Deploying SentiHook")
  console.log(`  network            : ${network.name} (chainId ${chainId})`)
  console.log(`  deployer           : ${deployer.address}`)
  console.log(`  current nonce      : ${currentNonce}`)
  console.log(`  pool manager       : ${poolManagerAddress}`)
  console.log(`  position manager   : ${positionManagerAddress}`)
  console.log(`  predicted SENTI    : ${predictedTokenAddress}`)
  console.log(`  predicted manager  : ${predictedManagerAddress}`)
  console.log(`  predicted miner    : ${predictedMinerAddress}`)
  console.log(`  pool fee           : ${poolFee}`)
  console.log(`  tick spacing       : ${poolTickSpacing}`)
  console.log(`  mined hook         : ${hookAddress}`)
  console.log(`  salt               : ${salt}`)

  if (isLocal) {
    throw new Error("deploy-hook.ts is intended for non-local hook deployment; use Sepolia or mainnet")
  }

  const tx = await deployer.sendTransaction({
    to: CREATE2_DEPLOYER,
    data: ethers.concat([salt, initCode]),
  })
  console.log(`  deploy tx          : ${tx.hash}`)
  await tx.wait()

  const code = await ethers.provider.getCode(hookAddress)
  if (code === "0x") {
    throw new Error(`SentiHook deployment failed at ${hookAddress}`)
  }

  console.log(`NEXT_PUBLIC_SENTI_HOOK_ADDRESS=${hookAddress}`)
  console.log(`NEXT_PUBLIC_SENTI_TOKEN_ADDRESS=${predictedTokenAddress}`)
  console.log(`NEXT_PUBLIC_SENTI_LIQUIDITY_MANAGER_ADDRESS=${predictedManagerAddress}`)
  console.log(`NEXT_PUBLIC_PATROL_MINER_ADDRESS=${predictedMinerAddress}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})