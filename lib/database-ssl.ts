function shouldUseSsl(databaseUrl: string): boolean {
  return !/localhost|127\.0\.0\.1|\[::1\]/i.test(databaseUrl)
}

function getDatabaseSslMode(rawValue: string | undefined): 'disable' | 'require' | 'no-verify' {
  const raw = (rawValue || '').trim().toLowerCase()
  if (!raw) return 'require'
  if (raw === 'disable') return 'disable'
  if (raw === 'no-verify') return 'no-verify'
  if (raw === 'allow' || raw === 'prefer' || raw === 'require' || raw === 'verify-ca' || raw === 'verify-full') {
    return 'require'
  }

  throw new Error(`Unsupported MINING_DATABASE_SSL_MODE/PGSSLMODE: ${raw}`)
}

export function resolveDatabaseSsl(databaseUrl: string, sslMode: string | undefined) {
  if (!shouldUseSsl(databaseUrl)) return undefined

  const mode = getDatabaseSslMode(sslMode)
  if (mode === 'disable') return undefined

  return { rejectUnauthorized: mode !== 'no-verify' }
}