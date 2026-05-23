import { createHash, randomBytes } from 'crypto'
import { getAddress, isAddress, type Address } from 'viem'

export const MINING_SESSION_COOKIE = 'senti_mining_session'
export const MINING_SESSION_TTL_SECONDS = 60 * 60 * 24
export const MINING_WARMUP_SECONDS = 60
export const MINING_HEARTBEAT_SECONDS = 10
export const MINING_INACTIVE_AFTER_SECONDS = 90
export const MINING_POWER_REFRESH_SECONDS = 60
export const MINING_POWER_CACHE_TTL_SECONDS = 120
export const MINING_CHALLENGE_MIN_SECONDS = 1 * 60
export const MINING_CHALLENGE_MAX_SECONDS = 2 * 60
export const MINING_CHALLENGE_ANSWER_SECONDS = 60
export const MINING_LOCK_BASE_MINUTES = 5
export const MINING_LOCK_MAX_MINUTES = 24 * 60
export const MINING_SESSION_CLEANUP_DAYS = 7

export type MiningSessionStatus = 'warming_up' | 'active' | 'challenge_pending' | 'stopped'
export type MiningStopReason =
  | 'manual_stop'
  | 'challenge_failed'
  | 'challenge_expired'
  | 'heartbeat_timeout'
  | 'blacklisted'
  | 'replaced'
  | 'mining_locked'
  | 'mining_not_started'

export function normalizeWallet(value: unknown): Address | null {
  if (typeof value !== 'string' || !isAddress(value)) return null
  return getAddress(value) as Address
}

export function createMiningSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashMiningSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function secondsUntil(value: Date | string | null | undefined): number {
  if (!value) return 0
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return 0
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1000))
}

export function isProductionCookie(): boolean {
  return process.env.NODE_ENV === 'production'
}

export function challengeLockMinutesForFailureStreak(streak: number): number {
  if (streak <= 0) return 0
  if (streak === 1) return MINING_LOCK_BASE_MINUTES
  if (streak === 2) return MINING_LOCK_BASE_MINUTES ** 2
  if (streak === 3) return MINING_LOCK_BASE_MINUTES ** 3
  return MINING_LOCK_MAX_MINUTES
}