import { setTimeout as delay } from 'node:timers/promises'
import { ensureLocalPostgresForDatabaseUrl } from '../lib/local-postgres'
import { getMiningDatabaseUrl } from '../lib/mining-db'
import { refreshActiveMiningPowers } from '../lib/mining-power'
import { syncClaimSettlements, syncMiningBlockOutcomes } from '../lib/mining-winner'

const args = new Set(process.argv.slice(2))
const loop = args.has('--loop')
const intervalMs = Number(process.env.MINING_WORKER_INTERVAL_MS || '12000')

async function tick() {
  const claims = await syncClaimSettlements()
  const power = await refreshActiveMiningPowers()
  const outcomes = await syncMiningBlockOutcomes()
  return { claims, power, outcomes }
}

async function main() {
  const databaseUrl = getMiningDatabaseUrl()
  if (databaseUrl) await ensureLocalPostgresForDatabaseUrl(databaseUrl, { verbose: true })

  if (!loop) {
    const result = await tick()
    console.log(JSON.stringify(result, null, 2))
    return
  }

  for (;;) {
    try {
      const result = await tick()
      console.log(`[${new Date().toISOString()}]`, JSON.stringify(result))
    } catch (error) {
      console.error(`[${new Date().toISOString()}] mining worker tick failed:`, error instanceof Error ? error.message : error)
    }
    await delay(intervalMs)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})