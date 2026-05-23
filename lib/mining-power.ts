import type { QueryResultRow } from 'pg'
import { createPublicClient, getAddress, http, isAddress, type Address } from 'viem'
import traitsConfig from '@/config/traits.json'
import traitPowerConfig from '@/mining-sentinel/config/trait-power.json'
import traitRegistryLoader from '@/mining-sentinel/generated/trait-registry-loader.json'
import { miningChain, nftSourceChain } from '@/lib/mining-config'
import { getOptionalMiningServerConfig } from '@/lib/mining-server-config'
import { miningQuery } from '@/lib/mining-db'
import { safeFetchTokenMetadata, type TokenMetadata } from '@/lib/safe-fetch'
import { MINING_INACTIVE_AFTER_SECONDS, MINING_POWER_CACHE_TTL_SECONDS } from '@/lib/mining-session'
import { TRAIT_REGISTRY_ABI } from '@/lib/mining-contracts'

type PowerTier = keyof typeof traitPowerConfig.tierValues
type LayerPowerConfig = { traits: Record<string, PowerTier> }

interface ActiveWalletRow extends QueryResultRow {
  wallet: string
}

interface TokenPowerBreakdown {
  tokenId: number
  tokenURI: string | null
  name: string
  image: string | null
  eligible: boolean
  status: 'eligible' | 'ineligible'
  reason: string | null
  basePower: string
  synergyMultiplierBps: number
  finalPower: string
  triggeredSynergies: Array<{ id: string; name: string; multiplierBps: number }>
  traits: Array<{
    layer: string
    layerName: string
    traitId: string
    traitName: string
    tier: PowerTier
    tierValue: number
    layerWeightBps: number
    power: string
  }>
}

interface WalletPowerResult {
  wallet: Address
  status: 'ready' | 'error'
  walletPower: bigint
  nftCount: number
  eligibleNftCount: number
  tokens: TokenPowerBreakdown[]
  error?: string
}

type NftMulticallResult =
  | { status: 'success'; result: unknown }
  | { status: 'failure'; error?: unknown }

interface NftReadClient {
  readContract(args: {
    address: Address
    abi: typeof NFT_POWER_ABI
    functionName: 'totalSupply'
  }): Promise<unknown>
  multicall(args: {
    allowFailure: true
    contracts: Array<{
      address: Address
      abi: typeof NFT_POWER_ABI
      functionName: 'ownerOf' | 'tokenURI'
      args: [bigint]
    }>
  }): Promise<NftMulticallResult[]>
}

const OWNER_OF_CHUNK_SIZE = 250
const TOKEN_URI_CHUNK_SIZE = 100
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const layerPowerConfig = traitPowerConfig.layers as Record<string, LayerPowerConfig>
const layerWeightsBps = traitPowerConfig.layerWeightsBps as Record<string, number>
const tierValues = traitPowerConfig.tierValues as Record<PowerTier, number>
let traitRegistryVerification: Promise<void> | null = null
const NFT_POWER_ABI = [
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'tokenURI',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'string' }],
  },
] as const

interface WalletPowerPayloadSource {
  nftSourceChainId?: number
  nftSourceContractAddress?: string
}

type MiningPowerConfig = {
  nftSourceContractAddress: Address
  nftSourceRpcUrl: string
  miningRpcUrl: string
  traitRegistryAddress: Address
}

function readWalletPowerPayloadSource(payload: unknown): WalletPowerPayloadSource | null {
  if (!payload || typeof payload !== 'object') return null
  const source = (payload as Record<string, unknown>).source
  if (!source || typeof source !== 'object') return null
  const value = source as Record<string, unknown>
  return {
    nftSourceChainId: typeof value.nftSourceChainId === 'number' ? value.nftSourceChainId : undefined,
    nftSourceContractAddress: typeof value.nftSourceContractAddress === 'string' ? value.nftSourceContractAddress : undefined,
  }
}

