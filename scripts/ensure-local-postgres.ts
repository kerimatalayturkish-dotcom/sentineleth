import { ensureLocalPostgresForDatabaseUrl, readLocalPostgresReadiness } from '../lib/local-postgres'

function getDatabaseUrl(): string {
  const databaseUrl = process.env.MINING_DATABASE_URL || process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('MINING_DATABASE_URL or DATABASE_URL is required')
  return databaseUrl
}

async function main() {
  const command = process.argv[2] || 'start'
  const databaseUrl = getDatabaseUrl()

  if (command === 'status') {
    const status = await readLocalPostgresReadiness(databaseUrl)
    if (!status.autoStartable) {
      console.log('Mining database is not the managed local Postgres instance; skipping local status check.')
      return
    }

    console.log(`Local mining Postgres is ${status.ready ? 'listening' : 'stopped'} on ${status.host}:${status.port}`)
    process.exitCode = status.ready ? 0 : 1
    return
  }

  if (command !== 'start' && command !== 'ensure') {
    throw new Error(`Unknown command: ${command}`)
  }

  const result = await ensureLocalPostgresForDatabaseUrl(databaseUrl, { verbose: true })
  if (result.status === 'skipped') {
    console.log('Mining database is not the managed local Postgres instance; skipping local start.')
    return
  }

  if (result.status === 'ready') {
    console.log(`Local mining Postgres is already listening on ${result.host}:${result.port}`)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})