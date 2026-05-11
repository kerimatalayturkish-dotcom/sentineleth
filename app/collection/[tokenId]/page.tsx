"use client"

import { useState, useEffect } from "react"
import { useParams } from "next/navigation"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { fetchJson } from "@/lib/fetch-json"

interface NFTDetail {
  tokenId: number
  name: string
  description: string | null
  image: string | null
  attributes: { trait_type: string; value: string }[]
  owner: string
  tokenURI: string
  mintTxHash: string | null
}

export default function NFTDetailPage() {
  const { tokenId } = useParams<{ tokenId: string }>()
  const [nft, setNft] = useState<NFTDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      try {
        const data = await fetchJson<NFTDetail>(`/api/nft/collection/${tokenId}`)
        setNft(data)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load")
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [tokenId])

  if (loading) {
    return (
      <main className="container mx-auto max-w-4xl p-6">
        <Skeleton className="h-8 w-48 mb-8" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <Skeleton className="aspect-square w-full rounded-xl" />
          <div className="space-y-4">
            <Skeleton className="h-6 w-3/4" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-20 w-full" />
          </div>
        </div>
      </main>
    )
  }

  if (error || !nft) {
    return (
      <main className="container mx-auto max-w-4xl p-6 text-center py-20">
        <p className="text-destructive text-lg mb-4">{error || "Not found"}</p>
        <Link href="/collection">
          <Button variant="outline">← Back to Collection</Button>
        </Link>
      </main>
    )
  }

  const explorerUrl = process.env.NEXT_PUBLIC_EXPLORER_URL || "https://etherscan.io"

  return (
    <main className="container mx-auto max-w-4xl p-4 sm:p-6">
      <Link href="/collection" className="text-xs sm:text-sm text-muted-foreground hover:text-foreground mb-4 inline-block">
        ← Back to Collection
      </Link>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 sm:gap-8 mt-4">
        {/* Image */}
        <div className="rounded-xl overflow-hidden ring-1 ring-foreground/10">
          {nft.image ? (
            <img
              src={nft.image}
              alt={nft.name}
              className="w-full aspect-square object-cover"
            />
          ) : (
            <div className="w-full aspect-square bg-muted flex items-center justify-center">
              <span className="text-muted-foreground text-4xl">?</span>
            </div>
          )}
        </div>

        {/* Details */}
        <div className="space-y-6">
          <div>
            <h1 className="font-pixel text-sm text-sentinel">{nft.name}</h1>
            {nft.description && (
              <p className="text-muted-foreground mt-1">{nft.description}</p>
            )}
          </div>

          {/* Owner */}
          <Card size="sm">
            <CardHeader className="px-4 pb-0 pt-3">
              <CardTitle className="text-xs text-muted-foreground font-normal">Owner</CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-3">
              <a
                href={`${explorerUrl}/address/${nft.owner}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-mono hover:underline break-all"
              >
                {nft.owner}
              </a>
            </CardContent>
          </Card>

          {/* Traits */}
          {nft.attributes.length > 0 && (
            <Card size="sm">
              <CardHeader className="px-4 pb-0 pt-3">
                <CardTitle className="text-xs text-muted-foreground font-normal">Traits</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-3">
                <div className="flex flex-wrap gap-2">
                  {nft.attributes.map((attr) => (
                    <Badge key={attr.trait_type} variant="secondary">
                      <span className="text-muted-foreground mr-1">{attr.trait_type}:</span>
                      {attr.value}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Links */}
          <div className="flex flex-wrap gap-2">
            {nft.tokenURI && (
              <a href={nft.tokenURI} target="_blank" rel="noopener noreferrer">
                <Button variant="outline" size="sm">Metadata ↗</Button>
              </a>
            )}
            {nft.image && (
              <a href={nft.image} target="_blank" rel="noopener noreferrer">
                <Button variant="outline" size="sm">Image ↗</Button>
              </a>
            )}
            {nft.mintTxHash && (
              <a
                href={`${explorerUrl}/tx/${nft.mintTxHash}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Button variant="outline" size="sm">Mint TX ↗</Button>
              </a>
            )}
          </div>
        </div>
      </div>
    </main>
  )
}
