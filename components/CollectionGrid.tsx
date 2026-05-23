"use client"

import { useState, useEffect, useCallback } from "react"
import Link from "next/link"
import { FetchJsonError, fetchJson } from "@/lib/fetch-json"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

interface NFTItem {
  tokenId: number
  name: string
  image: string | null
  attributes: { trait_type: string; value: string }[]
  owner: string | null
}

interface CollectionResponse {
  items: NFTItem[]
  total: number
  maxSupply: number
  page: number
  limit: number
  totalPages: number
}

interface TokenResponse extends NFTItem {
  description?: string | null
  tokenURI?: string | null
}

interface WalletHolding {
  tokenId: number
  name: string
  image: string | null
  attributes: { trait_type: string; value: string }[]
}

interface HoldingsResponse {
  address?: string
  count?: number
  holdings?: WalletHolding[]
  truncated?: boolean
}

function isTokenSearchQuery(value: string) {
  return /^#?\d+$/.test(value)
}

function shortAddress(value: string) {
  return `${value.slice(0, 6)}...${value.slice(-4)}`
}

export function CollectionGrid({ searchQuery = "" }: { searchQuery?: string }) {
  const [data, setData] = useState<CollectionResponse | null>(null)
  const [searchResults, setSearchResults] = useState<NFTItem[] | null>(null)
  const [searchSummary, setSearchSummary] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const limit = 20

  const fetchPage = useCallback(async (p: number) => {
    setLoading(true)
    setError(null)
    try {
      const json = await fetchJson<CollectionResponse>(`/api/nft/collection?page=${p}&limit=${limit}`)
      setData(json)
      setSearchResults(null)
      setSearchSummary(null)
      setPage(p)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load")
    } finally {
      setLoading(false)
    }
  }, [])

  const runSearch = useCallback(async (query: string) => {
    setLoading(true)
    setError(null)

    try {
      if (isTokenSearchQuery(query)) {
        const tokenId = Number(query.replace(/^#/, ""))
        const item = await fetchJson<TokenResponse>(`/api/nft/collection/${tokenId}`)

        setSearchResults([item])
        setSearchSummary(`Showing token #${item.tokenId}`)
        return
      }

      const response = await fetchJson<HoldingsResponse>(`/api/nft/my-holdings?address=${query}`)
      const wallet = response.address ?? query
      const items = (response.holdings ?? []).map((holding) => ({
        ...holding,
        owner: wallet,
      }))

      setSearchResults(items)
      setSearchSummary(
        items.length > 0
          ? `${items.length} result${items.length === 1 ? "" : "s"} for ${shortAddress(wallet)}${response.truncated ? " (first 100 shown)" : ""}`
          : `No holdings found for ${shortAddress(wallet)}`,
      )
    } catch (err) {
      if (err instanceof FetchJsonError && err.status === 404 && isTokenSearchQuery(query)) {
        const tokenId = query.replace(/^#/, "")
        setSearchResults([])
        setSearchSummary(`No token found for #${tokenId}`)
        return
      }

      setError(err instanceof Error ? err.message : "Search failed")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const normalized = searchQuery.trim()

    if (!normalized) {
      void fetchPage(1)
      return
    }

    void runSearch(normalized)
  }, [fetchPage, runSearch, searchQuery])

  const items = searchQuery.trim() ? searchResults : data?.items

  if (error) {
    return (
      <div className="text-center py-12">
        <p className="text-destructive mb-4">{error}</p>
        <Button variant="outline" onClick={() => (searchQuery.trim() ? runSearch(searchQuery.trim()) : fetchPage(page))}>
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {searchQuery.trim() && !loading && searchSummary && (
        <div className="rounded-lg border border-sentinel/15 bg-card/60 px-4 py-3">
          <p className="text-[10px] text-muted-foreground">{searchSummary}</p>
        </div>
      )}

      {/* Grid */}
      {loading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Card key={i} size="sm">
              <Skeleton className="aspect-square w-full rounded-t-xl" />
              <CardContent className="px-3 pb-3 pt-2 space-y-1">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : items && items.length > 0 ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
          {items.map((nft) => (
            <Link key={nft.tokenId} href={`/collection/${nft.tokenId}`}>
              <Card size="sm" className="hover:ring-primary/40 transition-all cursor-pointer">
                {nft.image ? (
                  <img
                    src={nft.image}
                    alt={nft.name}
                    className="aspect-square w-full object-cover rounded-t-xl"
                    loading="lazy"
                  />
                ) : (
                  <div className="aspect-square w-full bg-muted rounded-t-xl flex items-center justify-center">
                    <span className="text-muted-foreground text-2xl">?</span>
                  </div>
                )}
                <CardContent className="px-3 pb-3 pt-2">
                  <p className="font-medium text-[9px] truncate">{nft.name}</p>
                  {nft.owner && (
                    <p className="text-xs text-muted-foreground truncate">
                      {nft.owner.slice(0, 6)}...{nft.owner.slice(-4)}
                    </p>
                  )}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <div className="text-center py-12">
          <p className="text-muted-foreground">
            {searchQuery.trim() ? "No matching NFTs found." : "No NFTs minted yet."}
          </p>
        </div>
      )}

      {/* Pagination */}
      {!searchQuery.trim() && data && data.totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => fetchPage(page - 1)}
          >
            ← Prev
          </Button>
          <span className="text-[8px] text-muted-foreground px-3">
            Page {page} of {data.totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= data.totalPages}
            onClick={() => fetchPage(page + 1)}
          >
            Next →
          </Button>
        </div>
      )}
    </div>
  )
}
