import { NextRequest, NextResponse } from 'next/server'
import { readMiningBlockTimeline } from '@/lib/mining-winner'

export const runtime = 'nodejs'

function parsePositiveInt(value: string | null) {
  if (!value) return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null
  return parsed
}

export async function GET(request: NextRequest) {
  const limit = parsePositiveInt(request.nextUrl.searchParams.get('limit')) ?? 120
  const endBlock = parsePositiveInt(request.nextUrl.searchParams.get('endBlock')) ?? undefined

  const timeline = await readMiningBlockTimeline(endBlock, limit)
  return NextResponse.json(timeline)
}