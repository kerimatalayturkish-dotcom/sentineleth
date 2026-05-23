"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"

type Phase =
  | "paused"
  | "public_mint"
  | "public_sold_out"
  | "airdrop_claim"
  | "airdrop_closed"
  | "all_closed"

interface StatusResponse {
  phase: Phase
  phaseLabel: string
  canMintPublic: boolean
  reasonIfNotMintable: string | null
  lowSupplyThreshold: number
  lowSupplyWarning: string | null
  publicMinted: number
  publicRemaining: number
  airdropMinted: number
  airdropRemaining: number
  limits: { publicCap: number; airdropCap: number; maxPerWallet: number }
  mintPrice: string
  currency: string
}

// Color hint per phase, matches the existing sentinel/text-* palette.
const PHASE_TONE: Record<Phase, string> = {
  paused: "text-amber-400",
  public_mint: "text-sentinel",
  public_sold_out: "text-amber-400",
  airdrop_claim: "text-sentinel",
  airdrop_closed: "text-muted-foreground",
  all_closed: "text-muted-foreground",
}

export function MintPhaseStatus() {
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      fetch("/api/nft/status")
        .then((r) => (r.ok ? r.json() : null))
        .then((d: StatusResponse | null) => {
          if (!cancelled && d) {
            setStatus(d)
            setLoading(false)
          }
        })
        .catch(() => {
          if (!cancelled) setLoading(false)
        })
    }
    load()
    // Poll every 30s so a sell-out / phase flip propagates without a page refresh.
    const t = setInterval(load, 30_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])

  if (loading || !status) {
    return (
      <div className="mt-6 text-center">
        <p className="font-pixel text-[8px] text-muted-foreground tracking-widest">
          LOADING PHASE...
        </p>
      </div>
    )
  }

  const tone = PHASE_TONE[status.phase]
  const cap =
    status.phase === "airdrop_claim" ? status.limits.airdropCap : status.limits.publicCap
  const used = status.phase === "airdrop_claim" ? status.airdropMinted : status.publicMinted
  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0

  // Pick the primary CTA based on phase.
  // - public_mint: "Mint a Sentinel" → /how-to-mint (active)
  // - public_sold_out: disabled "Mint Closed", small note about airdrop
  // - airdrop_claim: "Claim Airdrop" → /how-to-mint (later we route to a dedicated /claim page)
  // - paused / closed: disabled "Unavailable"
  let primaryCtaLabel = "Mint a Sentinel"
  let primaryCtaHref: string | null = "/how-to-mint"
  let primaryCtaDisabled = false
  if (status.phase === "public_mint") {
    primaryCtaLabel = "Mint a Sentinel"
    primaryCtaHref = "/how-to-mint"
  } else if (status.phase === "airdrop_claim") {
    primaryCtaLabel = "Claim Airdrop"
    primaryCtaHref = "/claim"
  } else if (status.phase === "public_sold_out") {
    primaryCtaLabel = "Public Mint Sold Out"
    primaryCtaHref = null
    primaryCtaDisabled = true
  } else if (status.phase === "paused") {
    primaryCtaLabel = "Minting Paused"
    primaryCtaHref = null
    primaryCtaDisabled = true
  } else {
    primaryCtaLabel = "Mint Closed"
    primaryCtaHref = null
    primaryCtaDisabled = true
  }

  return (
    <div className="mt-8 space-y-4">
      {/* Phase badge */}
      <div className="flex items-center justify-center gap-2">
        <span className="font-pixel text-[10px] sm:text-[12px] text-muted-foreground tracking-widest">
          PHASE:
        </span>
        <span
          className={`font-pixel text-[12px] sm:text-[14px] tracking-widest ${tone} animate-text-glow`}
        >
          {status.phaseLabel.toUpperCase()}
        </span>
      </div>

      {/* Progress + counts */}
      <div className="max-w-md mx-auto">
        <div className="h-2 w-full overflow-hidden rounded-full border border-sentinel/10 bg-card/60">
          <div
            className={`h-full transition-all duration-700 ${
              status.phase === "public_mint" || status.phase === "airdrop_claim"
                ? "bg-sentinel"
                : "bg-muted-foreground/40"
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="mt-3 text-center font-pixel text-[10px] sm:text-[12px] text-muted-foreground tracking-widest">
          {used.toLocaleString()} / {cap.toLocaleString()}
          {status.phase === "public_mint" && (
            <>
              {" \u00B7 "}
              <span className="text-sentinel">{status.publicRemaining.toLocaleString()}</span>{" "}
              REMAINING
            </>
          )}
        </p>
      </div>

      {/* Scarcity warning */}
      {status.lowSupplyWarning && (
        <p className="mx-auto max-w-md text-center font-pixel text-[10px] sm:text-[12px] text-amber-400 tracking-widest leading-relaxed">
          {status.lowSupplyWarning.toUpperCase()}
        </p>
      )}

      {/* Off-phase reason (sold out / paused / closed) */}
      {status.reasonIfNotMintable && status.phase !== "public_mint" && (
        <p className="mx-auto max-w-md text-center text-[14px] sm:text-[16px] text-muted-foreground leading-relaxed">
          {status.reasonIfNotMintable}
        </p>
      )}

      {/* CTA row */}
      <div className="mx-auto mt-7 flex justify-center">
        {primaryCtaDisabled || !primaryCtaHref ? (
          <Button
            size="lg"
            disabled
            className="h-12 cursor-not-allowed border border-muted-foreground/20 bg-black/40 px-5 text-[13px] text-muted-foreground sm:h-14 sm:text-[14px]"
          >
            {primaryCtaLabel}
          </Button>
        ) : (
          <Link href={primaryCtaHref} className="border-trace inline-block">
            <Button
              size="lg"
              className="h-12 border-0 bg-black px-5 text-[13px] text-sentinel hover:bg-sentinel/10 hover:text-sentinel sm:h-14 sm:text-[14px]"
            >
              {primaryCtaLabel}
            </Button>
          </Link>
        )}
      </div>
    </div>
  )
}
