import { NextRequest, NextResponse } from "next/server"
import { requireAdmin, requireAdminWithRateLimit } from "@/lib/auth"
import { readJsonBody } from "@/lib/safe-body"
import { getIrysStatus, fundIrys, getIrysPrice } from "@/lib/irys"

// Empirically measured 2026-04-22 via scripts/irys-probe.ts (10 random combos):
// PNG sizes 37–181 KiB, median ~115 KiB. We size the gauge against the p95-ish
// upper bound (200 KiB) plus ~1 KiB JSON metadata, so the displayed runway is
// honest-conservative rather than the old 9× pessimistic 1 MiB assumption.
const IMAGE_ESTIMATE_BYTES = 200 * 1024
const METADATA_ESTIMATE_BYTES = 1024

export async function GET() {
  const admin = await requireAdmin()
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const [status, imagePrice, metadataPrice] = await Promise.all([
      getIrysStatus(),
      getIrysPrice(IMAGE_ESTIMATE_BYTES).catch(() => null),
      getIrysPrice(METADATA_ESTIMATE_BYTES).catch(() => null),
    ])
    let estimatedMintsRemaining: number | null = null
    let perMintAtomic: bigint | null = null
    if (imagePrice && metadataPrice) {
      perMintAtomic = BigInt(imagePrice.priceAtomic) + BigInt(metadataPrice.priceAtomic)
      if (perMintAtomic > 0n) {
        const balanceAtomic = BigInt(status.loadedBalanceAtomic)
        estimatedMintsRemaining = Number(balanceAtomic / perMintAtomic)
      }
    }
    return NextResponse.json({
      ...status,
      estimate: imagePrice
        ? {
            bytes: imagePrice.bytes,
            priceAtomic: imagePrice.priceAtomic,
            price: imagePrice.price,
            metadataBytes: metadataPrice?.bytes ?? null,
            metadataPriceAtomic: metadataPrice?.priceAtomic ?? null,
            perMintAtomic: perMintAtomic ? perMintAtomic.toString() : null,
            estimatedMintsRemaining,
          }
        : null,
    })
  } catch (err) {
    console.error("admin/irys status failed:", err)
    const message = err instanceof Error ? err.message.split("\n")[0] : "Status failed"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  // Funding moves real ETH from the watcher wallet to Irys; rate limit hard
  // (5 funds / minute / session) to make accidental spam expensive.
  const auth = await requireAdminWithRateLimit(request, {
    bucket: "admin-irys-fund",
    limit: 5,
  })
  if (auth instanceof Response) return auth

  const parsed = await readJsonBody<{ amount?: unknown }>(request)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status })
  const body = parsed.body

  const amount = body.amount
  if (typeof amount !== "string" || !/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) {
    return NextResponse.json(
      { error: "amount must be a positive decimal string (token units, e.g. \"0.05\")" },
      { status: 400 },
    )
  }

  try {
    const result = await fundIrys(amount)
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    console.error("admin/irys fund failed:", err)
    const message = err instanceof Error ? err.message.split("\n")[0] : "Fund failed"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204 })
}