function requireMiningPowerConfig(): MiningPowerConfig {
  const config = getOptionalMiningServerConfig()
  const nftSourceContractAddress = config.nftSource.contractAddress
  const nftSourceRpcUrl = config.nftSource.rpcUrl
  const miningRpcUrl = config.miningChain.rpcUrl
  const traitRegistryAddress = config.miningChain.contracts.traitRegistry

  if (!nftSourceContractAddress) {
    throw new Error('NEXT_PUBLIC_NFT_SOURCE_CONTRACT_ADDRESS or NEXT_PUBLIC_NFT_CONTRACT_ADDRESS is required')
  }
  if (!nftSourceRpcUrl) {
    throw new Error('NFT_SOURCE_RPC_URL is required')
  }
  if (!miningRpcUrl) {
    throw new Error('MINING_RPC_URL is required')
  }
  if (!traitRegistryAddress) {
    throw new Error('NEXT_PUBLIC_TRAIT_REGISTRY_ADDRESS is required')
  }

  return {
    nftSourceContractAddress,
    nftSourceRpcUrl,
    miningRpcUrl,
    traitRegistryAddress,
  }
}

export function getWalletPowerCacheSource() {
  const config = requireMiningPowerConfig()
  return {
    nftSourceChainId: nftSourceChain.id,
    nftSourceContractAddress: config.nftSourceContractAddress,
  }
}

export function walletPowerPayloadMatchesCurrentSource(payload: unknown) {
  const source = readWalletPowerPayloadSource(payload)
  if (!source?.nftSourceContractAddress || !source.nftSourceChainId) return false

  const current = getWalletPowerCacheSource()
  return source.nftSourceChainId === current.nftSourceChainId
    && source.nftSourceContractAddress.toLowerCase() === current.nftSourceContractAddress.toLowerCase()
}

function normalizeLabel(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .trim()
    .toLowerCase()
    .replace(/^#/, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function assertSameRegistryValue(name: string, actual: unknown, expected: unknown) {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`TraitRegistry ${name} mismatch: expected ${expected}, got ${actual}`)
  }
}

function numericRegistryValue(value: unknown): number {
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number') return value
  return Number(String(value))
}

