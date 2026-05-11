import { HardhatUserConfig } from "hardhat/config"
import "@nomicfoundation/hardhat-toolbox"
import * as dotenv from "dotenv"
import * as path from "path"

// Load env from project root .env.local
dotenv.config({ path: path.join(process.cwd(), '..', '.env.local') })

const rawKey = (process.env.SERVER_PRIVATE_KEY || "").trim()
const normalizedKey = rawKey.startsWith("0x") ? rawKey : (rawKey.length === 64 ? "0x" + rawKey : "")
const DEPLOYER_KEY = normalizedKey.length === 66 && /^0x[0-9a-fA-F]{64}$/.test(normalizedKey)
  ? normalizedKey
  : "0x" + "0".repeat(64) // compile-only fallback

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
      accounts: [DEPLOYER_KEY],
    },
    mainnet: {
      url: MAINNET_RPC,
      chainId: 1,
      accounts: [DEPLOYER_KEY],
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