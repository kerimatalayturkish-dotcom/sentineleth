import type { QueryResultRow } from 'pg'
import { createPublicClient, createWalletClient, encodeAbiParameters, encodePacked, formatEther, http, keccak256, parseAbiItem, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { miningChain } from '@/lib/mining-config'
import { getWalletPowerCacheSource } from '@/lib/mining-power'
import { getMiningServerConfig } from '@/lib/mining-server-config'
import { miningQuery, withMiningTransaction } from '@/lib/mining-db'
import { PATROL_MINER_ABI } from '@/lib/mining-contracts'
import { MINING_INACTIVE_AFTER_SECONDS } from '@/lib/mining-session'

export const CLAIM_BUCKET_SECONDS = 60 * 60
export const CLAIM_EXPIRY_SECONDS = 24 * 60 * 60
const CLAIM_EXPIRY_BUCKETS = CLAIM_EXPIRY_SECONDS / CLAIM_BUCKET_SECONDS
const MAX_LIVE_BUCKETS = CLAIM_EXPIRY_BUCKETS + 1

const PATROL_MINER_CLAIMED_EVENT = parseAbiItem(
  'event Claimed(uint256 indexed blockNumber, address indexed winner, uint256 reward, uint256 winnerPower, uint256 bucketId)',
)
const PATROL_MINER_AGGREGATE_CLAIMED_EVENT = parseAbiItem(
  'event AggregateClaimed(address indexed winner, uint256 roundCount, uint256 reward, uint256[] bucketIds, uint256[] settledRounds)',
)
const CLAIM_SYNC_CACHE_MS = 3_000
const OUTCOME_BATCH_SIZE = Math.max(1, Math.min(64, Number(process.env.MINING_OUTCOME_BATCH_SIZE || '6')))
const OUTCOME_INITIAL_BACKFILL_BLOCKS = Math.max(1, Math.min(32, Number(process.env.MINING_OUTCOME_INITIAL_BACKFILL_BLOCKS || '1')))

let claimSyncCache:
  | {
      expiresAt: number
      value: Awaited<ReturnType<typeof syncClaimSettlements>>
    }
  | null = null
let claimSyncInFlight: Promise<Awaited<ReturnType<typeof syncClaimSettlements>>> | null = null

interface EligiblePowerRow extends QueryResultRow {
  wallet: Address
  wallet_power: string
}

interface WinnerRow extends QueryResultRow {
  block_number: string
  bucket_id: string | null
  block_hash: Hex
  winner_wallet: Address
  winner_power: string
  signature: Hex
  claim_payload: Record<string, unknown>
  claimed: boolean
  claimed_tx_hash: Hex | null
  created_at: Date
  updated_at: Date
}

interface BlockOutcomeRow extends QueryResultRow {
  block_number: string
  block_hash: Hex
  block_timestamp: Date
  bucket_id: string | null
  status: 'won' | 'missed'
  eligible_wallet_count: number
  eligible_power_total: string | null
  winner_wallet: Address | null
  winner_power: string | null
  miss_reason: 'no_eligible_power' | null
  created_at: Date
  claimed: boolean | null
  claimed_tx_hash: Hex | null
  claim_payload: Record<string, unknown> | null
}

interface CountRow extends QueryResultRow {
  count: string
}

interface RewardTotalRow extends QueryResultRow {
  reward_total: string
}

interface WinnerStatsRow extends QueryResultRow {
  total_wins: string
  claimed_wins: string
  pending_wins: string
}

interface BucketTotalsRow extends QueryResultRow {
  bucket_id: string
  total_rounds: string
}

interface SyncCheckpointRow extends QueryResultRow {
  last_processed_block: string
}

export interface PublicWinner {
  blockNumber: number
  bucketId: number | null
  blockHash: Hex
  winner: Address
  winnerPower: string
  signature: Hex
  claimed: boolean
  claimedTxHash: Hex | null
  reward: string | null
  createdAt: string
}

export interface AggregateClaimVoucher {
  winner: Address
  bucketIds: number[]
  cumulativeRounds: number[]
  roundCount: number
  reward: string
  signature: Hex
}

export interface MiningWinnerStats {
  totalWins: number
  claimedWins: number
  pendingWins: number
}

export interface PublicBlockOutcome {
  blockNumber: number
  blockHash: Hex
  blockTimestamp: string
  bucketId: number | null
  status: 'won' | 'missed'
  eligibleWalletCount: number
  eligiblePowerTotal: string | null
  winner: Address | null
  winnerPower: string | null
  missReason: 'no_eligible_power' | null
  claimed: boolean
  claimedTxHash: Hex | null
  reward: string | null
  createdAt: string
}

export interface MiningBlockTimeline {
  startBlock: number | null
  currentBlock: number | null
  lastProcessedBlock: number | null
  windowStartBlock: number | null
  windowEndBlock: number | null
  blocks: PublicBlockOutcome[]
}

export interface MiningTimelineStreamSnapshot {
  currentBlock: number | null
  lastProcessedBlock: number | null
  latestOutcome: PublicBlockOutcome | null
}

const AGGREGATE_CLAIM_TYPES = {
  AggregateClaim: [
    { name: 'winner', type: 'address' },
    { name: 'bucketIdsHash', type: 'bytes32' },
    { name: 'cumulativeRoundsHash', type: 'bytes32' },
  ],
} as const

const CLAIM_TYPES = {
  Claim: [
    { name: 'blockNumber', type: 'uint256' },
    { name: 'bucketId', type: 'uint256' },
    { name: 'blockHash', type: 'bytes32' },
    { name: 'winner', type: 'address' },
    { name: 'winnerPower', type: 'uint256' },
  ],
} as const

function getPatrolMinerAddress() {
  const patrolMiner = getMiningServerConfig().miningChain.contracts.patrolMiner
  if (!patrolMiner) throw new Error('NEXT_PUBLIC_PATROL_MINER_ADDRESS is required')
  return patrolMiner
}

function getSignerPrivateKey(): `0x${string}` {
  const config = getMiningServerConfig()
  if (config.signerMode !== 'local') {
    throw new Error('Winner signing requires MINING_SIGNER_MODE=local until a managed signer integration is implemented')
  }

  const key = config.signerPrivateKey
  if (!key) throw new Error('MINING_SIGNER_PRIVATE_KEY is required for winner signing when MINING_SIGNER_MODE=local')
  return key
}

function currentBucketId(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000 / CLAIM_BUCKET_SECONDS)
}

