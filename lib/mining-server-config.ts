import { miningPublicConfig } from '@/lib/mining-config'
import type { Address } from 'viem'

function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function firstText(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = optionalText(value)
    if (trimmed) return trimmed
  }
  return undefined
}

function requireText(name: string, value: string | undefined): string {
  const trimmed = optionalText(value)
  if (!trimmed) throw new Error(`Missing required mining env var: ${name}`)
  return trimmed
}

function requireValue<T>(name: string, value: T | undefined): T {
  if (!value) throw new Error(`Missing required mining env var: ${name}`)
  return value
}

export interface MiningServerConfig {
  nftSource: {
    rpcUrl?: string
    wsUrl?: string
    contractAddress?: Address
  }
  miningChain: {
    rpcUrl?: string
    wsUrl?: string
    contracts: {
      sentiToken?: Address
      traitRegistry?: Address
      patrolMiner?: Address
      sentiHook?: Address
      liquidityManager?: Address
    }
    authority: {
      adminSafe?: Address
      opsSafe?: Address
      backendSigner?: Address
      adminPrivateKey?: `0x${string}`
    }
  }
  databaseUrl?: string
  turnstileSecretKey?: string
  signerMode: 'local' | 'turnkey'
  signerPrivateKey?: `0x${string}`
  turnkey: {
    organizationId?: string
    privateKeyId?: string
    apiPublicKey?: string
    apiPrivateKey?: string
  }
}

export function getOptionalMiningServerConfig(): MiningServerConfig {
  return {
    nftSource: {
      contractAddress: miningPublicConfig.nftSource.contractAddress,
      rpcUrl: firstText(
        process.env.NFT_SOURCE_RPC_URL,
        process.env.MAINNET_RPC_URL,
        process.env.NEXT_PUBLIC_NFT_SOURCE_RPC_URL,
        process.env.NEXT_PUBLIC_ETH_RPC_URL,
      ),
      wsUrl: firstText(
        process.env.NFT_SOURCE_WS_URL,
        process.env.NEXT_PUBLIC_NFT_SOURCE_WS_URL,
        process.env.NEXT_PUBLIC_ETH_WS_URL,
      ),
    },
    miningChain: {
      contracts: {
        sentiToken: miningPublicConfig.miningChain.contracts.sentiToken,
        traitRegistry: miningPublicConfig.miningChain.contracts.traitRegistry,
        patrolMiner: miningPublicConfig.miningChain.contracts.patrolMiner,
        sentiHook: miningPublicConfig.miningChain.contracts.sentiHook,
        liquidityManager: miningPublicConfig.miningChain.contracts.liquidityManager,
      },
      authority: {
        adminSafe: miningPublicConfig.miningChain.authority.adminSafe,
        opsSafe: miningPublicConfig.miningChain.authority.opsSafe,
        backendSigner: miningPublicConfig.miningChain.authority.backendSigner,
        adminPrivateKey: firstText(
          process.env.MINING_ADMIN_PRIVATE_KEY,
          process.env.OWNER_PRIVATE_KEY,
          process.env.SERVER_PRIVATE_KEY,
        ) as `0x${string}` | undefined,
      },
      rpcUrl: firstText(
        process.env.MINING_RPC_URL,
        process.env.NEXT_PUBLIC_MINING_RPC_URL,
      ),
      wsUrl: firstText(
        process.env.MINING_WS_URL,
        process.env.NEXT_PUBLIC_MINING_WS_URL,
      ),
    },
    databaseUrl: firstText(process.env.MINING_DATABASE_URL, process.env.DATABASE_URL),
    turnstileSecretKey: optionalText(process.env.TURNSTILE_SECRET_KEY),
    signerMode: process.env.MINING_SIGNER_MODE === 'turnkey' ? 'turnkey' : 'local',
    signerPrivateKey: optionalText(process.env.MINING_SIGNER_PRIVATE_KEY) as `0x${string}` | undefined,
    turnkey: {
      organizationId: optionalText(process.env.TURNKEY_ORGANIZATION_ID),
      privateKeyId: optionalText(process.env.TURNKEY_PRIVATE_KEY_ID),
      apiPublicKey: optionalText(process.env.TURNKEY_API_PUBLIC_KEY),
      apiPrivateKey: optionalText(process.env.TURNKEY_API_PRIVATE_KEY),
    },
  }
}

export function getMiningServerConfig(): MiningServerConfig {
  const config = getOptionalMiningServerConfig()
  return {
    ...config,
    nftSource: {
      ...config.nftSource,
      contractAddress: requireValue('NEXT_PUBLIC_NFT_SOURCE_CONTRACT_ADDRESS', config.nftSource.contractAddress),
      rpcUrl: requireText('NFT_SOURCE_RPC_URL', config.nftSource.rpcUrl),
    },
    miningChain: {
      ...config.miningChain,
      rpcUrl: requireText('MINING_RPC_URL', config.miningChain.rpcUrl),
      contracts: {
        ...config.miningChain.contracts,
        sentiToken: requireValue('NEXT_PUBLIC_SENTI_TOKEN_ADDRESS', config.miningChain.contracts.sentiToken),
        traitRegistry: requireValue('NEXT_PUBLIC_TRAIT_REGISTRY_ADDRESS', config.miningChain.contracts.traitRegistry),
        patrolMiner: requireValue('NEXT_PUBLIC_PATROL_MINER_ADDRESS', config.miningChain.contracts.patrolMiner),
      },
      authority: {
        ...config.miningChain.authority,
        backendSigner: requireValue('NEXT_PUBLIC_MINING_BACKEND_SIGNER_ADDRESS', config.miningChain.authority.backendSigner),
      },
    },
  }
}

export interface MiningWorkerConfig extends MiningServerConfig {
  databaseUrl: string
}

export function getMiningWorkerConfig(): MiningWorkerConfig {
  const config = getMiningServerConfig()
  return {
    ...config,
    databaseUrl: requireText('MINING_DATABASE_URL or DATABASE_URL', config.databaseUrl),
  }
}

export const isMiningMainnet = miningPublicConfig.deployment === 'mainnet'