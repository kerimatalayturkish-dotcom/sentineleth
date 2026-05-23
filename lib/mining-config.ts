import { defineChain, type Address, type Chain, type Hex } from 'viem'
import { mainnet, sepolia } from 'viem/chains'

export type MiningDeployment = 'testnet' | 'mainnet'

export interface ChainConfig {
  chain: Chain
  chainId: number
  name: string
  rpcUrl?: string
  wsUrl?: string
  explorerUrl: string
}

export interface MiningContractsConfig {
  sentiToken?: Address
  traitRegistry?: Address
  patrolMiner?: Address
  sentiHook?: Address
  liquidityManager?: Address
  v4PoolId?: Hex
}

export interface MiningUniswapConfig {
  v4PoolManager?: Address
  v4PositionManager?: Address
  v4Quoter?: Address
  v4PoolSwapTest?: Address
}

export interface MiningAuthorityConfig {
  adminSafe?: Address
  opsSafe?: Address
  backendSigner?: Address
}

export interface MiningPublicConfig {
  deployment: MiningDeployment
  backendUrl?: string
  nftSource: ChainConfig & {
    contractAddress?: Address
  }
  miningChain: ChainConfig & {
    contracts: MiningContractsConfig
    uniswap: MiningUniswapConfig
    authority: MiningAuthorityConfig
  }
}