function minLiveBucketId(nowMs = Date.now()) {
  return Math.max(0, currentBucketId(nowMs) - CLAIM_EXPIRY_BUCKETS)
}

function bucketIdForTimestamp(timestampSeconds: bigint | number) {
  const seconds = typeof timestampSeconds === 'bigint' ? Number(timestampSeconds) : timestampSeconds
  return Math.floor(seconds / CLAIM_BUCKET_SECONDS)
}

function hashUint256Array(values: bigint[]) {
  return keccak256(encodeAbiParameters([{ type: 'uint256[]' }], [values]))
}

function buildClaimPayload(input: {
  blockNumber: number
  bucketId: number
  blockHash: Hex
  winner: Address
  winnerPower: bigint
  signature: Hex
  reward: string
  eligibleWallets: number
  eligiblePowerTotal: string
  signer: Address
  blockTimestamp: string
}) {
  return {
    blockNumber: input.blockNumber,
    bucketId: input.bucketId,
    blockHash: input.blockHash,
    winner: input.winner,
    winnerPower: input.winnerPower.toString(),
    signature: input.signature,
    reward: input.reward,
    eligibleWallets: input.eligibleWallets,
    eligiblePowerTotal: input.eligiblePowerTotal,
    signer: input.signer,
    blockTimestamp: input.blockTimestamp,
  }
}

function readNumericPayloadValue(value: unknown) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value).toString()
  if (typeof value === 'bigint') return value.toString()
  return null
}

export async function readEligibleWalletPowers() {
  const source = getWalletPowerCacheSource()
  const result = await miningQuery<EligiblePowerRow>(
    `with active_wallets as (
      select distinct lower(s.wallet) as wallet
      from mining_sessions s
      where s.active = true
        and s.status in ('active', 'challenge_pending')
        and s.last_heartbeat_at >= now() - ($1::int * interval '1 second')
        and s.warmup_until <= now()
        and not exists (
          select 1 from mining_challenges c
          where c.session_id = s.id and c.status = 'issued' and c.expires_at <= now()
        )
        and not exists (
          select 1 from mining_blacklist b
          where lower(b.wallet) = lower(s.wallet)
            and (b.expires_at is null or b.expires_at > now())
        )
    )
    select power.wallet::text as wallet, power.wallet_power::text
    from active_wallets
    join mining_power_cache power on lower(power.wallet) = active_wallets.wallet
    where power.status = 'ready'
      and power.wallet_power > 0
      and (power.expires_at is null or power.expires_at > now())
      and lower(coalesce(power.payload->'source'->>'nftSourceContractAddress', '')) = lower($2)
      and coalesce(power.payload->'source'->>'nftSourceChainId', '') = $3`,
    [MINING_INACTIVE_AFTER_SECONDS, source.nftSourceContractAddress, String(source.nftSourceChainId)],
  )

  return result.rows
}

function scoreFor(blockHash: Hex, wallet: Address, walletPower: bigint) {
  return BigInt(keccak256(encodePacked(['bytes32', 'address'], [blockHash, wallet]))) / walletPower
}

function getPatrolMinerClient() {
  const config = getMiningServerConfig()
  const patrolMiner = config.miningChain.contracts.patrolMiner
  if (!patrolMiner) throw new Error('NEXT_PUBLIC_PATROL_MINER_ADDRESS is required')

  return {
    config,
    patrolMiner,
    publicClient: createPublicClient({ chain: miningChain, transport: http(config.miningChain.rpcUrl) }),
  }
}

async function readWinnerRowForBlock(blockNumber: bigint | number, patrolMiner: Address): Promise<WinnerRow | null> {
  const result = await miningQuery<WinnerRow>(
    `select block_number::text, bucket_id::text, block_hash, winner_wallet, winner_power::text, signature, claim_payload, claimed, claimed_tx_hash, created_at, updated_at
    from mining_block_winners
    where block_number = $1
      and lower(coalesce(patrol_miner_address, $2)) = lower($2)
    limit 1`,
    [blockNumber.toString(), patrolMiner],
  )

  return result.rows[0] ?? null
}

async function readOutcomeRowForBlock(blockNumber: bigint | number, patrolMiner: Address) {
  const result = await miningQuery<{ status: 'won' | 'missed' }>(
    `select status
    from mining_block_outcomes
    where block_number = $1
      and lower(patrol_miner_address) = lower($2)
    limit 1`,
    [blockNumber.toString(), patrolMiner],
  )

  return result.rows[0] ?? null
}

