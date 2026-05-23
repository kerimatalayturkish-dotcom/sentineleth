import { Pool, type PoolClient, type QueryResultRow } from 'pg'
import { resolveDatabaseSsl } from '@/lib/database-ssl'
import { ensureLocalPostgresForDatabaseUrl } from '@/lib/local-postgres'
import { getOptionalMiningServerConfig } from '@/lib/mining-server-config'

type GlobalWithMiningPool = typeof globalThis & {
  __sentiMiningPool?: Pool
}

const globalForMiningDb = globalThis as GlobalWithMiningPool

export function getMiningDatabaseUrl(): string | undefined {
  return getOptionalMiningServerConfig().databaseUrl
}

async function prepareMiningDatabase(databaseUrl: string): Promise<void> {
  const result = await ensureLocalPostgresForDatabaseUrl(databaseUrl)
  if (result.status === 'started' && globalForMiningDb.__sentiMiningPool) {
    await globalForMiningDb.__sentiMiningPool.end().catch(() => undefined)
    globalForMiningDb.__sentiMiningPool = undefined
  }
}

export function getMiningPool(): Pool {
  const databaseUrl = getMiningDatabaseUrl()
  if (!databaseUrl) throw new Error('MINING_DATABASE_URL or DATABASE_URL is not configured')

  if (!globalForMiningDb.__sentiMiningPool) {
    globalForMiningDb.__sentiMiningPool = new Pool({
      connectionString: databaseUrl,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: resolveDatabaseSsl(databaseUrl, process.env.MINING_DATABASE_SSL_MODE || process.env.PGSSLMODE),
    })
  }

  return globalForMiningDb.__sentiMiningPool
}

export async function miningQuery<T extends QueryResultRow>(text: string, values: unknown[] = []) {
  const databaseUrl = getMiningDatabaseUrl()
  if (!databaseUrl) throw new Error('MINING_DATABASE_URL or DATABASE_URL is not configured')
  await prepareMiningDatabase(databaseUrl)
  return getMiningPool().query<T>(text, values)
}

export async function withMiningTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const databaseUrl = getMiningDatabaseUrl()
  if (!databaseUrl) throw new Error('MINING_DATABASE_URL or DATABASE_URL is not configured')
  await prepareMiningDatabase(databaseUrl)
  const client = await getMiningPool().connect()
  try {
    await client.query('begin')
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}