async function verifyTraitRegistryRules() {
  if (traitRegistryVerification) return traitRegistryVerification

  traitRegistryVerification = (async () => {
    const config = requireMiningPowerConfig()

    const client = createPublicClient({ chain: miningChain, transport: http(config.miningRpcUrl) })
    const [
      finalized,
      traitsSourceHash,
      powerConfigHash,
      synergyRulesHash,
      rulesCommitment,
      collectionCap,
      expectedLayerCount,
      expectedTraitCount,
      expectedSynergyCount,
      configuredLayerCount,
      configuredTraitCount,
      configuredSynergyCount,
    ] = await Promise.all([
      client.readContract({ address: config.traitRegistryAddress, abi: TRAIT_REGISTRY_ABI, functionName: 'finalized' }),
      client.readContract({ address: config.traitRegistryAddress, abi: TRAIT_REGISTRY_ABI, functionName: 'traitsSourceHash' }),
      client.readContract({ address: config.traitRegistryAddress, abi: TRAIT_REGISTRY_ABI, functionName: 'powerConfigHash' }),
      client.readContract({ address: config.traitRegistryAddress, abi: TRAIT_REGISTRY_ABI, functionName: 'synergyRulesHash' }),
      client.readContract({ address: config.traitRegistryAddress, abi: TRAIT_REGISTRY_ABI, functionName: 'rulesCommitment' }),
      client.readContract({ address: config.traitRegistryAddress, abi: TRAIT_REGISTRY_ABI, functionName: 'collectionCap' }),
      client.readContract({ address: config.traitRegistryAddress, abi: TRAIT_REGISTRY_ABI, functionName: 'expectedLayerCount' }),
      client.readContract({ address: config.traitRegistryAddress, abi: TRAIT_REGISTRY_ABI, functionName: 'expectedTraitCount' }),
      client.readContract({ address: config.traitRegistryAddress, abi: TRAIT_REGISTRY_ABI, functionName: 'expectedSynergyCount' }),
      client.readContract({ address: config.traitRegistryAddress, abi: TRAIT_REGISTRY_ABI, functionName: 'configuredLayerCount' }),
      client.readContract({ address: config.traitRegistryAddress, abi: TRAIT_REGISTRY_ABI, functionName: 'configuredTraitCount' }),
      client.readContract({ address: config.traitRegistryAddress, abi: TRAIT_REGISTRY_ABI, functionName: 'configuredSynergyCount' }),
    ])

    assertSameRegistryValue('finalized', finalized, true)
    assertSameRegistryValue('traitsSourceHash', traitsSourceHash, traitRegistryLoader.hashes.traitsSourceHash)
    assertSameRegistryValue('powerConfigHash', powerConfigHash, traitRegistryLoader.hashes.powerConfigHash)
    assertSameRegistryValue('synergyRulesHash', synergyRulesHash, traitRegistryLoader.hashes.synergyRulesHash)
    assertSameRegistryValue('rulesCommitment', rulesCommitment, traitRegistryLoader.hashes.rulesCommitment)
    assertSameRegistryValue('collectionCap', numericRegistryValue(collectionCap), traitRegistryLoader.collectionCap)
    assertSameRegistryValue('expectedLayerCount', numericRegistryValue(expectedLayerCount), traitRegistryLoader.counts.layers)
    assertSameRegistryValue('expectedTraitCount', numericRegistryValue(expectedTraitCount), traitRegistryLoader.counts.traits)
    assertSameRegistryValue('expectedSynergyCount', numericRegistryValue(expectedSynergyCount), traitRegistryLoader.counts.synergies)
    assertSameRegistryValue('configuredLayerCount', numericRegistryValue(configuredLayerCount), traitRegistryLoader.counts.layers)
    assertSameRegistryValue('configuredTraitCount', numericRegistryValue(configuredTraitCount), traitRegistryLoader.counts.traits)
    assertSameRegistryValue('configuredSynergyCount', numericRegistryValue(configuredSynergyCount), traitRegistryLoader.counts.synergies)

    await Promise.all(traitRegistryLoader.layerWeights.layerIds.map(async (layerId, index) => {
      const value = await client.readContract({ address: config.traitRegistryAddress, abi: TRAIT_REGISTRY_ABI, functionName: 'layerWeightBps', args: [layerId] })
      assertSameRegistryValue(`layerWeightBps(${layerId})`, numericRegistryValue(value), traitRegistryLoader.layerWeights.weightsBps[index])
    }))

    await Promise.all(traitRegistryLoader.traitValueBatches.flatMap((batch) => batch.layerIds.map(async (layerId, index) => {
      const traitId = batch.traitIds[index]
      const value = await client.readContract({ address: config.traitRegistryAddress, abi: TRAIT_REGISTRY_ABI, functionName: 'traitValue', args: [layerId, traitId] })
      assertSameRegistryValue(`traitValue(${layerId},${traitId})`, numericRegistryValue(value), batch.values[index])
    })))

    await Promise.all(traitRegistryLoader.synergyMultipliers.synergyIds.map(async (synergyId, index) => {
      const value = await client.readContract({ address: config.traitRegistryAddress, abi: TRAIT_REGISTRY_ABI, functionName: 'synergyMultiplierBps', args: [synergyId] })
      assertSameRegistryValue(`synergyMultiplierBps(${synergyId})`, numericRegistryValue(value), traitRegistryLoader.synergyMultipliers.multipliersBps[index])
    }))
  })().catch((error) => {
    traitRegistryVerification = null
    throw error
  })

  return traitRegistryVerification
}

const layerByLabel = new Map<string, { id: string; name: string; required: boolean }>()
const traitByLayerAndLabel = new Map<string, Map<string, { id: string; name: string }>>()

for (const layer of traitsConfig.layers) {
  const layerInfo = { id: layer.id, name: layer.name, required: Boolean(layer.required) }
  layerByLabel.set(normalizeLabel(layer.id), layerInfo)
  layerByLabel.set(normalizeLabel(layer.name), layerInfo)

  const traits = new Map<string, { id: string; name: string }>()
  for (const option of layer.options) {
    const traitInfo = { id: option.id, name: option.name }
    traits.set(normalizeLabel(option.id), traitInfo)
    traits.set(normalizeLabel(option.name), traitInfo)
  }
  traitByLayerAndLabel.set(layer.id, traits)
}