async function insertMissedOutcome(input: {
  blockNumber: bigint
  patrolMiner: Address
  blockHash: Hex
  blockTimestamp: Date
  bucketId: number
}) {
  await miningQuery(
    `insert into mining_block_outcomes (
      block_number,
      patrol_miner_address,
      block_hash,
      block_timestamp,
      bucket_id,
      status,
      eligible_wallet_count,
      eligible_power_total,
      miss_reason,
      updated_at
    ) values ($1, $2, $3, $4, $5, 'missed', 0, 0, 'no_eligible_power', now())
    on conflict (block_number) do nothing`,
    [input.blockNumber.toString(), input.patrolMiner, input.blockHash, input.blockTimestamp.toISOString(), input.bucketId],
  )
}

async function insertWonOutcome(input: {
  blockNumber: bigint
  patrolMiner: Address
  blockHash: Hex
  blockTimestamp: Date
  bucketId: number
  eligibleWalletCount: number
  eligiblePowerTotal: string | null
  winnerWallet: Address
  winnerPower: string
  signature: Hex
  claimPayload: Record<string, unknown>
  writeWinnerRow: boolean
}) {
  await withMiningTransaction(async (client) => {
    await client.query(
      `insert into mining_block_outcomes (
        block_number,
        patrol_miner_address,
        block_hash,
        block_timestamp,
        bucket_id,
        status,
        eligible_wallet_count,
        eligible_power_total,
        winner_wallet,
        winner_power,
        updated_at
      ) values ($1, $2, $3, $4, $5, 'won', $6, $7, $8, $9, now())
      on conflict (block_number) do nothing`,
      [
        input.blockNumber.toString(),
        input.patrolMiner,
        input.blockHash,
        input.blockTimestamp.toISOString(),
        input.bucketId,
        input.eligibleWalletCount,
        input.eligiblePowerTotal,
        input.winnerWallet,
        input.winnerPower,
      ],
    )

    if (!input.writeWinnerRow) return

    await client.query(
      `insert into mining_block_winners (
        block_number,
        bucket_id,
        patrol_miner_address,
        block_hash,
        winner_wallet,
        winner_power,
        signature,
        claim_payload,
        claimed,
        updated_at
      ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, false, now())
      on conflict (block_number) do nothing`,
      [
        input.blockNumber.toString(),
        input.bucketId,
        input.patrolMiner,
        input.blockHash,
        input.winnerWallet,
        input.winnerPower,
        input.signature,
        JSON.stringify(input.claimPayload),
      ],
    )
  })
}

async function processBlockOutcome(blockNumber: bigint) {
  const { config, patrolMiner, publicClient } = getPatrolMinerClient()
  const existingOutcome = await readOutcomeRowForBlock(blockNumber, patrolMiner)
  if (existingOutcome) {
    return { stored: false, status: existingOutcome.status, reason: 'already_processed' as const, blockNumber: Number(blockNumber) }
  }

  const block = await publicClient.getBlock({ blockNumber })
  const blockHash = block.hash
  if (!blockHash) return { stored: false, reason: 'block_hash_unavailable' as const, blockNumber: Number(blockNumber) }

  const blockTimestamp = new Date(Number(block.timestamp) * 1000)
  const bucketId = bucketIdForTimestamp(block.timestamp)
  const existingWinner = await readWinnerRowForBlock(blockNumber, patrolMiner)

  if (existingWinner) {
    const eligibleWalletCount = (() => {
      const value = existingWinner.claim_payload?.eligibleWallets
      return typeof value === 'number' ? value : Number(value ?? '0')
    })()
    const eligiblePowerTotal = readNumericPayloadValue(existingWinner.claim_payload?.eligiblePowerTotal)

    await insertWonOutcome({
      blockNumber,
      patrolMiner,
      blockHash: existingWinner.block_hash,
      blockTimestamp,
      bucketId: existingWinner.bucket_id === null ? bucketId : Number(existingWinner.bucket_id),
      eligibleWalletCount: Number.isFinite(eligibleWalletCount) ? eligibleWalletCount : 0,
      eligiblePowerTotal,
      winnerWallet: existingWinner.winner_wallet,
      winnerPower: existingWinner.winner_power,
      signature: existingWinner.signature,
      claimPayload: existingWinner.claim_payload,
      writeWinnerRow: false,
    })

    return {
      stored: true,
      status: 'won' as const,
      source: 'winner_row' as const,
      blockNumber: Number(blockNumber),
      winner: existingWinner.winner_wallet,
    }
  }

  const eligible = await readEligibleWalletPowers()
  if (eligible.length === 0) {
    await insertMissedOutcome({ blockNumber, patrolMiner, blockHash, blockTimestamp, bucketId })
    return { stored: true, status: 'missed' as const, reason: 'no_eligible_power' as const, blockNumber: Number(blockNumber) }
  }

  const eligiblePowerTotal = eligible.reduce((total, row) => total + BigInt(row.wallet_power), 0n)

  const ranked = eligible
    .map((row) => ({ wallet: row.wallet, walletPower: BigInt(row.wallet_power), score: scoreFor(blockHash, row.wallet, BigInt(row.wallet_power)) }))
    .sort((left, right) => left.score < right.score ? -1 : left.score > right.score ? 1 : left.wallet.localeCompare(right.wallet))

  const winner = ranked[0]
  const signerKey = getSignerPrivateKey()
  const account = privateKeyToAccount(signerKey)
  const walletClient = createWalletClient({ chain: miningChain, transport: http(config.miningChain.rpcUrl), account })
  const blockReward = await publicClient.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: 'BLOCK_REWARD' })

  const signature = await walletClient.signTypedData({
    account,
    domain: {
      name: 'PatrolMiner',
      version: '1',
      chainId: miningChain.id,
      verifyingContract: patrolMiner,
    },
    types: {
      ...CLAIM_TYPES,
    },
    primaryType: 'Claim',
    message: {
      blockNumber,
      bucketId: BigInt(bucketId),
      blockHash,
      winner: winner.wallet,
      winnerPower: winner.walletPower,
    },
  })

  const claimPayload = buildClaimPayload({
    blockNumber: Number(blockNumber),
    bucketId,
    blockHash,
    winner: winner.wallet,
    winnerPower: winner.walletPower,
    signature,
    reward: formatEther(blockReward),
    eligibleWallets: ranked.length,
    eligiblePowerTotal: eligiblePowerTotal.toString(),
    signer: account.address,
    blockTimestamp: blockTimestamp.toISOString(),
  })

  await insertWonOutcome({
    blockNumber,
    patrolMiner,
    blockHash,
    blockTimestamp,
    bucketId,
    eligibleWalletCount: ranked.length,
    eligiblePowerTotal: eligiblePowerTotal.toString(),
    winnerWallet: winner.wallet,
    winnerPower: winner.walletPower.toString(),
    signature,
    claimPayload,
    writeWinnerRow: true,
  })

  return {
    stored: true,
    status: 'won' as const,
    source: 'computed' as const,
    blockNumber: Number(blockNumber),
    winner: winner.wallet,
    eligibleWallets: ranked.length,
  }
}

