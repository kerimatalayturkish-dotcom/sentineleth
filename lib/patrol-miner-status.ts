import { createPublicClient, http } from 'viem'
import { miningChain } from '@/lib/mining-config'
import { PATROL_MINER_ABI } from '@/lib/mining-contracts'
import { getOptionalMiningServerConfig } from '@/lib/mining-server-config'

export type PatrolMinerAvailabilityReason =
  | 'active'
  | 'not_configured'
  | 'rpc_not_configured'
  | 'not_started'
  | 'inactive'
  | 'unavailable'

export interface PatrolMinerAvailability {
  ok: boolean
  reason: PatrolMinerAvailabilityReason
  status: number
  error: string | null
  started: boolean
  active: boolean
  startBlock: number | null
}

export async function readPatrolMinerAvailability(): Promise<PatrolMinerAvailability> {
  const config = getOptionalMiningServerConfig()
  const patrolMiner = config.miningChain.contracts.patrolMiner
  const rpcUrl = config.miningChain.rpcUrl

  if (!patrolMiner) {
    return {
      ok: false,
      reason: 'not_configured',
      status: 503,
      error: 'PatrolMiner is not configured',
      started: false,
      active: false,
      startBlock: null,
    }
  }

  if (!rpcUrl) {
    return {
      ok: false,
      reason: 'rpc_not_configured',
      status: 503,
      error: 'MINING_RPC_URL is not configured',
      started: false,
      active: false,
      startBlock: null,
    }
  }

  try {
    const client = createPublicClient({ chain: miningChain, transport: http(rpcUrl) })
    const [miningStartBlock, active] = await Promise.all([
      client.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: 'miningStartBlock' }),
      client.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: 'miningActive' }),
    ])
    const started = miningStartBlock !== 0n
    const startBlock = started ? Number(miningStartBlock) : null

    if (!started) {
      return {
        ok: false,
        reason: 'not_started',
        status: 200,
        error: 'Mining has not been started by admin yet',
        started,
        active: false,
        startBlock,
      }
    }

    if (!active) {
      return {
        ok: false,
        reason: 'inactive',
        status: 200,
        error: 'Mining is not active',
        started,
        active: false,
        startBlock,
      }
    }

    return {
      ok: true,
      reason: 'active',
      status: 200,
      error: null,
      started,
      active,
      startBlock,
    }
  } catch (error) {
    return {
      ok: false,
      reason: 'unavailable',
      status: 503,
      error: error instanceof Error ? error.message.split('\n')[0] : 'PatrolMiner status unavailable',
      started: false,
      active: false,
      startBlock: null,
    }
  }
}

export function isAdminStartRequired(reason: PatrolMinerAvailabilityReason): boolean {
  return reason === 'not_started' || reason === 'inactive'
}