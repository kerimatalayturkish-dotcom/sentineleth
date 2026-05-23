import { NextRequest, NextResponse } from 'next/server'
import { buildAggregateClaimVoucher, countUnclaimedWinsForWallet, readUnclaimedWinsForWallet, syncClaimSettlementsCached } from '@/lib/mining-winner'
import { normalizeWallet } from '@/lib/mining-session'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const wallet = normalizeWallet(request.nextUrl.searchParams.get('wallet'))
  if (!wallet) return NextResponse.json({ error: 'wallet query param must be a valid address' }, { status: 400 })

  await syncClaimSettlementsCached().catch(() => undefined)

  const limit = Math.min(50, Math.max(1, Number(request.nextUrl.searchParams.get('limit') || '25')))
  const [wins, fallbackPendingCount, aggregateClaim] = await Promise.all([
    readUnclaimedWinsForWallet(wallet, limit),
    countUnclaimedWinsForWallet(wallet),
    buildAggregateClaimVoucher(wallet),
  ])
  const pendingCount = aggregateClaim?.roundCount ?? fallbackPendingCount
  return NextResponse.json({ wallet, pendingCount, aggregateClaim, wins })
}