export async function syncMiningBlockOutcomes(maxBlocks = OUTCOME_BATCH_SIZE) {
  const { patrolMiner, publicClient } = getPatrolMinerClient()
  const [miningStartBlock, latestBlock] = await Promise.all([
    publicClient.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: 'miningStartBlock' }),
    publicClient.getBlockNumber(),
  ])

  if (miningStartBlock === 0n || latestBlock < miningStartBlock) {
    return {
      synced: false,
      won: 0,
      missed: 0,
      processed: 0,
      fromBlock: null as number | null,
      toBlock: null as number | null,
      lastProcessedBlock: null as number | null,
      reason: 'mining_inactive' as const,
    }
  }

  const syncKey = `block-outcomes:${patrolMiner.toLowerCase()}`
  const checkpoint = await readMiningSyncCheckpoint(syncKey)
  const initialFromBlock = checkpoint > 0n
    ? checkpoint + 1n
    : latestBlock - BigInt(OUTCOME_INITIAL_BACKFILL_BLOCKS - 1)
  const fromBlock = initialFromBlock < miningStartBlock ? miningStartBlock : initialFromBlock

  if (fromBlock > latestBlock) {
    return {
      synced: true,
      won: 0,
      missed: 0,
      processed: 0,
      fromBlock: Number(fromBlock),
      toBlock: Number(latestBlock),
      lastProcessedBlock: checkpoint > 0n ? Number(checkpoint) : null,
      reason: 'up_to_date' as const,
    }
  }

  const cappedMaxBlocks = BigInt(Math.max(1, maxBlocks))
  const toBlock = fromBlock + cappedMaxBlocks - 1n > latestBlock ? latestBlock : fromBlock + cappedMaxBlocks - 1n

  let won = 0
  let missed = 0

  for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber += 1n) {
    const result = await processBlockOutcome(blockNumber)
    if (result.status === 'won') won += 1
    if (result.status === 'missed') missed += 1
  }

  await writeMiningSyncCheckpoint(syncKey, toBlock)

  return {
    synced: true,
    won,
    missed,
    processed: Number(toBlock - fromBlock + 1n),
    fromBlock: Number(fromBlock),
    toBlock: Number(toBlock),
    lastProcessedBlock: Number(toBlock),
    reason: 'processed' as const,
  }
}

function serializeBlockOutcome(row: BlockOutcomeRow): PublicBlockOutcome {
  const payload = row.claim_payload ?? {}
  return {
    blockNumber: Number(row.block_number),
    blockHash: row.block_hash,
    blockTimestamp: row.block_timestamp.toISOString(),
    bucketId: row.bucket_id === null ? null : Number(row.bucket_id),
    status: row.status,
    eligibleWalletCount: Number(row.eligible_wallet_count ?? 0),
    eligiblePowerTotal: row.eligible_power_total,
    winner: row.winner_wallet,
    winnerPower: row.winner_power,
    missReason: row.miss_reason,
    claimed: Boolean(row.claimed),
    claimedTxHash: row.claimed_tx_hash,
    reward: typeof payload.reward === 'string' ? payload.reward : null,
    createdAt: row.created_at.toISOString(),
  }
}

