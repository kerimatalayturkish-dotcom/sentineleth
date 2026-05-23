"use client"

import { useState } from "react"
import { Search, X } from "lucide-react"
import { CollectionGrid } from "@/components/CollectionGrid"
import { Button } from "@/components/ui/button"

function isTokenSearchQuery(value: string) {
  return /^#?\d+$/.test(value)
}

function isWalletSearchQuery(value: string) {
  return /^0x[a-fA-F0-9]{40}$/.test(value)
}

export default function CollectionPage() {
  const [searchInput, setSearchInput] = useState("")
  const [searchQuery, setSearchQuery] = useState("")
  const [searchError, setSearchError] = useState("")

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalized = searchInput.trim()

    if (!normalized) {
      setSearchQuery("")
      setSearchError("")
      return
    }

    if (!isTokenSearchQuery(normalized) && !isWalletSearchQuery(normalized)) {
      setSearchError("Search by NFT number like #128 or a 0x wallet address.")
      return
    }

    setSearchQuery(normalized)
    setSearchInput(normalized)
    setSearchError("")
  }

  const clearSearch = () => {
    setSearchInput("")
    setSearchQuery("")
    setSearchError("")
  }

  return (
    <main className="container mx-auto max-w-6xl p-4 sm:p-6">
      <div className="mb-6 flex flex-col gap-3 sm:mb-8 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="font-pixel text-base sm:text-lg text-sentinel animate-text-glow">COLLECTION</h1>
          <span className="text-[8px] text-muted-foreground">{"// on-chain registry"}</span>
        </div>

        <div className="w-full sm:max-w-md">
          <form onSubmit={handleSubmit} className="flex flex-col gap-2 sm:items-end">
            <div className="flex w-full items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={searchInput}
                  onChange={(event) => {
                    setSearchInput(event.target.value)
                    if (searchError) setSearchError("")
                  }}
                  placeholder="Search #128 or 0x wallet"
                  className="h-8 w-full rounded-lg border border-sentinel/20 bg-card/70 pl-9 pr-3 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-sentinel/50"
                />
              </div>
              <Button type="submit" variant="outline" size="sm">
                Search
              </Button>
              {(searchQuery || searchInput) && (
                <Button type="button" variant="ghost" size="sm" onClick={clearSearch} title="Clear search">
                  <X className="size-3.5" />
                </Button>
              )}
            </div>
            <p className={`text-[9px] ${searchError ? "text-destructive" : "text-muted-foreground"}`}>
              {searchError || "Find a token by number or search holdings by wallet address."}
            </p>
          </form>
        </div>
      </div>
      <CollectionGrid searchQuery={searchQuery} />
    </main>
  )
}
