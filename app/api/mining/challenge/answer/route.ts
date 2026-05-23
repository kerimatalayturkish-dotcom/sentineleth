import { NextRequest, NextResponse } from 'next/server'
import type { QueryResultRow } from 'pg'
import { miningQuery } from '@/lib/mining-db'
import {
  markChallengePassed,
  readSessionByTokenHash,
  serializeMiningSession,
  stopSessionWithChallengePenalty,
} from '@/lib/mining-control'
import { verifyMiningChallengeAnswer } from '@/lib/mining-challenge'
import { getClientIp, checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { readJsonBody } from '@/lib/safe-body'
import {
  hashMiningSessionToken,
  isProductionCookie,
  MINING_SESSION_COOKIE,
} from '@/lib/mining-session'

export const runtime = 'nodejs'

interface Body {
  challengeId?: unknown
  answer?: unknown
}

interface ChallengeSecretRow extends QueryResultRow {
  id: string
  session_id: string
  wallet: string
  answer_salt: string
  expected_answer_hash: string
  expires_at: Date
}

export async function POST(request: NextRequest) {
  const ip = getClientIp(request)
  const rate = checkRateLimit(`mining-challenge-answer:${ip}`, 30, 60_000)
  if (!rate.allowed) return rateLimitResponse(rate.retryAfterMs)

  const token = request.cookies.get(MINING_SESSION_COOKIE)?.value
  if (!token) return NextResponse.json({ error: 'Mining session cookie missing' }, { status: 401 })

  const parsed = await readJsonBody<Body>(request)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status })

  const challengeId = typeof parsed.body.challengeId === 'string' ? parsed.body.challengeId : ''
  const answer = typeof parsed.body.answer === 'string' ? parsed.body.answer : ''
  if (!challengeId) return NextResponse.json({ error: 'challengeId is required' }, { status: 400 })
  if (!answer.trim()) return NextResponse.json({ error: 'answer is required' }, { status: 400 })

  try {
    const tokenHash = hashMiningSessionToken(token)
    const session = await readSessionByTokenHash(tokenHash)
    if (!session || !session.active) return NextResponse.json({ error: 'Mining session not active' }, { status: 401 })

    const challengeResult = await miningQuery<ChallengeSecretRow>(
      `select id, session_id, wallet, answer_salt, expected_answer_hash, expires_at
      from mining_challenges
      where id = $1
        and session_id = $2
        and status = 'issued'
      limit 1`,
      [challengeId, session.id],
    )
    const challenge = challengeResult.rows[0]
    if (!challenge) return NextResponse.json({ error: 'Challenge not found' }, { status: 404 })

    if (challenge.expires_at <= new Date()) {
      const account = await stopSessionWithChallengePenalty({
        sessionId: session.id,
        challengeId: challenge.id,
        wallet: session.wallet,
        challengeStatus: 'expired',
        stopReason: 'challenge_expired',
      })
      const stopped = await readSessionByTokenHash(tokenHash)
      const response = NextResponse.json({ ok: false, reason: 'challenge_expired', session: stopped ? serializeMiningSession(stopped) : null, account })
      clearMiningCookie(response)
      return response
    }

    if (!verifyMiningChallengeAnswer(challenge.answer_salt, challenge.expected_answer_hash, answer)) {
      const account = await stopSessionWithChallengePenalty({
        sessionId: session.id,
        challengeId: challenge.id,
        wallet: session.wallet,
        challengeStatus: 'failed',
        stopReason: 'challenge_failed',
      })
      const stopped = await readSessionByTokenHash(tokenHash)
      const response = NextResponse.json({ ok: false, reason: 'challenge_failed', session: stopped ? serializeMiningSession(stopped) : null, account })
      clearMiningCookie(response)
      return response
    }

    await markChallengePassed({ sessionId: session.id, challengeId: challenge.id, wallet: session.wallet })
    const updated = await readSessionByTokenHash(tokenHash)
    return NextResponse.json({ ok: true, session: updated ? serializeMiningSession(updated) : null })
  } catch (error) {
    console.error('mining/challenge/answer failed:', error)
    const message = error instanceof Error ? error.message : 'Challenge answer failed'
    return NextResponse.json({ error: message }, { status: 503 })
  }
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

export function OPTIONS() {
  return new Response(null, { status: 204 })
}