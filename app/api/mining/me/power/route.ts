import { NextRequest, NextResponse } from 'next/server'
import type { QueryResultRow } from 'pg'
import { miningQuery } from '@/lib/mining-db'
import { refreshMiningPowerForWallets, walletPowerPayloadMatchesCurrentSource } from '@/lib/mining-power'
import { normalizeWallet } from '@/lib/mining-session'

export const runtime = 'nodejs'

interface PowerRow extends QueryResultRow {
  wallet: string
  wallet_power: string
  nft_count: number
  eligible_nft_count: number
  rules_commitment: string | null
  status: 'ready' | 'not_computed' | 'stale' | 'error'
  computed_at: Date | null
  expires_at: Date | null
  payload: Record<string, unknown>
}

async function readPowerRow(wallet: string) {
  const result = await miningQuery<PowerRow>(
    `select
      wallet,
      wallet_power::text,
      nft_count,
      eligible_nft_count,
      rules_commitment,
      status,
      computed_at,
      expires_at,
      payload
    from mining_power_cache
    where lower(wallet) = lower($1)
    limit 1`,
    [wallet],
  )

  return result.rows[0] ?? null
}

export async function GET(request: NextRequest) {
  const wallet = normalizeWallet(request.nextUrl.searchParams.get('wallet'))
  if (!wallet) return NextResponse.json({ error: 'wallet query param must be a valid address' }, { status: 400 })

  try {
    let row = await readPowerRow(wallet)
    const cacheExpired = row?.expires_at ? row.expires_at.getTime() <= Date.now() : false
    const sourceMismatch = row ? !walletPowerPayloadMatchesCurrentSource(row.payload) : false
    const needsRefresh = !row || row.status !== 'ready' || cacheExpired || sourceMismatch

    if (needsRefresh) {
      await refreshMiningPowerForWallets([wallet])
      row = await readPowerRow(wallet)
    }

    if (!row) {
      return NextResponse.json({
        wallet,
        status: 'not_cached',
        walletPower: '0',
        nftCount: 0,
        eligibleNftCount: 0,
        rulesCommitment: null,
        computedAt: null,
        expiresAt: null,
        tokens: [],
      })
    }

    const payloadTokens = Array.isArray(row.payload.tokens) ? row.payload.tokens : []
    return NextResponse.json({
      wallet: row.wallet,
      status: row.status,
      walletPower: row.wallet_power,
      nftCount: row.nft_count,
      eligibleNftCount: row.eligible_nft_count,
      rulesCommitment: row.rules_commitment,
      computedAt: row.computed_at?.toISOString() ?? null,
      expiresAt: row.expires_at?.toISOString() ?? null,
      tokens: payloadTokens,
      details: row.payload,
    })
  } catch (error) {
    console.error('mining/me/power failed:', error)
    const message = error instanceof Error ? error.message : 'Mining power cache unavailable'
    return NextResponse.json({ error: message }, { status: 503 })
  }
}