function getAttributeMap(metadata: TokenMetadata | null) {
  const map = new Map<string, { traitId: string; traitName: string }>()
  const attributes = Array.isArray(metadata?.attributes) ? metadata.attributes : []

  for (const attribute of attributes) {
    const layer = layerByLabel.get(normalizeLabel(attribute.trait_type))
    if (!layer) continue
    const trait = traitByLayerAndLabel.get(layer.id)?.get(normalizeLabel(attribute.value))
    if (!trait) {
      map.set(layer.id, { traitId: normalizeLabel(attribute.value), traitName: String(attribute.value) })
      continue
    }
    if (map.has(layer.id)) {
      map.set(layer.id, { traitId: '__duplicate__', traitName: `Duplicate ${layer.name}` })
      continue
    }
    map.set(layer.id, { traitId: trait.id, traitName: trait.name })
  }

  return map
}

function calculateTokenPower(input: {
  tokenId: number
  tokenURI: string | null
  metadata: TokenMetadata | null
}): TokenPowerBreakdown {
  const name = input.metadata?.name ?? `SentinelETH #${input.tokenId}`
  const image = typeof input.metadata?.image === 'string' ? input.metadata.image : null

  if (!input.tokenURI) {
    return emptyToken(input, name, image, 'empty_token_uri')
  }
  if (!input.metadata) {
    return emptyToken(input, name, image, 'metadata_unavailable')
  }

  const attributes = getAttributeMap(input.metadata)
  const issues: string[] = []
  const traitRows: TokenPowerBreakdown['traits'] = []
  let basePower = 0n

  for (const layer of traitsConfig.layers) {
    const selected = attributes.get(layer.id)
    if (!selected) {
      if (layer.required) issues.push(`missing_${layer.id}`)
      continue
    }
    if (selected.traitId === '__duplicate__') {
      issues.push(`duplicate_${layer.id}`)
      continue
    }

    const tier = layerPowerConfig[layer.id]?.traits[selected.traitId]
    if (!tier) {
      issues.push(`unknown_${layer.id}_${selected.traitId}`)
      continue
    }

    const tierValue = tierValues[tier]
    const layerWeightBps = layerWeightsBps[layer.id] ?? 0
    const power = BigInt(Math.floor((tierValue * layerWeightBps) / 1000))
    basePower += power
    traitRows.push({
      layer: layer.id,
      layerName: layer.name,
      traitId: selected.traitId,
      traitName: selected.traitName,
      tier,
      tierValue,
      layerWeightBps,
      power: power.toString(),
    })
  }

  if (issues.length > 0) {
    return {
      tokenId: input.tokenId,
      tokenURI: input.tokenURI,
      name,
      image,
      eligible: false,
      status: 'ineligible',
      reason: issues.join(','),
      basePower: '0',
      synergyMultiplierBps: 0,
      finalPower: '0',
      triggeredSynergies: [],
      traits: traitRows,
    }
  }

  const traitByLayer = new Map(traitRows.map((trait) => [trait.layer, trait.traitId]))
  const triggeredSynergies = []
  let synergyMultiplierBps = BigInt(traitPowerConfig.synergyMultiplierScale)

  for (const synergy of traitPowerConfig.synergies) {
    const matched = synergy.requires.every((requirement) => {
      const selectedTrait = traitByLayer.get(requirement.layer)
      return selectedTrait ? requirement.anyOf.includes(selectedTrait) : false
    })
    if (!matched) continue

    triggeredSynergies.push({ id: synergy.id, name: synergy.name, multiplierBps: synergy.multiplierBps })
    synergyMultiplierBps = (synergyMultiplierBps * BigInt(synergy.multiplierBps)) / BigInt(traitPowerConfig.synergyMultiplierScale)
  }

  const cappedMultiplier = Number(
    synergyMultiplierBps > BigInt(traitPowerConfig.maxSynergyMultiplierBps)
      ? BigInt(traitPowerConfig.maxSynergyMultiplierBps)
      : synergyMultiplierBps,
  )
  const finalPower = (basePower * BigInt(cappedMultiplier)) / BigInt(traitPowerConfig.synergyMultiplierScale)

  return {
    tokenId: input.tokenId,
    tokenURI: input.tokenURI,
    name,
    image,
    eligible: finalPower > 0n,
    status: finalPower > 0n ? 'eligible' : 'ineligible',
    reason: finalPower > 0n ? null : 'zero_power',
    basePower: basePower.toString(),
    synergyMultiplierBps: cappedMultiplier,
    finalPower: finalPower.toString(),
    triggeredSynergies,
    traits: traitRows,
  }
}

