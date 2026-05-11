"use client"

import { CollectionGrid } from "@/components/CollectionGrid"

export default function CollectionPage() {
  return (
    <main className="container mx-auto max-w-6xl p-4 sm:p-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-6 sm:mb-8">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="font-pixel text-base sm:text-lg text-sentinel animate-text-glow">COLLECTION</h1>
          <span className="text-[8px] text-muted-foreground">{"// on-chain registry"}</span>
        </div>
      </div>
      <CollectionGrid />
    </main>
  )
}