export async function readMiningBlockTimeline(endBlock?: number, limit = 120): Promise<MiningBlockTimeline> {
  const { patrolMiner, publicClient } = getPatrolMinerClient()
  const [miningStartBlock, currentBlock, checkpoint] = await Promise.all([
    publicClient.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: 'miningStartBlock' }),
    publicClient.getBlockNumber(),
    readMiningSyncCheckpoint(`block-outcomes:${patrolMiner.toLowerCase()}`),
  ])

  if (miningStartBlock === 0n) {
    return {
      startBlock: null,
      currentBlock: Number(currentBlock),
      lastProcessedBlock: null,
      windowStartBlock: null,
      windowEndBlock: null,
      blocks: [],
    }
  }

  const lastProcessedBlock = checkpoint > 0n ? checkpoint : null
  if (!lastProcessedBlock) {
    return {
      startBlock: Number(miningStartBlock),
      currentBlock: Number(currentBlock),
      lastProcessedBlock: null,
      windowStartBlock: null,
      windowEndBlock: null,
      blocks: [],
    }
  }

  const requestedEnd = endBlock && Number.isSafeInteger(endBlock) ? BigInt(endBlock) : lastProcessedBlock
  const windowEnd = requestedEnd > lastProcessedBlock ? lastProcessedBlock : requestedEnd
  const safeLimit = BigInt(Math.max(1, Math.min(400, limit)))
  const rawWindowStart = windowEnd - safeLimit + 1n
  const windowStart = rawWindowStart < miningStartBlock ? miningStartBlock : rawWindowStart

  const result = await miningQuery<BlockOutcomeRow>(
    `select
      outcomes.block_number::text,
      outcomes.block_hash,
      outcomes.block_timestamp,
      outcomes.bucket_id::text,
      outcomes.status,
      outcomes.eligible_wallet_count,
      outcomes.eligible_power_total::text,
      outcomes.winner_wallet,
      outcomes.winner_power::text,
      outcomes.miss_reason,
      outcomes.created_at,
      winners.claimed,
      winners.claimed_tx_hash,
      winners.claim_payload
    from mining_block_outcomes outcomes
    left join mining_block_winners winners
      on winners.block_number = outcomes.block_number
      and lower(coalesce(winners.patrol_miner_address, $1)) = lower($1)
    where lower(outcomes.patrol_miner_address) = lower($1)
      and outcomes.block_number between $2 and $3
    order by outcomes.block_number asc`,
    [patrolMiner, windowStart.toString(), windowEnd.toString()],
  )

  return {
    startBlock: Number(miningStartBlock),
    currentBlock: Number(currentBlock),
    lastProcessedBlock: Number(lastProcessedBlock),
    windowStartBlock: Number(windowStart),
    windowEndBlock: Number(windowEnd),
    blocks: result.rows.map(serializeBlockOutcome),
  }
}

export async function readMiningTimelineStreamSnapshot(): Promise<MiningTimelineStreamSnapshot> {
  const timeline = await readMiningBlockTimeline(undefined, 1)
  return {
    currentBlock: timeline.currentBlock,
    lastProcessedBlock: timeline.lastProcessedBlock,
    latestOutcome: timeline.blocks.at(-1) ?? null,
  }
}

export async function computeAndStoreWinnerForBlock(blockNumber?: bigint) {
  const { config, patrolMiner, publicClient } = getPatrolMinerClient()
  const [startBlock, miningActive] = await Promise.all([
    publicClient.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: 'miningStartBlock' }),
    publicClient.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: 'miningActive' }),
  ])

  if (startBlock === 0n || !miningActive) return { stored: false, reason: 'mining_inactive' as const }

  const latestBlockNumber = await publicClient.getBlockNumber()
  const targetBlockNumber = blockNumber ?? latestBlockNumber
  if (targetBlockNumber < startBlock || targetBlockNumber > latestBlockNumber) {
    return { stored: false, reason: 'block_not_claimable' as const }
  }

  const existing = await miningQuery(
    `select 1 from mining_block_winners where block_number = $1 and lower(coalesce(patrol_miner_address, $2)) = lower($2) limit 1`,
    [targetBlockNumber.toString(), patrolMiner],
  )
  if (existing.rowCount && existing.rowCount > 0) return { stored: false, reason: 'already_stored' as const }

  const block = await publicClient.getBlock({ blockNumber: targetBlockNumber })
  const blockHash = block.hash
  if (!blockHash) return { stored: false, reason: 'block_hash_unavailable' as const }
  const bucketId = bucketIdForTimestamp(block.timestamp)

  const eligible = await readEligibleWalletPowers()
  if (eligible.length === 0) return { stored: false, reason: 'no_eligible_power' as const }

  const ranked = eligible
    .map((row) => ({ wallet: row.wallet, walletPower: BigInt(row.wallet_power), score: scoreFor(blockHash, row.wallet, BigInt(row.wallet_power)) }))
    .sort((left, right) => left.score < right.score ? -1 : left.score > right.score ? 1 : left.wallet.localeCompare(right.wallet))
  const eligiblePowerTotal = eligible.reduce((total, row) => total + BigInt(row.wallet_power), 0n)

  const winner = ranked[0]
  const signerKey = getSignerPrivateKey()
  const account = privateKeyToAccount(signerKey)
  const walletClient = createWalletClient({ chain: miningChain, transport: http(config.miningChain.rpcUrl), account })

  const signature = await walletClient.signTypedData({
    account,
    domain: {
      name: 'PatrolMiner',
      version: '1',
      chainId: miningChain.id,
      verifyingContract: patrolMiner,
    },
    types: {
      ...CLAIM_TYPES,
    },
    primaryType: 'Claim',
    message: {
      blockNumber: targetBlockNumber,
      bucketId: BigInt(bucketId),
      blockHash,
      winner: winner.wallet,
      winnerPower: winner.walletPower,
    },
  })

  const blockReward = await publicClient.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: 'BLOCK_REWARD' })
  const claimPayload = buildClaimPayload({
    blockNumber: Number(targetBlockNumber),
    bucketId,
    blockHash,
    winner: winner.wallet,
    winnerPower: winner.walletPower,
    signature,
    reward: formatEther(blockReward),
    eligibleWallets: ranked.length,
    eligiblePowerTotal: eligiblePowerTotal.toString(),
    signer: account.address,
    blockTimestamp: new Date(Number(block.timestamp) * 1000).toISOString(),
  })

  await miningQuery(
    `insert into mining_block_winners (
      block_number,
      bucket_id,
      patrol_miner_address,
      block_hash,
      winner_wallet,
      winner_power,
      signature,
      claim_payload,
      claimed,
      updated_at
    ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, false, now())
    on conflict (block_number) do nothing`,
    [
      targetBlockNumber.toString(),
      bucketId,
      patrolMiner,
      blockHash,
      winner.wallet,
      winner.walletPower.toString(),
      signature,
      JSON.stringify(claimPayload),
    ],
  )

  return { stored: true, blockNumber: Number(targetBlockNumber), winner: winner.wallet, eligibleWallets: ranked.length }
}

