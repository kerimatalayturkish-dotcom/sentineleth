import { HardhatUserConfig } from "hardhat/config"
import "@nomicfoundation/hardhat-toolbox"
import * as dotenv from "dotenv"
import { ethers } from "ethers"
import * as path from "path"

// Load env from project root .env.local
dotenv.config({ path: path.join(process.cwd(), '..', '.env.local') })

function normalizePrivateKey(value: string | undefined): `0x${string}` | undefined {
  const rawKey = (value || "").trim()
  const normalizedKey = rawKey.startsWith("0x") ? rawKey : (rawKey.length === 64 ? "0x" + rawKey : "")
  return normalizedKey.length === 66 && /^0x[0-9a-fA-F]{64}$/.test(normalizedKey)
    ? normalizedKey as `0x${string}`
    : undefined
}

function normalizeAddress(value: string | undefined): string | undefined {
  const trimmed = (value || "").trim()
  if (!trimmed || !ethers.isAddress(trimmed)) return undefined
  return ethers.getAddress(trimmed)
}

function matchesExpectedAddress(key: `0x${string}` | undefined, expected: string | undefined): boolean {
  if (!key || !expected) return false
  return ethers.computeAddress(key) === expected
}

const EXPECTED_SEPOLIA_DEPLOYER = normalizeAddress(
  process.env.TESTNET_DEPLOYER_ADDRESS || process.env.TEST_NFT_DEPLOYER_ADDRESS,
)
const OWNER_KEY = normalizePrivateKey(process.env.OWNER_PRIVATE_KEY)
const SERVER_KEY = normalizePrivateKey(process.env.SERVER_PRIVATE_KEY)
const SEPOLIA_DEPLOYER_KEY = normalizePrivateKey(process.env.TESTNET_DEPLOYER_PRIVATE_KEY)
  || normalizePrivateKey(process.env.TEST_NFT_DEPLOYER_PRIVATE_KEY)
  || normalizePrivateKey(process.env.MINING_ADMIN_PRIVATE_KEY)
  || (matchesExpectedAddress(SERVER_KEY, EXPECTED_SEPOLIA_DEPLOYER) ? SERVER_KEY : undefined)
  || undefined
const MAINNET_DEPLOYER_KEY = OWNER_KEY
  || SERVER_KEY
  || normalizePrivateKey(process.env.MINING_ADMIN_PRIVATE_KEY)
  || undefined

const ALCHEMY_KEY = (process.env.ALCHEMY_API_KEY || "").trim()
const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL
  || (ALCHEMY_KEY ? `https://eth-sepolia.g.alchemy.com/v2/${ALCHEMY_KEY}` : "https://ethereum-sepolia-rpc.publicnode.com")
const MAINNET_RPC = process.env.MAINNET_RPC_URL
  || (ALCHEMY_KEY ? `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}` : "https://ethereum-rpc.publicnode.com")

const ETHERSCAN_API_KEY = (process.env.ETHERSCAN_API_KEY || "").trim()

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      evmVersion: "cancun",
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    sepolia: {
      url: SEPOLIA_RPC,
      chainId: 11155111,
      accounts: SEPOLIA_DEPLOYER_KEY ? [SEPOLIA_DEPLOYER_KEY] : [],
    },
    mainnet: {
      url: MAINNET_RPC,
      chainId: 1,
      accounts: MAINNET_DEPLOYER_KEY ? [MAINNET_DEPLOYER_KEY] : [],
    },
  },
  etherscan: {
    apiKey: ETHERSCAN_API_KEY,
  },
  sourcify: {
    enabled: false, // we use Etherscan for verification on Ethereum
  },
}

export default config