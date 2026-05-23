import { NextRequest, NextResponse } from 'next/server'
import { readWinnerForBlock } from '@/lib/mining-winner'
import { normalizeWallet } from '@/lib/mining-session'

export const runtime = 'nodejs'

interface WinnerRouteContext {
  params: Promise<{ blockNumber: string }>
}

export async function GET(request: NextRequest, context: WinnerRouteContext) {
  const { blockNumber: blockNumberParam } = await context.params
  const blockNumber = Number(blockNumberParam)
  if (!Number.isSafeInteger(blockNumber) || blockNumber <= 0) {
    return NextResponse.json({ error: 'blockNumber must be a positive integer' }, { status: 400 })
  }

  const winner = await readWinnerForBlock(blockNumber)
  if (!winner) return NextResponse.json({ error: 'Winner not found' }, { status: 404 })

  const wallet = normalizeWallet(request.nextUrl.searchParams.get('wallet'))
  if (wallet && wallet.toLowerCase() !== winner.winner.toLowerCase()) {
    return NextResponse.json({ error: 'Winner not found for wallet' }, { status: 404 })
  }

  return NextResponse.json({ winner })
}