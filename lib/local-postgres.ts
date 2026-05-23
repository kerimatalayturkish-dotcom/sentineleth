import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const LOCAL_MINING_POSTGRES_PORT = 55432
const DEFAULT_READY_CACHE_MS = 1_000
const DEFAULT_CONNECT_TIMEOUT_MS = 700
const DEFAULT_START_TIMEOUT_MS = 30_000

export type LocalPostgresEnsureStatus = 'skipped' | 'ready' | 'started'

export interface LocalPostgresEnsureResult {
  status: LocalPostgresEnsureStatus
  host?: string
  port?: number
  dataDir?: string
  logFile?: string
}

export interface LocalPostgresReadiness {
  autoStartable: boolean
  ready: boolean
  host?: string
  port?: number
}

interface ParsedLocalDatabaseUrl {
  host: string
  port: number
}

interface LocalPostgresSettings {
  pgCtlPath: string
  dataDir: string
  logFile: string
}

let ensurePromise: Promise<LocalPostgresEnsureResult> | undefined
let lastReadyAt = 0

function getLocalAppDataDir(): string {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
}

function getLocalPostgresSettings(): LocalPostgresSettings {
  const baseDir = process.env.LOCAL_POSTGRES_BASE_DIR || path.join(getLocalAppDataDir(), 'sentineleth-postgres')
  return {
    pgCtlPath: process.env.LOCAL_POSTGRES_PG_CTL || 'C:\\Program Files\\PostgreSQL\\17\\bin\\pg_ctl.exe',
    dataDir: process.env.LOCAL_POSTGRES_DATA_DIR || path.join(baseDir, 'data'),
    logFile: process.env.LOCAL_POSTGRES_LOG_FILE || path.join(baseDir, 'postgres.log'),
  }
}

function parseDatabaseUrl(databaseUrl: string): ParsedLocalDatabaseUrl | undefined {
  try {
    const parsed = new URL(databaseUrl)
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    const port = Number(parsed.port || '5432')
    return { host, port }
  } catch {
    return undefined
  }
}

function isLocalhost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

function getConnectionHost(host: string): string {
  return host === 'localhost' || host === '::1' ? '127.0.0.1' : host
}

function getReadyCacheMs(): number {
  const parsed = Number(process.env.LOCAL_POSTGRES_READY_CACHE_MS || DEFAULT_READY_CACHE_MS.toString())
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_READY_CACHE_MS
}

export function isAutoStartableLocalPostgres(databaseUrl: string): boolean {
  const parsed = parseDatabaseUrl(databaseUrl)
  return Boolean(process.platform === 'win32' && parsed && isLocalhost(parsed.host) && parsed.port === LOCAL_MINING_POSTGRES_PORT)
}

async function isPortListening(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false

    const finish = (ready: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ready)
    }

    socket.setTimeout(DEFAULT_CONNECT_TIMEOUT_MS)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.connect(port, getConnectionHost(host))
  })
}

async function requirePath(filePath: string, label: string): Promise<void> {
  try {
    await access(filePath, fsConstants.F_OK)
  } catch {
    throw new Error(`Cannot auto-start local Postgres: ${label} not found at ${filePath}`)
  }
}

function runPgCtl(pgCtlPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(pgCtlPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const stdout: string[] = []
    const stderr: string[] = []
    let settled = false

    const timeout = setTimeout(() => {
      finish(new Error(`pg_ctl ${args[0]} timed out after ${DEFAULT_START_TIMEOUT_MS}ms`))
      child.kill()
    }, DEFAULT_START_TIMEOUT_MS)

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.stdout?.destroy()
      child.stderr?.destroy()
      if (error) {
        reject(error)
        return
      }
      resolve()
    }

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()))
    child.once('error', (error) => finish(error))
    child.once('exit', (exitCode) => {
      if (exitCode === 0) {
        finish()
        return
      }

      const output = [stdout.join('').trim(), stderr.join('').trim()].filter(Boolean).join('\n')
      finish(new Error(`pg_ctl ${args[0]} failed with exit code ${exitCode}${output ? `: ${output}` : ''}`))
    })
  })
}

async function waitForPostgres(host: string, port: number): Promise<boolean> {
  const deadline = Date.now() + DEFAULT_START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await isPortListening(host, port)) return true
    await delay(500)
  }
  return false
}

async function startLocalPostgres(databaseUrl: string, verbose: boolean): Promise<LocalPostgresEnsureResult> {
  const parsed = parseDatabaseUrl(databaseUrl)
  if (!parsed || !isAutoStartableLocalPostgres(databaseUrl)) return { status: 'skipped' }

  const readyCacheMs = getReadyCacheMs()
  if (readyCacheMs > 0 && Date.now() - lastReadyAt < readyCacheMs) {
    return { status: 'ready', host: parsed.host, port: parsed.port }
  }

  if (await isPortListening(parsed.host, parsed.port)) {
    lastReadyAt = Date.now()
    return { status: 'ready', host: parsed.host, port: parsed.port }
  }

  const settings = getLocalPostgresSettings()
  await requirePath(settings.pgCtlPath, 'pg_ctl')
  await requirePath(settings.dataDir, 'data directory')
  await mkdir(path.dirname(settings.logFile), { recursive: true })

  if (verbose) console.log(`Starting local mining Postgres on ${parsed.host}:${parsed.port}`)

  await runPgCtl(settings.pgCtlPath, [
    'start',
    '-D',
    settings.dataDir,
    '-l',
    settings.logFile,
    '-o',
    `-p ${parsed.port}`,
  ])

  if (!(await waitForPostgres(parsed.host, parsed.port))) {
    throw new Error(`Local Postgres did not become ready on ${parsed.host}:${parsed.port}; see ${settings.logFile}`)
  }

  lastReadyAt = Date.now()
  if (verbose) console.log(`Local mining Postgres is ready on ${parsed.host}:${parsed.port}`)

  return {
    status: 'started',
    host: parsed.host,
    port: parsed.port,
    dataDir: settings.dataDir,
    logFile: settings.logFile,
  }
}

export async function ensureLocalPostgresForDatabaseUrl(
  databaseUrl: string,
  options: { verbose?: boolean } = {},
): Promise<LocalPostgresEnsureResult> {
  if (!isAutoStartableLocalPostgres(databaseUrl)) return { status: 'skipped' }
  if (!ensurePromise) {
    ensurePromise = startLocalPostgres(databaseUrl, Boolean(options.verbose)).finally(() => {
      ensurePromise = undefined
    })
  }
  return ensurePromise
}

export async function readLocalPostgresReadiness(databaseUrl: string): Promise<LocalPostgresReadiness> {
  const parsed = parseDatabaseUrl(databaseUrl)
  const autoStartable = isAutoStartableLocalPostgres(databaseUrl)
  if (!parsed || !autoStartable) return { autoStartable: false, ready: false }
  return {
    autoStartable,
    ready: await isPortListening(parsed.host, parsed.port),
    host: parsed.host,
    port: parsed.port,
  }
}