export function serializeWinner(row: WinnerRow): PublicWinner {
  const payload = row.claim_payload ?? {}
  return {
    blockNumber: Number(row.block_number),
    bucketId: row.bucket_id === null ? null : Number(row.bucket_id),
    blockHash: row.block_hash,
    winner: row.winner_wallet,
    winnerPower: row.winner_power,
    signature: row.signature,
    claimed: row.claimed,
    claimedTxHash: row.claimed_tx_hash,
    reward: typeof payload.reward === 'string' ? payload.reward : null,
    createdAt: row.created_at.toISOString(),
  }
}

export async function readWinnerForBlock(blockNumber: number): Promise<PublicWinner | null> {
  const patrolMiner = getPatrolMinerAddress()
  const result = await miningQuery<WinnerRow>(
    `select block_number::text, bucket_id::text, block_hash, winner_wallet, winner_power::text, signature, claim_payload, claimed, claimed_tx_hash, created_at, updated_at
    from mining_block_winners
    where block_number = $1
      and lower(coalesce(patrol_miner_address, $2)) = lower($2)
    limit 1`,
    [blockNumber, patrolMiner],
  )
  return result.rows[0] ? serializeWinner(result.rows[0]) : null
}

export async function readUnclaimedWinsForWallet(wallet: Address, limit = 25): Promise<PublicWinner[]> {
  return readWinsForWallet(wallet, false, limit)
}

export async function readClaimedWinsForWallet(wallet: Address, limit = 25): Promise<PublicWinner[]> {
  return readWinsForWallet(wallet, true, limit)
}

async function readWinsForWallet(wallet: Address, claimed: boolean, limit: number): Promise<PublicWinner[]> {
  const patrolMiner = getPatrolMinerAddress()
  const liveBucketCutoff = minLiveBucketId()
  const result = await miningQuery<WinnerRow>(
    `select block_number::text, bucket_id::text, block_hash, winner_wallet, winner_power::text, signature, claim_payload, claimed, claimed_tx_hash, created_at, updated_at
    from mining_block_winners
    where lower(winner_wallet) = lower($1)
      and claimed = $2
      and lower(coalesce(patrol_miner_address, $3)) = lower($3)
      and ($2 = true or (bucket_id is not null and bucket_id >= $4))
    order by block_number desc
    limit $5`,
    [wallet, claimed, patrolMiner, liveBucketCutoff, limit],
  )
  return result.rows.map(serializeWinner)
}

export async function countUnclaimedWinsForWallet(wallet: Address): Promise<number> {
  return countWinsForWallet(wallet, false)
}

export async function countClaimedWinsForWallet(wallet: Address): Promise<number> {
  return countWinsForWallet(wallet, true)
}

export async function sumClaimedRewardForWallet(wallet: Address): Promise<string> {
  return sumRewardForWallet(wallet, true)
}

async function countWinsForWallet(wallet: Address, claimed: boolean): Promise<number> {
  const patrolMiner = getPatrolMinerAddress()
  const liveBucketCutoff = minLiveBucketId()
  const result = await miningQuery<CountRow>(
    `select count(*)::text as count
    from mining_block_winners
    where lower(winner_wallet) = lower($1)
      and claimed = $2
      and lower(coalesce(patrol_miner_address, $3)) = lower($3)
      and ($2 = true or (bucket_id is not null and bucket_id >= $4))`,
    [wallet, claimed, patrolMiner, liveBucketCutoff],
  )

  return Number(result.rows[0]?.count ?? '0')
}

async function sumRewardForWallet(wallet: Address, claimed: boolean): Promise<string> {
  const patrolMiner = getPatrolMinerAddress()
  const liveBucketCutoff = minLiveBucketId()
  const result = await miningQuery<RewardTotalRow>(
    `select coalesce(sum(
      case
        when jsonb_typeof(claim_payload->'reward') in ('string', 'number')
          then (claim_payload->>'reward')::numeric
        else 0
      end
    ), 0)::text as reward_total
    from mining_block_winners
    where lower(winner_wallet) = lower($1)
      and claimed = $2
      and lower(coalesce(patrol_miner_address, $3)) = lower($3)
      and ($2 = true or (bucket_id is not null and bucket_id >= $4))`,
    [wallet, claimed, patrolMiner, liveBucketCutoff],
  )

  return result.rows[0]?.reward_total ?? '0'
}

