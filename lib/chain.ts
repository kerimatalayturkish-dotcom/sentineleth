import { defineChain } from 'viem'
import { mainnet, sepolia } from 'viem/chains'

const RAW_CHAIN_ID = Number(process.env.NEXT_PUBLIC_ETH_CHAIN_ID || '11155111')

// Pick the canonical viem chain when possible (gives us multicall, ENS, etc. for free).
// Fall back to a custom defineChain for any non-canonical env (dev anvil, etc.).
function pickChain() {
  if (RAW_CHAIN_ID === mainnet.id) return mainnet
  if (RAW_CHAIN_ID === sepolia.id) return sepolia
  const wsUrl = process.env.NEXT_PUBLIC_ETH_WS_URL
  return defineChain({
    id: RAW_CHAIN_ID,
    name: process.env.NEXT_PUBLIC_CHAIN_NAME || 'Ethereum',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: {
      default: {
        http: [process.env.NEXT_PUBLIC_ETH_RPC_URL || ''],
        ...(wsUrl ? { webSocket: [wsUrl] } : {}),
      },
    },
    blockExplorers: {
      default: {
        name: 'Explorer',
        url: process.env.NEXT_PUBLIC_EXPLORER_URL || 'https://etherscan.io',
      },
    },
  })
}

export const ethChain = pickChain()

export const NFT_CONTRACT_ADDRESS = process.env.NEXT_PUBLIC_NFT_CONTRACT_ADDRESS as `0x${string}`

// Explorer helpers
export const EXPLORER_URL =
  process.env.NEXT_PUBLIC_EXPLORER_URL ||
  ethChain.blockExplorers?.default.url ||
  'https://etherscan.io'

export function explorerTx(hash: string): string {
  return `${EXPLORER_URL}/tx/${hash}`
}
export function explorerAddress(addr: string): string {
  return `${EXPLORER_URL}/address/${addr}`
}
export function explorerToken(addr: string, tokenId: number | bigint): string {
  return `${EXPLORER_URL}/token/${addr}?a=${tokenId}`
}

// ─── Mint pricing (mirrors SentinelETH constants) ───
export const MINT_PRICE_WEI = 2_500_000_000_000_000n // 0.0025 ETH
export const MINT_PRICE_DISPLAY = '0.0025'
export const MINT_PRICE_CURRENCY = 'ETH'

// Per-wallet / per-batch limits
export const MAX_PER_WALLET = 4
export const MAX_BATCH_SIZE = 4

// Supply
export const MAX_SUPPLY = 10_000
export const PUBLIC_CAP = 8_293
export const AIRDROP_CAP = 1_707
