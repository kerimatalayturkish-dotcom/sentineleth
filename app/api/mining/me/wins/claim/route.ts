import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

export async function POST() {
  return NextResponse.json(
    { error: 'Server claim relay is disabled. Submit claims from the connected wallet on /mine.' },
    { status: 410 },
  )
}

export function OPTIONS() {
  return new Response(null, { status: 204 })
}