export async function readMiningWinnerStats(): Promise<MiningWinnerStats> {
  const patrolMiner = getPatrolMinerAddress()
  const liveBucketCutoff = minLiveBucketId()
  const result = await miningQuery<WinnerStatsRow>(
    `select
      count(*)::text as total_wins,
      count(*) filter (where claimed = true)::text as claimed_wins,
      count(*) filter (where claimed = false and bucket_id is not null and bucket_id >= $2)::text as pending_wins
    from mining_block_winners
    where lower(coalesce(patrol_miner_address, $1)) = lower($1)`,
    [patrolMiner, liveBucketCutoff],
  )

  return {
    totalWins: Number(result.rows[0]?.total_wins ?? '0'),
    claimedWins: Number(result.rows[0]?.claimed_wins ?? '0'),
    pendingWins: Number(result.rows[0]?.pending_wins ?? '0'),
  }
}

async function readLiveBucketTotalsForWallet(wallet: Address) {
  const patrolMiner = getPatrolMinerAddress()
  const result = await miningQuery<BucketTotalsRow>(
    `select bucket_id::text, count(*)::text as total_rounds
    from mining_block_winners
    where lower(winner_wallet) = lower($1)
      and bucket_id is not null
      and bucket_id >= $2
      and lower(coalesce(patrol_miner_address, $3)) = lower($3)
    group by bucket_id
    order by bucket_id asc
    limit $4`,
    [wallet, minLiveBucketId(), patrolMiner, MAX_LIVE_BUCKETS],
  )

  return result.rows.map((row) => ({ bucketId: Number(row.bucket_id), totalRounds: Number(row.total_rounds) }))
}

async function readClaimedBucketRounds(wallet: Address, bucketIds: number[]) {
  if (bucketIds.length === 0) return [] as bigint[]
  const { patrolMiner, publicClient } = getPatrolMinerClient()

  return Promise.all(
    bucketIds.map((bucketId) => publicClient.readContract({
      address: patrolMiner,
      abi: PATROL_MINER_ABI,
      functionName: 'claimedBucketRounds',
      args: [wallet, BigInt(bucketId)],
    })),
  )
}

export async function buildAggregateClaimVoucher(wallet: Address): Promise<AggregateClaimVoucher | null> {
  const bucketTotals = await readLiveBucketTotalsForWallet(wallet)
  if (bucketTotals.length === 0) return null

  const { patrolMiner, publicClient } = getPatrolMinerClient()

  const [remainingRewardRounds, remainingMineableSupply, blockReward] = await Promise.all([
    publicClient.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: 'remainingRewardRounds' }),
    publicClient.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: 'remainingMineableSupply' }),
    publicClient.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: 'BLOCK_REWARD' }),
  ])

  let remainingRounds = Number(remainingRewardRounds)
  if (remainingRounds <= 0) return null

  let claimedBucketRounds: bigint[]
  try {
    claimedBucketRounds = await readClaimedBucketRounds(wallet, bucketTotals.map((item) => item.bucketId))
  } catch {
    return null
  }
  const bucketIds: number[] = []
  const cumulativeRounds: number[] = []
  let claimableCount = 0

  for (let index = 0; index < bucketTotals.length; index += 1) {
    if (remainingRounds <= 0) break

    const item = bucketTotals[index]
    const alreadyClaimed = Number(claimedBucketRounds[index] ?? 0n)
    const available = item.totalRounds - alreadyClaimed
    if (available <= 0) continue

    const delta = Math.min(available, remainingRounds)
    bucketIds.push(item.bucketId)
    cumulativeRounds.push(alreadyClaimed + delta)
    claimableCount += delta
    remainingRounds -= delta
  }

  if (claimableCount <= 0) return null

  const signerKey = getSignerPrivateKey()
  const account = privateKeyToAccount(signerKey)
  const walletClient = createWalletClient({ chain: miningChain, transport: http(getMiningServerConfig().miningChain.rpcUrl), account })
  const bucketIdValues = bucketIds.map((value) => BigInt(value))
  const cumulativeRoundValues = cumulativeRounds.map((value) => BigInt(value))

  const signature = await walletClient.signTypedData({
    account,
    domain: {
      name: 'PatrolMiner',
      version: '1',
      chainId: miningChain.id,
      verifyingContract: patrolMiner,
    },
    types: AGGREGATE_CLAIM_TYPES,
    primaryType: 'AggregateClaim',
    message: {
      winner: wallet,
      bucketIdsHash: hashUint256Array(bucketIdValues),
      cumulativeRoundsHash: hashUint256Array(cumulativeRoundValues),
    },
  })

  const reward = BigInt(claimableCount) === remainingRewardRounds
    ? remainingMineableSupply
    : blockReward * BigInt(claimableCount)

  return {
    winner: wallet,
    bucketIds,
    cumulativeRounds,
    roundCount: claimableCount,
    reward: formatEther(reward),
    signature,
  }
}