function emptyToken(input: { tokenId: number; tokenURI: string | null }, name: string, image: string | null, reason: string): TokenPowerBreakdown {
  return {
    tokenId: input.tokenId,
    tokenURI: input.tokenURI,
    name,
    image,
    eligible: false,
    status: 'ineligible',
    reason,
    basePower: '0',
    synergyMultiplierBps: 0,
    finalPower: '0',
    triggeredSynergies: [],
    traits: [],
  }
}

export async function readActiveMiningWallets(): Promise<Address[]> {
  const result = await miningQuery<ActiveWalletRow>(
    `select distinct lower(s.wallet) as wallet
    from mining_sessions s
    where s.active = true
      and s.status in ('active', 'challenge_pending')
      and s.last_heartbeat_at >= now() - ($1::int * interval '1 second')
      and not exists (
        select 1 from mining_blacklist b
        where lower(b.wallet) = lower(s.wallet)
          and (b.expires_at is null or b.expires_at > now())
      )`,
    [MINING_INACTIVE_AFTER_SECONDS],
  )

  return result.rows
    .map((row) => row.wallet)
    .filter((wallet): wallet is Address => isAddress(wallet))
    .map((wallet) => getAddress(wallet) as Address)
}

async function readTokenOwners(client: NftReadClient, contractAddress: Address, totalSupply: number) {
  const owners = new Map<number, Address>()
  const tokenIds = Array.from({ length: totalSupply }, (_, index) => index + 1)

  for (let index = 0; index < tokenIds.length; index += OWNER_OF_CHUNK_SIZE) {
    const chunk = tokenIds.slice(index, index + OWNER_OF_CHUNK_SIZE)
    const results = await client.multicall({
      allowFailure: true,
      contracts: chunk.map((tokenId) => ({
        address: contractAddress,
        abi: NFT_POWER_ABI,
        functionName: 'ownerOf',
        args: [BigInt(tokenId)],
      })),
    })

    results.forEach((result, offset) => {
      if (result.status === 'success' && typeof result.result === 'string' && isAddress(result.result)) {
        owners.set(chunk[offset], getAddress(result.result) as Address)
      }
    })
  }

  return owners
}

async function readTokenUris(client: NftReadClient, contractAddress: Address, tokenIds: number[]) {
  const tokenUris = new Map<number, string | null>()

  for (let index = 0; index < tokenIds.length; index += TOKEN_URI_CHUNK_SIZE) {
    const chunk = tokenIds.slice(index, index + TOKEN_URI_CHUNK_SIZE)
    const results = await client.multicall({
      allowFailure: true,
      contracts: chunk.map((tokenId) => ({
        address: contractAddress,
        abi: NFT_POWER_ABI,
        functionName: 'tokenURI',
        args: [BigInt(tokenId)],
      })),
    })

    results.forEach((result, offset) => {
      tokenUris.set(chunk[offset], result.status === 'success' && typeof result.result === 'string' ? result.result : null)
    })
  }

  return tokenUris
}

