import { NextRequest, NextResponse } from 'next/server'
import {
  countClaimedWinsForWallet,
  readClaimedWinsForWallet,
  sumClaimedRewardForWallet,
  syncClaimSettlementsCached,
} from '@/lib/mining-winner'
import { normalizeWallet } from '@/lib/mining-session'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const wallet = normalizeWallet(request.nextUrl.searchParams.get('wallet'))
  if (!wallet) return NextResponse.json({ error: 'wallet query param must be a valid address' }, { status: 400 })

  await syncClaimSettlementsCached().catch(() => undefined)

  const limit = Math.min(100, Math.max(1, Number(request.nextUrl.searchParams.get('limit') || '25')))
  const [wins, claimedCount, claimedRewardTotal] = await Promise.all([
    readClaimedWinsForWallet(wallet, limit),
    countClaimedWinsForWallet(wallet),
    sumClaimedRewardForWallet(wallet),
  ])

  return NextResponse.json({ wallet, claimedCount, claimedRewardTotal, wins })
}