function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  const trimmed = optionalText(value)
  if (!trimmed) return fallback
  const parsed = Number(trimmed)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid chain id: ${trimmed}`)
  }
  return parsed
}

function deploymentFromEnv(value: string | undefined): MiningDeployment {
  const normalized = optionalText(value)?.toLowerCase()
  if (!normalized) return 'testnet'
  if (normalized === 'testnet' || normalized === 'mainnet') return normalized
  throw new Error(`Invalid NEXT_PUBLIC_MINING_DEPLOYMENT: ${value}`)
}

function optionalAddress(name: string, value: string | undefined): Address | undefined {
  const trimmed = optionalText(value)
  if (!trimmed) return undefined
  if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
    throw new Error(`Invalid ${name}: expected 20-byte 0x address`)
  }
  return trimmed as Address
}

function optionalBytes32(name: string, value: string | undefined): Hex | undefined {
  const trimmed = optionalText(value)
  if (!trimmed) return undefined
  if (!/^0x[a-fA-F0-9]{64}$/.test(trimmed)) {
    throw new Error(`Invalid ${name}: expected 32-byte 0x value`)
  }
  return trimmed as Hex
}

function knownChain(chainId: number): Chain | undefined {
  if (chainId === mainnet.id) return mainnet
  if (chainId === sepolia.id) return sepolia
  return undefined
}

function defaultUniswapConfig(chainId: number): Partial<MiningUniswapConfig> {
  if (chainId === sepolia.id) {
    return {
      v4Quoter: '0x61b3f2011a92d183c7dbadbda940a7555ccf9227' as Address,
      v4PoolSwapTest: '0x9b6b46e2c869aa39918db7f52f5557fe577b6eee' as Address,
    }
  }
  return {}
}

function makeChain(input: {
  chainId: number
  name: string
  rpcUrl?: string
  wsUrl?: string
  explorerUrl?: string
}): Chain {
  const base = knownChain(input.chainId)
  const explorerUrl = input.explorerUrl || base?.blockExplorers?.default.url || 'https://etherscan.io'
  const rpcUrl = input.rpcUrl || base?.rpcUrls.default.http[0] || ''

  return defineChain({
    id: input.chainId,
    name: input.name || base?.name || `Chain ${input.chainId}`,
    nativeCurrency: base?.nativeCurrency || { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: {
      default: {
        http: [rpcUrl],
        ...(input.wsUrl ? { webSocket: [input.wsUrl] } : {}),
      },
    },
    blockExplorers: {
      default: {
        name: base?.blockExplorers?.default.name || 'Explorer',
        url: explorerUrl,
      },
    },
    ...(base?.contracts ? { contracts: base.contracts } : {}),
  })
}

const legacyEthChainId = numberFromEnv(process.env.NEXT_PUBLIC_ETH_CHAIN_ID, mainnet.id)
const nftSourceChainId = numberFromEnv(process.env.NEXT_PUBLIC_NFT_SOURCE_CHAIN_ID, mainnet.id)
const nftSourceName = optionalText(process.env.NEXT_PUBLIC_NFT_SOURCE_CHAIN_NAME) || knownChain(nftSourceChainId)?.name || 'Ethereum'
const shouldUseLegacyNftEnv = legacyEthChainId === nftSourceChainId
const nftSourceRpcUrl = optionalText(process.env.NEXT_PUBLIC_NFT_SOURCE_RPC_URL) || (shouldUseLegacyNftEnv ? optionalText(process.env.NEXT_PUBLIC_ETH_RPC_URL) : undefined)
const nftSourceWsUrl = optionalText(process.env.NEXT_PUBLIC_NFT_SOURCE_WS_URL) || (shouldUseLegacyNftEnv ? optionalText(process.env.NEXT_PUBLIC_ETH_WS_URL) : undefined)
const nftSourceExplorerUrl = optionalText(process.env.NEXT_PUBLIC_NFT_SOURCE_EXPLORER_URL) || (shouldUseLegacyNftEnv ? optionalText(process.env.NEXT_PUBLIC_EXPLORER_URL) : undefined) || 'https://etherscan.io'
const nftSourceContractAddress = optionalAddress(
  'NEXT_PUBLIC_NFT_SOURCE_CONTRACT_ADDRESS',
  process.env.NEXT_PUBLIC_NFT_SOURCE_CONTRACT_ADDRESS || process.env.NEXT_PUBLIC_NFT_CONTRACT_ADDRESS,
)

const miningChainId = numberFromEnv(process.env.NEXT_PUBLIC_MINING_CHAIN_ID, sepolia.id)
const miningChainName = optionalText(process.env.NEXT_PUBLIC_MINING_CHAIN_NAME) || knownChain(miningChainId)?.name || 'Sepolia'
const miningRpcUrl = optionalText(process.env.NEXT_PUBLIC_MINING_RPC_URL)
const miningWsUrl = optionalText(process.env.NEXT_PUBLIC_MINING_WS_URL)
const miningExplorerUrl = optionalText(process.env.NEXT_PUBLIC_MINING_EXPLORER_URL) || knownChain(miningChainId)?.blockExplorers?.default.url || 'https://sepolia.etherscan.io'
const defaultUniswap = defaultUniswapConfig(miningChainId)

export const miningPublicConfig: MiningPublicConfig = {
  deployment: deploymentFromEnv(process.env.NEXT_PUBLIC_MINING_DEPLOYMENT),
  backendUrl: optionalText(process.env.NEXT_PUBLIC_MINING_BACKEND_URL),
  nftSource: {
    chainId: nftSourceChainId,
    name: nftSourceName,
    rpcUrl: nftSourceRpcUrl,
    wsUrl: nftSourceWsUrl,
    explorerUrl: nftSourceExplorerUrl,
    contractAddress: nftSourceContractAddress,
    chain: makeChain({
      chainId: nftSourceChainId,
      name: nftSourceName,
      rpcUrl: nftSourceRpcUrl,
      wsUrl: nftSourceWsUrl,
      explorerUrl: nftSourceExplorerUrl,
    }),
  },
  miningChain: {
    chainId: miningChainId,
    name: miningChainName,
    rpcUrl: miningRpcUrl,
    wsUrl: miningWsUrl,
    explorerUrl: miningExplorerUrl,
    chain: makeChain({
      chainId: miningChainId,
      name: miningChainName,
      rpcUrl: miningRpcUrl,
      wsUrl: miningWsUrl,
      explorerUrl: miningExplorerUrl,
    }),
    contracts: {
      sentiToken: optionalAddress('NEXT_PUBLIC_SENTI_TOKEN_ADDRESS', process.env.NEXT_PUBLIC_SENTI_TOKEN_ADDRESS),
      traitRegistry: optionalAddress('NEXT_PUBLIC_TRAIT_REGISTRY_ADDRESS', process.env.NEXT_PUBLIC_TRAIT_REGISTRY_ADDRESS),
      patrolMiner: optionalAddress('NEXT_PUBLIC_PATROL_MINER_ADDRESS', process.env.NEXT_PUBLIC_PATROL_MINER_ADDRESS),
      sentiHook: optionalAddress('NEXT_PUBLIC_SENTI_HOOK_ADDRESS', process.env.NEXT_PUBLIC_SENTI_HOOK_ADDRESS),
      liquidityManager: optionalAddress('NEXT_PUBLIC_SENTI_LIQUIDITY_MANAGER_ADDRESS', process.env.NEXT_PUBLIC_SENTI_LIQUIDITY_MANAGER_ADDRESS),
      v4PoolId: optionalBytes32('NEXT_PUBLIC_SENTI_V4_POOL_ID', process.env.NEXT_PUBLIC_SENTI_V4_POOL_ID),
    },
    uniswap: {
      v4PoolManager: optionalAddress('NEXT_PUBLIC_UNISWAP_V4_POOL_MANAGER_ADDRESS', process.env.NEXT_PUBLIC_UNISWAP_V4_POOL_MANAGER_ADDRESS),
      v4PositionManager: optionalAddress('NEXT_PUBLIC_UNISWAP_V4_POSITION_MANAGER_ADDRESS', process.env.NEXT_PUBLIC_UNISWAP_V4_POSITION_MANAGER_ADDRESS),
      v4Quoter: optionalAddress('NEXT_PUBLIC_UNISWAP_V4_QUOTER_ADDRESS', process.env.NEXT_PUBLIC_UNISWAP_V4_QUOTER_ADDRESS) ?? defaultUniswap.v4Quoter,
      v4PoolSwapTest: optionalAddress('NEXT_PUBLIC_UNISWAP_V4_POOL_SWAP_TEST_ADDRESS', process.env.NEXT_PUBLIC_UNISWAP_V4_POOL_SWAP_TEST_ADDRESS) ?? defaultUniswap.v4PoolSwapTest,
    },
    authority: {
      adminSafe: optionalAddress('NEXT_PUBLIC_MINING_ADMIN_SAFE_ADDRESS', process.env.NEXT_PUBLIC_MINING_ADMIN_SAFE_ADDRESS),
      opsSafe: optionalAddress('NEXT_PUBLIC_MINING_OPS_SAFE_ADDRESS', process.env.NEXT_PUBLIC_MINING_OPS_SAFE_ADDRESS),
      backendSigner: optionalAddress('NEXT_PUBLIC_MINING_BACKEND_SIGNER_ADDRESS', process.env.NEXT_PUBLIC_MINING_BACKEND_SIGNER_ADDRESS),
    },
  },
}

export const nftSourceChain = miningPublicConfig.nftSource.chain
export const miningChain = miningPublicConfig.miningChain.chain

export function miningExplorerTx(hash: string): string {
  return `${miningPublicConfig.miningChain.explorerUrl}/tx/${hash}`
}

export function miningExplorerAddress(address: string): string {
  return `${miningPublicConfig.miningChain.explorerUrl}/address/${address}`
}

export function nftSourceExplorerToken(tokenId: number | bigint): string {
  const contract = miningPublicConfig.nftSource.contractAddress
  if (!contract) return miningPublicConfig.nftSource.explorerUrl
  return `${miningPublicConfig.nftSource.explorerUrl}/token/${contract}?a=${tokenId}`
}