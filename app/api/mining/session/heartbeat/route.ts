import { NextRequest, NextResponse } from 'next/server'
import type { QueryResultRow } from 'pg'
import { miningQuery } from '@/lib/mining-db'
import {
  createMiningChallenge,
  getPendingChallenge,
  readActiveBlacklist,
  readSessionByTokenHash,
  serializeMiningSession,
  stopSession,
  sweepMiningState,
} from '@/lib/mining-control'
import { isAdminStartRequired, readPatrolMinerAvailability } from '@/lib/patrol-miner-status'
import { getClientIp, checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import {
  hashMiningSessionToken,
  MINING_INACTIVE_AFTER_SECONDS,
  MINING_SESSION_COOKIE,
  secondsUntil,
} from '@/lib/mining-session'

export const runtime = 'nodejs'

interface SessionRow extends QueryResultRow {
  id: string
  wallet: string
  connected_at: Date
  last_heartbeat_at: Date
  warmup_until: Date
  active: boolean
  status: 'active' | 'challenge_pending' | 'stopped'
  stop_reason: null
  stopped_at: null
  next_challenge_at: Date | null
  mining_locked_until: Date | null
  challenge_failure_streak: number | null
}

export async function POST(request: NextRequest) {
  const ip = getClientIp(request)
  const rate = checkRateLimit(`mining-heartbeat:${ip}`, 60, 60_000)
  if (!rate.allowed) return rateLimitResponse(rate.retryAfterMs)

  const token = request.cookies.get(MINING_SESSION_COOKIE)?.value
  if (!token) return NextResponse.json({ error: 'Mining session cookie missing' }, { status: 401 })

  try {
    await sweepMiningState()

    const tokenHash = hashMiningSessionToken(token)
    const current = await readSessionByTokenHash(tokenHash)
    if (!current) return NextResponse.json({ error: 'Mining session not found' }, { status: 401 })

    if (!current.active || current.status === 'stopped') {
      return NextResponse.json({ ok: true, session: serializeMiningSession(current) })
    }

    const availability = await readPatrolMinerAvailability()
    if (!availability.ok) {
      if (isAdminStartRequired(availability.reason)) {
        const stopped = await stopSession(current.id, 'mining_not_started')
        return NextResponse.json({
          ok: false,
          reason: availability.reason,
          error: availability.error,
          session: serializeMiningSession(stopped ?? current),
        })
      }

      return NextResponse.json({
        ok: false,
        reason: availability.reason,
        error: availability.error,
        session: serializeMiningSession(current),
      }, { status: availability.status })
    }

    const blacklist = await readActiveBlacklist(current.wallet)
    if (blacklist) {
      const stopped = await stopSession(current.id, 'blacklisted')
      return NextResponse.json({ ok: true, session: serializeMiningSession(stopped ?? current) })
    }

    if (current.last_heartbeat_at < new Date(Date.now() - MINING_INACTIVE_AFTER_SECONDS * 1000)) {
      const stopped = await stopSession(current.id, 'heartbeat_timeout')
      return NextResponse.json({ ok: true, session: serializeMiningSession(stopped ?? current) })
    }

    const result = await miningQuery<SessionRow>(
      `update mining_sessions
      set last_heartbeat_at = now(), active = true, last_ip = $2, updated_at = now()
      where session_token_hash = $1 and active = true
      returning id, wallet, connected_at, last_heartbeat_at, warmup_until, active, status, stop_reason, stopped_at, next_challenge_at,
        null::timestamptz as mining_locked_until,
        null::int as challenge_failure_streak`,
      [tokenHash, ip],
    )

    const session = result.rows[0]
    if (!session) return NextResponse.json({ error: 'Mining session not found' }, { status: 401 })

    await miningQuery(
      `update mining_accounts
      set last_seen_at = now(), updated_at = now()
      where lower(wallet) = lower($1)`,
      [session.wallet],
    )

    const pending = await getPendingChallenge(session.id)
    if (pending) return NextResponse.json({ ok: true, session: serializeMiningSession(session, pending) })

    const warmupRemainingSeconds = secondsUntil(session.warmup_until)
    if (warmupRemainingSeconds === 0 && session.next_challenge_at && session.next_challenge_at <= new Date()) {
      const challenge = await createMiningChallenge(session.id, session.wallet)
      return NextResponse.json({ ok: true, session: serializeMiningSession({ ...session, status: 'challenge_pending' }, challenge) })
    }

    return NextResponse.json({
      ok: true,
      session: serializeMiningSession(session),
    })
  } catch (error) {
    console.error('mining/session/heartbeat failed:', error)
    const message = error instanceof Error ? error.message : 'Mining session database unavailable'
    return NextResponse.json({ error: message }, { status: 503 })
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204 })
}