export async function markWinnerClaimed(blockNumber: number, txHash: Hex) {
  const { patrolMiner, publicClient } = getPatrolMinerClient()
  const settled = await publicClient.readContract({
    address: patrolMiner,
    abi: PATROL_MINER_ABI,
    functionName: 'claimed',
    args: [BigInt(blockNumber)],
  })
  if (!settled) return false

  await miningQuery(
    `update mining_block_winners
    set claimed = true,
      claimed_tx_hash = $2,
      updated_at = now()
    where block_number = $1
      and lower(coalesce(patrol_miner_address, $3)) = lower($3)`,
    [blockNumber, txHash, patrolMiner],
  )
  return true
}

export async function markAggregateClaimed(
  wallet: Address,
  bucketIds: number[],
  settledRounds: number[],
  txHash: Hex,
) {
  if (bucketIds.length !== settledRounds.length) return false

  const patrolMiner = getPatrolMinerAddress()
  let allMatched = true

  for (let index = 0; index < bucketIds.length; index += 1) {
    const bucketId = bucketIds[index]
    const roundCount = settledRounds[index]
    if (!Number.isSafeInteger(roundCount) || roundCount <= 0) continue

    const result = await miningQuery(
      `with target as (
        select block_number
        from mining_block_winners
        where lower(winner_wallet) = lower($1)
          and claimed = false
          and bucket_id = $2
          and lower(coalesce(patrol_miner_address, $5)) = lower($5)
        order by block_number asc
        limit $3
      )
      update mining_block_winners winners
      set claimed = true,
        claimed_tx_hash = $4,
        updated_at = now()
      from target
      where winners.block_number = target.block_number
      returning winners.block_number::text`,
      [wallet, bucketId, roundCount, txHash, patrolMiner],
    )

    if ((result.rowCount ?? 0) !== roundCount) allMatched = false
  }

  return allMatched
}

async function readMiningSyncCheckpoint(syncKey: string) {
  const result = await miningQuery<SyncCheckpointRow>(
    `select last_processed_block::text
    from mining_chain_sync
    where sync_key = $1
    limit 1`,
    [syncKey],
  )

  return BigInt(result.rows[0]?.last_processed_block ?? '0')
}

async function writeMiningSyncCheckpoint(syncKey: string, blockNumber: bigint) {
  await miningQuery(
    `insert into mining_chain_sync (sync_key, last_processed_block, updated_at)
    values ($1, $2, now())
    on conflict (sync_key) do update
    set last_processed_block = excluded.last_processed_block,
      updated_at = now()`,
    [syncKey, blockNumber.toString()],
  )
}

export async function syncClaimSettlements() {
  const { patrolMiner, publicClient } = getPatrolMinerClient()
  const [miningStartBlock, latestBlock] = await Promise.all([
    publicClient.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: 'miningStartBlock' }),
    publicClient.getBlockNumber(),
  ])

  if (miningStartBlock === 0n || latestBlock < miningStartBlock) {
    return { synced: false, claimEvents: 0, aggregateEvents: 0, fromBlock: null as number | null, toBlock: null as number | null }
  }

  const syncKey = `claim-sync:${patrolMiner.toLowerCase()}`
  const checkpoint = await readMiningSyncCheckpoint(syncKey)
  const fromBlock = checkpoint > 0n ? checkpoint + 1n : miningStartBlock
  if (fromBlock > latestBlock) {
    return { synced: true, claimEvents: 0, aggregateEvents: 0, fromBlock: Number(fromBlock), toBlock: Number(latestBlock) }
  }

  const [claimLogs, aggregateLogs] = await Promise.all([
    publicClient.getLogs({
      address: patrolMiner,
      event: PATROL_MINER_CLAIMED_EVENT,
      fromBlock,
      toBlock: latestBlock,
    }),
    publicClient.getLogs({
      address: patrolMiner,
      event: PATROL_MINER_AGGREGATE_CLAIMED_EVENT,
      fromBlock,
      toBlock: latestBlock,
    }),
  ])

  const logs = [
    ...claimLogs.map((log) => ({ kind: 'claim' as const, log })),
    ...aggregateLogs.map((log) => ({ kind: 'aggregate' as const, log })),
  ].sort((left, right) => {
    if (left.log.blockNumber === right.log.blockNumber) return Number(left.log.logIndex - right.log.logIndex)
    return Number(left.log.blockNumber - right.log.blockNumber)
  })

  for (const entry of logs) {
    if (!entry.log.transactionHash) continue

    if (entry.kind === 'claim') {
      await markWinnerClaimed(Number(entry.log.args.blockNumber), entry.log.transactionHash)
      continue
    }

    const bucketIds = entry.log.args.bucketIds.map((value) => Number(value))
    const settledRounds = entry.log.args.settledRounds.map((value) => Number(value))
    await markAggregateClaimed(entry.log.args.winner, bucketIds, settledRounds, entry.log.transactionHash)
  }

  await writeMiningSyncCheckpoint(syncKey, latestBlock)

  return {
    synced: true,
    claimEvents: claimLogs.length,
    aggregateEvents: aggregateLogs.length,
    fromBlock: Number(fromBlock),
    toBlock: Number(latestBlock),
  }
}

export async function syncClaimSettlementsCached() {
  const now = Date.now()
  if (claimSyncCache && claimSyncCache.expiresAt > now) return claimSyncCache.value
  if (claimSyncInFlight) return claimSyncInFlight

  claimSyncInFlight = syncClaimSettlements()
    .then((value) => {
      claimSyncCache = { value, expiresAt: Date.now() + CLAIM_SYNC_CACHE_MS }
      return value
    })
    .finally(() => {
      claimSyncInFlight = null
    })

  return claimSyncInFlight
}