import { NextRequest, NextResponse } from 'next/server'
import type { QueryResultRow } from 'pg'
import { miningQuery } from '@/lib/mining-db'
import { getNextMiningChallengeDelaySeconds } from '@/lib/mining-challenge'
import { readActiveBlacklist, serializeMiningSession, stopSessionWithChallengePenalty, sweepMiningState } from '@/lib/mining-control'
import { refreshMiningPowerForWallets } from '@/lib/mining-power'
import { readPatrolMinerAvailability } from '@/lib/patrol-miner-status'
import { getClientIp, checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { readJsonBody } from '@/lib/safe-body'
import {
  createMiningSessionToken,
  hashMiningSessionToken,
  isProductionCookie,
  MINING_SESSION_COOKIE,
  MINING_SESSION_TTL_SECONDS,
  MINING_WARMUP_SECONDS,
  normalizeWallet,
  secondsUntil,
} from '@/lib/mining-session'

export const runtime = 'nodejs'

interface Body {
  wallet?: unknown
}

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
  challenge_failure_streak: number
}

interface AccountRow extends QueryResultRow {
  mining_locked_until: Date | null
  challenge_failure_streak: number
}

interface PendingChallengeSessionRow extends QueryResultRow {
  session_id: string
  challenge_id: string
  wallet: string
}

export async function POST(request: NextRequest) {
  const ip = getClientIp(request)
  const rate = checkRateLimit(`mining-connect:${ip}`, 20, 60_000)
  if (!rate.allowed) return rateLimitResponse(rate.retryAfterMs)

  const parsed = await readJsonBody<Body>(request)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status })

  const wallet = normalizeWallet(parsed.body.wallet)
  if (!wallet) return NextResponse.json({ error: 'wallet must be a valid address' }, { status: 400 })

  const token = createMiningSessionToken()
  const tokenHash = hashMiningSessionToken(token)
  const userAgent = request.headers.get('user-agent')?.slice(0, 500) ?? null

  try {
    const availability = await readPatrolMinerAvailability()
    if (!availability.ok) {
      return NextResponse.json({
        ok: false,
        reason: availability.reason,
        error: availability.error,
        patrolMiner: {
          started: availability.started,
          active: availability.active,
          startBlock: availability.startBlock,
        },
      }, { status: availability.status })
    }

    await sweepMiningState()

    const blacklist = await readActiveBlacklist(wallet)
    if (blacklist) {
      return NextResponse.json({
        ok: false,
        reason: 'blacklisted',
        error: blacklist.reason,
        retryAt: blacklist.expires_at?.toISOString() ?? null,
        retryInSeconds: secondsUntil(blacklist.expires_at),
      })
    }

    const accountResult = await miningQuery<AccountRow>(
      `insert into mining_accounts (wallet, first_seen_at, last_seen_at, updated_at)
      values ($1, now(), now(), now())
      on conflict (wallet) do update
      set last_seen_at = now(), updated_at = now()
      returning mining_locked_until, challenge_failure_streak`,
      [wallet],
    )
    const account = accountResult.rows[0]
    if (account?.mining_locked_until && account.mining_locked_until > new Date()) {
      const response = NextResponse.json({
        ok: false,
        reason: 'mining_locked',
        error: 'Mining is cooling down after a failed challenge',
        retryAt: account.mining_locked_until.toISOString(),
        retryInSeconds: secondsUntil(account.mining_locked_until),
        challengeFailureStreak: account.challenge_failure_streak,
      })
      clearMiningCookie(response)
      return response
    }

    const pendingSessionResult = await miningQuery<PendingChallengeSessionRow>(
      `select s.id as session_id, c.id as challenge_id, s.wallet
      from mining_sessions s
      join mining_challenges c on c.session_id = s.id and c.status = 'issued'
      where lower(s.wallet) = lower($1)
        and s.active = true
      order by c.issued_at desc
      limit 1`,
      [wallet],
    )
    const pendingSession = pendingSessionResult.rows[0]
    if (pendingSession) {
      const penalizedAccount = await stopSessionWithChallengePenalty({
        sessionId: pendingSession.session_id,
        challengeId: pendingSession.challenge_id,
        wallet: pendingSession.wallet,
        challengeStatus: 'failed',
        stopReason: 'challenge_failed',
      })

      const response = NextResponse.json({
        ok: false,
        reason: 'mining_locked',
        error: 'Disconnecting or reconnecting during a pending challenge counts as a failed challenge',
        retryAt: penalizedAccount.mining_locked_until?.toISOString() ?? null,
        retryInSeconds: secondsUntil(penalizedAccount.mining_locked_until),
        challengeFailureStreak: penalizedAccount.challenge_failure_streak,
      })
      clearMiningCookie(response)
      return response
    }

    await miningQuery(
      `update mining_sessions
      set active = false,
        status = 'stopped',
        stop_reason = 'replaced',
        stopped_at = coalesce(stopped_at, now()),
        updated_at = now()
      where lower(wallet) = lower($1) and active = true`,
      [wallet],
    )

    const result = await miningQuery<SessionRow>(
      `insert into mining_sessions (
        wallet,
        session_token_hash,
        connected_at,
        last_heartbeat_at,
        warmup_until,
        active,
        status,
        next_challenge_at,
        last_ip,
        user_agent
      ) values (
        $1,
        $2,
        now(),
        now(),
        now() + ($3::int * interval '1 second'),
        true,
        'active',
        now() + (($3 + $4)::int * interval '1 second'),
        $5,
        $6
      )
      returning id, wallet, connected_at, last_heartbeat_at, warmup_until, active, status, stop_reason, stopped_at, next_challenge_at,
        null::timestamptz as mining_locked_until,
        $7::int as challenge_failure_streak`,
      [
        wallet,
        tokenHash,
        MINING_WARMUP_SECONDS,
        getNextMiningChallengeDelaySeconds(),
        ip,
        userAgent,
        account?.challenge_failure_streak ?? 0,
      ],
    )

    await miningQuery(
      `update mining_accounts
      set last_session_started_at = now(),
        last_session_end_reason = null,
        last_seen_at = now(),
        updated_at = now()
      where lower(wallet) = lower($1)`,
      [wallet],
    )

    await refreshMiningPowerForWallets([wallet])

    const session = result.rows[0]
    const response = NextResponse.json({
      ok: true,
      session: serializeMiningSession(session),
    })

    response.cookies.set(MINING_SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProductionCookie(),
      path: '/',
      maxAge: MINING_SESSION_TTL_SECONDS,
    })

    return response
  } catch (error) {
    console.error('mining/session/connect failed:', error)
    const message = error instanceof Error ? error.message : 'Mining session database unavailable'
    return NextResponse.json({ error: message }, { status: 503 })
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204 })
}

function clearMiningCookie(response: NextResponse) {
  response.cookies.set(MINING_SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProductionCookie(),
    path: '/',
    maxAge: 0,
  })
}