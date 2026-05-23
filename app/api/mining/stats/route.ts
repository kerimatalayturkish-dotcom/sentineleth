import { NextResponse } from 'next/server'
import type { QueryResultRow } from 'pg'
import { createPublicClient, formatEther, http } from 'viem'
import { miningQuery } from '@/lib/mining-db'
import { miningChain, miningPublicConfig } from '@/lib/mining-config'
import { readMiningWinnerStats, syncClaimSettlementsCached } from '@/lib/mining-winner'
import { getOptionalMiningServerConfig } from '@/lib/mining-server-config'
import { PATROL_MINER_ABI } from '@/lib/mining-contracts'
import { sweepMiningState } from '@/lib/mining-control'
import { MINING_INACTIVE_AFTER_SECONDS } from '@/lib/mining-session'

export const runtime = 'nodejs'

interface ActiveStatsRow extends QueryResultRow {
  active_miners: number
  active_power: string
}

const PATROL_MINER_STATUS_CACHE_MS = 5_000

let patrolMinerStatusCache: {
  expiresAt: number
  value: Awaited<ReturnType<typeof readPatrolMinerStatus>>
} | null = null

async function readActiveStats() {
  const result = await miningQuery<ActiveStatsRow>(
    `with active_wallets as (
      select lower(wallet) as wallet
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
      group by lower(wallet)
    )
    select
      count(active_wallets.wallet)::int as active_miners,
      coalesce(sum(coalesce(power.wallet_power, 0)), 0)::text as active_power
    from active_wallets
    left join mining_power_cache power
      on lower(power.wallet) = active_wallets.wallet
      and power.status = 'ready'
      and (power.expires_at is null or power.expires_at > now())`,
    [MINING_INACTIVE_AFTER_SECONDS],
  )

  return result.rows[0] ?? { active_miners: 0, active_power: '0' }
}

async function readPatrolMinerStatus() {
  const config = getOptionalMiningServerConfig()
  const patrolMiner = config.miningChain.contracts.patrolMiner
  const rpcUrl = config.miningChain.rpcUrl

  if (!rpcUrl) {
    return {
      configured: Boolean(patrolMiner),
      address: patrolMiner ?? null,
      currentBlock: null,
      started: false,
      active: false,
      error: 'MINING_RPC_URL not configured',
    }
  }

  const client = createPublicClient({ chain: miningChain, transport: http(rpcUrl) })
  const currentBlock = Number(await client.getBlockNumber())

  if (!patrolMiner) {
    return {
      configured: false,
      address: null,
      currentBlock,
      started: false,
      active: false,
      error: 'NEXT_PUBLIC_PATROL_MINER_ADDRESS not configured',
    }
  }

  try {
    const [miningStartBlock, active, mined, mineableSupply, rewardedRounds, maxRewardRounds, blockReward] = await Promise.all([
      client.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: 'miningStartBlock' }),
      client.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: 'miningActive' }),
      client.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: 'mined' }),
      client.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: 'MINEABLE_SUPPLY' }),
      client.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: 'rewardedRounds' }),
      client.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: 'MAX_REWARD_ROUNDS' }),
      client.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: 'BLOCK_REWARD' }),
    ])

    return {
      configured: true,
      address: patrolMiner,
      currentBlock,
      startBlock: miningStartBlock === 0n ? null : Number(miningStartBlock),
      started: miningStartBlock !== 0n,
      active,
      mined: formatEther(mined),
      mineableSupply: formatEther(mineableSupply),
      rewardedRounds: Number(rewardedRounds),
      maxRewardRounds: Number(maxRewardRounds),
      blockReward: formatEther(blockReward),
      error: null,
    }
  } catch (error) {
    return {
      configured: true,
      address: patrolMiner,
      currentBlock,
      started: false,
      active: false,
      error: error instanceof Error ? error.message : 'PatrolMiner status unavailable',
    }
  }
}

async function readCachedPatrolMinerStatus() {
  const now = Date.now()
  if (patrolMinerStatusCache && patrolMinerStatusCache.expiresAt > now) {
    return patrolMinerStatusCache.value
  }

  const value = await readPatrolMinerStatus()
  patrolMinerStatusCache = { value, expiresAt: now + PATROL_MINER_STATUS_CACHE_MS }
  return value
}

export async function GET() {
  try {
    await sweepMiningState().catch((error) => console.error('mining/stats sweep failed:', error.message))
  } catch (e) {
    console.error('Sweep completely failed:', e)
  }

  await syncClaimSettlementsCached().catch(() => undefined)

  const [activeStatsResult, patrolMinerResult, winnerStatsResult] = await Promise.allSettled([
    readActiveStats(),
    readCachedPatrolMinerStatus(),
    readMiningWinnerStats(),
  ])

  const activeStats = activeStatsResult.status === 'fulfilled'
    ? activeStatsResult.value
    : { active_miners: 0, active_power: '0' }
  const winnerStats = winnerStatsResult.status === 'fulfilled'
    ? winnerStatsResult.value
    : { totalWins: 0, claimedWins: 0, pendingWins: 0 }
  const databaseErrors = [activeStatsResult, winnerStatsResult]
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason instanceof Error ? result.reason.message : 'Mining database unavailable')
  const databaseError = databaseErrors[0] ?? null

  const patrolMiner = patrolMinerResult.status === 'fulfilled'
    ? patrolMinerResult.value
    : {
      configured: false,
      address: null,
      currentBlock: null,
      started: false,
      active: false,
      error: patrolMinerResult.reason instanceof Error ? patrolMinerResult.reason.message : 'PatrolMiner status unavailable',
    }

  return NextResponse.json({
    chain: {
      deployment: miningPublicConfig.deployment,
      miningChainId: miningPublicConfig.miningChain.chainId,
      miningChainName: miningPublicConfig.miningChain.name,
      nftSourceChainId: miningPublicConfig.nftSource.chainId,
      nftSourceChainName: miningPublicConfig.nftSource.name,
    },
    activeMiners: activeStats.active_miners,
    activePower: activeStats.active_power,
    inactiveAfterSeconds: MINING_INACTIVE_AFTER_SECONDS,
    database: {
      configured: databaseError === null,
      error: databaseError,
    },
    patrolMiner,
    winnerStats,
  })
}