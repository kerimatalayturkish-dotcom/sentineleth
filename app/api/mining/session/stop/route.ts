import { NextRequest, NextResponse } from 'next/server'
import {
  getPendingChallenge,
  readSessionByTokenHash,
  serializeMiningSession,
  stopSession,
  stopSessionWithChallengePenalty,
} from '@/lib/mining-control'
import { getClientIp, checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import {
  hashMiningSessionToken,
  isProductionCookie,
  MINING_SESSION_COOKIE,
} from '@/lib/mining-session'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const ip = getClientIp(request)
  const rate = checkRateLimit(`mining-stop:${ip}`, 30, 60_000)
  if (!rate.allowed) return rateLimitResponse(rate.retryAfterMs)

  const token = request.cookies.get(MINING_SESSION_COOKIE)?.value
  if (!token) return NextResponse.json({ error: 'Mining session cookie missing' }, { status: 401 })

  try {
    const tokenHash = hashMiningSessionToken(token)
    const session = await readSessionByTokenHash(tokenHash)
    if (!session) return NextResponse.json({ error: 'Mining session not found' }, { status: 401 })

    const pending = await getPendingChallenge(session.id)
    if (pending) {
      const account = await stopSessionWithChallengePenalty({
        sessionId: session.id,
        challengeId: pending.id,
        wallet: session.wallet,
        challengeStatus: 'failed',
        stopReason: 'challenge_failed',
      })
      const stopped = await readSessionByTokenHash(tokenHash)
      const response = NextResponse.json({ ok: true, session: stopped ? serializeMiningSession(stopped) : null, account })
      clearMiningCookie(response)
      return response
    }

    const stopped = await stopSession(session.id, 'manual_stop')
    const response = NextResponse.json({ ok: true, session: stopped ? serializeMiningSession(stopped) : null })
    clearMiningCookie(response)
    return response
  } catch (error) {
    console.error('mining/session/stop failed:', error)
    const message = error instanceof Error ? error.message : 'Mining session stop failed'
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