export async function calculateWalletPowers(wallets: Address[]): Promise<WalletPowerResult[]> {
  const uniqueWallets = Array.from(new Set(wallets.map((wallet) => getAddress(wallet) as Address)))
  if (uniqueWallets.length === 0) return []

  const config = requireMiningPowerConfig()
  await verifyTraitRegistryRules()

  const client = createPublicClient({ chain: nftSourceChain, transport: http(config.nftSourceRpcUrl) }) as unknown as NftReadClient
  const totalSupply = Number(await client.readContract({
    address: config.nftSourceContractAddress,
    abi: NFT_POWER_ABI,
    functionName: 'totalSupply',
  }))

  const owners = await readTokenOwners(client, config.nftSourceContractAddress, totalSupply)
  const wantedWallets = new Set(uniqueWallets.map((wallet) => wallet.toLowerCase()))
  const tokenIdsByWallet = new Map<string, number[]>()
  for (const wallet of uniqueWallets) tokenIdsByWallet.set(wallet.toLowerCase(), [])

  for (const [tokenId, owner] of owners) {
    const normalizedOwner = owner.toLowerCase()
    if (wantedWallets.has(normalizedOwner)) tokenIdsByWallet.get(normalizedOwner)?.push(tokenId)
  }

  const allHeldTokenIds = Array.from(new Set(Array.from(tokenIdsByWallet.values()).flat())).sort((a, b) => a - b)
  const tokenUris = await readTokenUris(client, config.nftSourceContractAddress, allHeldTokenIds)
  const metadataByTokenId = new Map<number, TokenMetadata | null>()

  await Promise.all(allHeldTokenIds.map(async (tokenId) => {
    metadataByTokenId.set(tokenId, await safeFetchTokenMetadata(tokenUris.get(tokenId)))
  }))

  return uniqueWallets.map((wallet) => {
    const tokenIds = tokenIdsByWallet.get(wallet.toLowerCase()) ?? []
    const tokens = tokenIds.map((tokenId) => calculateTokenPower({
      tokenId,
      tokenURI: tokenUris.get(tokenId) ?? null,
      metadata: metadataByTokenId.get(tokenId) ?? null,
    }))
    const walletPower = tokens.reduce((total, token) => total + BigInt(token.finalPower), 0n)
    return {
      wallet,
      status: 'ready',
      walletPower,
      nftCount: tokenIds.length,
      eligibleNftCount: tokens.filter((token) => token.eligible).length,
      tokens,
    }
  })
}

export async function upsertWalletPower(result: WalletPowerResult) {
  const source = getWalletPowerCacheSource()
  const payload = {
    rulesCommitment: traitRegistryLoader.hashes.rulesCommitment,
    source: {
      nftSourceChainId: source.nftSourceChainId,
      nftSourceContractAddress: source.nftSourceContractAddress,
      traitsSourceHash: traitRegistryLoader.hashes.traitsSourceHash,
      powerConfigHash: traitRegistryLoader.hashes.powerConfigHash,
      synergyRulesHash: traitRegistryLoader.hashes.synergyRulesHash,
    },
    tokens: result.tokens,
    error: result.error ?? null,
  }

  await miningQuery(
    `insert into mining_power_cache (
      wallet,
      wallet_power,
      nft_count,
      eligible_nft_count,
      rules_commitment,
      status,
      computed_at,
      expires_at,
      payload,
      updated_at
    ) values (
      $1, $2, $3, $4, $5, $6, now(), now() + ($7::int * interval '1 second'), $8::jsonb, now()
    )
    on conflict (wallet) do update
    set wallet_power = excluded.wallet_power,
      nft_count = excluded.nft_count,
      eligible_nft_count = excluded.eligible_nft_count,
      rules_commitment = excluded.rules_commitment,
      status = excluded.status,
      computed_at = excluded.computed_at,
      expires_at = excluded.expires_at,
      payload = excluded.payload,
      updated_at = now()`,
    [
      result.wallet,
      result.walletPower.toString(),
      result.nftCount,
      result.eligibleNftCount,
      traitRegistryLoader.hashes.rulesCommitment,
      result.status,
      MINING_POWER_CACHE_TTL_SECONDS,
      JSON.stringify(payload),
    ],
  )
}

export async function markWalletPowerError(wallet: Address, error: unknown) {
  const message = error instanceof Error ? error.message : 'Power refresh failed'
  await miningQuery(
    `insert into mining_power_cache (wallet, status, payload, updated_at)
    values ($1, 'error', $2::jsonb, now())
    on conflict (wallet) do update
    set status = 'error', payload = excluded.payload, updated_at = now()`,
    [wallet, JSON.stringify({ error: message, tokens: [] })],
  )
}

export async function refreshMiningPowerForWallets(wallets: Address[]) {
  const validWallets = wallets.filter((wallet) => wallet !== ZERO_ADDRESS)
  if (validWallets.length === 0) return { refreshed: 0, errors: 0 }

  try {
    const results = await calculateWalletPowers(validWallets)
    for (const result of results) await upsertWalletPower(result)
    return { refreshed: results.length, errors: 0 }
  } catch (error) {
    await Promise.all(validWallets.map((wallet) => markWalletPowerError(wallet, error)))
    return { refreshed: 0, errors: validWallets.length }
  }
}

export async function refreshActiveMiningPowers() {
  const wallets = await readActiveMiningWallets()
  return refreshMiningPowerForWallets(wallets)
}