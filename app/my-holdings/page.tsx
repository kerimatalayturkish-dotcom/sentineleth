"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import Image from "next/image"
import { useAccount } from "wagmi"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import { Card, CardContent } from "@/components/ui/card"
import { fetchJson } from "@/lib/fetch-json"

interface Holding {
  tokenId: number
  tokenURI: string | null
  image: string | null
  name: string
  attributes: Array<{ trait_type: string; value: string }>
}

interface ApiResponse {
  address?: string
  count?: number
  holdings?: Holding[]
}

// Trait keys we surface as compact chips on the card. The remaining traits
// stay accessible via the per-token detail page.
const HEADLINE_TRAITS = ["Background", "Body", "Eyes", "Head Item"]

function pickHeadline(attrs: Holding["attributes"]) {
  if (!attrs?.length) return []
  const map = new Map(attrs.map((a) => [a.trait_type, a.value]))
  return HEADLINE_TRAITS
    .map((k) => (map.has(k) ? { trait_type: k, value: map.get(k)! } : null))
    .filter((x): x is { trait_type: string; value: string } => x !== null)
}

export default function MyHoldingsPage() {
  const { address, isConnected } = useAccount()
  const [holdings, setHoldings] = useState<Holding[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!address) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset on disconnect
      setHoldings([])
      return
    }
    setLoading(true)
    setError("")
    fetchJson<ApiResponse>(`/api/nft/my-holdings?address=${address}`)
      .then((data) => setHoldings(data.holdings || []))
      .catch((err) => setError(err instanceof Error ? err.message : "Lookup failed"))
      .finally(() => setLoading(false))
  }, [address])

  return (
    <main className="container mx-auto max-w-6xl p-4 sm:p-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-6 sm:mb-8">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="font-pixel text-base sm:text-lg text-sentinel animate-text-glow">MY HOLDINGS</h1>
          <span className="text-[8px] text-muted-foreground">{"// currently in your wallet"}</span>
        </div>
        {isConnected && holdings.length > 0 && (
          <span className="text-[9px] text-muted-foreground">
            {holdings.length} held
          </span>
        )}
      </div>

      {!isConnected && (
        <Card className="sentinel-card border-sentinel/10 bg-card/60">
          <CardContent className="py-12 flex flex-col items-center gap-4">
            <p className="text-[10px] text-muted-foreground">
              Connect a wallet to see your SentinelETH holdings.
            </p>
            <ConnectButton />
          </CardContent>
        </Card>
      )}

      {isConnected && loading && (
        <p className="text-[10px] text-muted-foreground">Scanning wallet…</p>
      )}

      {isConnected && error && (
        <Card className="sentinel-card border-destructive/30 bg-destructive/5">
          <CardContent className="py-6">
            <p className="text-[10px] text-destructive">{error}</p>
          </CardContent>
        </Card>
      )}

      {isConnected && !loading && !error && holdings.length === 0 && (
        <Card className="sentinel-card border-sentinel/10 bg-card/60">
          <CardContent className="py-12 flex flex-col items-center gap-3">
            <p className="text-[10px] text-muted-foreground">
              No SentinelETH NFTs found in {address?.slice(0, 6)}…{address?.slice(-4)}.
            </p>
          </CardContent>
        </Card>
      )}

      {isConnected && holdings.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 sm:gap-4">
          {holdings.map((h) => {
            const headline = pickHeadline(h.attributes)
            return (
              <Link
                key={h.tokenId}
                href={`/collection/${h.tokenId}`}
                className="block"
              >
                <Card className="sentinel-card border-sentinel/10 bg-card/60 overflow-hidden hover:border-sentinel/40 transition-colors">
                  <div className="relative aspect-square bg-muted/30">
                    {h.image ? (
                      <Image
                        src={h.image}
                        alt={h.name}
                        fill
                        sizes="(max-width: 768px) 50vw, 25vw"
                        className="object-cover"
                        unoptimized
                      />
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center text-[8px] text-muted-foreground">
                        no preview
                      </div>
                    )}
                  </div>
                  <CardContent className="p-3 space-y-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="text-[10px] font-bold text-foreground truncate">{h.name}</p>
                      <span className="text-[8px] text-muted-foreground shrink-0">#{h.tokenId}</span>
                    </div>
                    {headline.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {headline.map((t) => (
                          <span
                            key={t.trait_type}
                            className="text-[7px] px-1.5 py-0.5 rounded bg-sentinel/10 text-sentinel border border-sentinel/20 truncate max-w-full"
                            title={`${t.trait_type}: ${t.value}`}
                          >
                            {t.value}
                          </span>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </Link>
            )
          })}
        </div>
      )}
    </main>
  )
}
