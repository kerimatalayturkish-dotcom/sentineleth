import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { Pool } from 'pg'
import { resolveDatabaseSsl } from '../lib/database-ssl'
import { ensureLocalPostgresForDatabaseUrl } from '../lib/local-postgres'

function getDatabaseUrl() {
  const databaseUrl = process.env.MINING_DATABASE_URL || process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('MINING_DATABASE_URL or DATABASE_URL is required')
  return databaseUrl
}

async function resolveMigrationPaths(args: string[]) {
  if (args.length > 0) {
    return args.map((migrationPath) => path.resolve(migrationPath))
  }

  const migrationsDir = path.resolve('migrations')
  const entries = await readdir(migrationsDir, { withFileTypes: true })

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => path.join(migrationsDir, entry.name))
    .sort((left, right) => left.localeCompare(right))
}

async function main() {
  const migrationPaths = await resolveMigrationPaths(process.argv.slice(2))
  if (migrationPaths.length === 0) throw new Error('No mining migrations found')

  const databaseUrl = getDatabaseUrl()
  await ensureLocalPostgresForDatabaseUrl(databaseUrl, { verbose: true })
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: resolveDatabaseSsl(databaseUrl, process.env.MINING_DATABASE_SSL_MODE || process.env.PGSSLMODE),
  })

  try {
    for (const migrationPath of migrationPaths) {
      const sql = await readFile(migrationPath, 'utf8')
      await pool.query(sql)
      console.log(`Applied mining migration: ${path.relative(process.cwd(), migrationPath)}`)
    }
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})