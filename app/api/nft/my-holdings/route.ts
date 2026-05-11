import { NextRequest, NextResponse } from "next/server"
import { createPublicClient, http, isAddress, getAddress } from "viem"
import { ethChain, NFT_CONTRACT_ADDRESS } from "@/lib/chain"
import { SENTINEL_ABI } from "@/lib/contract"
import { checkRateLimit, getClientIp, rateLimitResponse } from "@/lib/rate-limit"
import { serverHttp } from "@/lib/server-rpc"
import { safeFetchTokenMetadata } from "@/lib/safe-fetch"

// Reads use the server (private Alchemy) RPC for unthrottled calls.
const reads = createPublicClient({ chain: ethChain, transport: serverHttp() })

// Logs use a separate client so we can fall back to the public RPC if a
// provider rejects large indexed-arg getLogs ranges.
const logs = createPublicClient({
  chain: ethChain,
  transport: http(process.env.NEXT_PUBLIC_ETH_RPC_URL),
})

const TRANSFER_EVENT = {
  type: "event",
  name: "Transfer",
  inputs: [
    { type: "address", name: "from", indexed: true },
    { type: "address", name: "to",   indexed: true },
    { type: "uint256", name: "tokenId", indexed: true },
  ],
} as const

// Returns NFTs the wallet currently HOLDS — covers app mints, direct mints,
// and marketplace purchases. Strategy:
// 1. Scan Transfer(to=address) events over a generous lookback (chunked,
//    parallel) to discover every tokenId that ever landed on this address.
// 2. Filter by ownerOf(tokenId) === address to drop ones they later sold.
// 3. Fetch tokenURI + Irys metadata for each remaining token.
// Ethereum block time ~12s. 200_000 blocks ~ 28 days. Override per env if needed.
const LOOKBACK_BLOCKS = BigInt(process.env.HOLDINGS_LOOKBACK_BLOCKS || "200000")
const CHUNK_BLOCKS    = 50_000n
const PARALLEL_CHUNKS = 6
const HARD_TOKEN_CAP  = 100           // sanity cap on metadata fetches per request

export async function GET(request: NextRequest) {
  const ip = getClientIp(request)
  const rl = checkRateLimit(`my-holdings:${ip}`, 30, 60_000)
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs)

  const raw = request.nextUrl.searchParams.get("address")
  if (!raw || !isAddress(raw)) {
    return NextResponse.json({ error: "Valid 0x… address required" }, { status: 400 })
  }
  const address = getAddress(raw)

  try {
    const latest = await reads.getBlockNumber()
    const fromBlock = latest > LOOKBACK_BLOCKS ? latest - LOOKBACK_BLOCKS : 0n

    // Build chunk ranges [from, to]
    const ranges: Array<[bigint, bigint]> = []
    for (let f = fromBlock; f <= latest; f += CHUNK_BLOCKS) {
      const t = f + CHUNK_BLOCKS - 1n > latest ? latest : f + CHUNK_BLOCKS - 1n
      ranges.push([f, t])
    }

    // Run chunks in parallel batches. Failures on a single chunk are non-fatal.
    const seenTokenIds = new Set<bigint>()
    for (let i = 0; i < ranges.length; i += PARALLEL_CHUNKS) {
      const batch = ranges.slice(i, i + PARALLEL_CHUNKS)
      const settled = await Promise.allSettled(batch.map(([f, t]) =>
        logs.getLogs({
          address: NFT_CONTRACT_ADDRESS,
          event: TRANSFER_EVENT,
          args: { to: address },
          fromBlock: f,
          toBlock: t,
        }),
      ))
      for (const s of settled) {
        if (s.status !== "fulfilled") continue
        for (const log of s.value) {
          const tokenId = (log.args as { tokenId?: bigint }).tokenId
          if (tokenId !== undefined) seenTokenIds.add(tokenId)
        }
      }
    }

    if (seenTokenIds.size === 0) {
      return NextResponse.json({
        address,
        count: 0,
        holdings: [],
        scannedFromBlock: Number(fromBlock),
        scannedToBlock: Number(latest),
      })
    }

    const tokenIds = Array.from(seenTokenIds).slice(0, HARD_TOKEN_CAP)

    // Verify current ownership in parallel
    const ownership = await Promise.all(tokenIds.map(async (tokenId) => {
      try {
        const owner = await reads.readContract({
          address: NFT_CONTRACT_ADDRESS,
          abi: SENTINEL_ABI,
          functionName: "ownerOf",
          args: [tokenId],
        })
        return { tokenId, owner: owner as string }
      } catch {
        return { tokenId, owner: null }
      }
    }))
    const stillHeld = ownership.filter((o) =>
      o.owner && o.owner.toLowerCase() === address.toLowerCase(),
    )

    // Fetch tokenURI + metadata
    const enriched = await Promise.all(stillHeld.map(async ({ tokenId }) => {
      let tokenURI: string | null = null
      let image: string | null = null
      let name: string | null = null
      let attributes: Array<{ trait_type: string; value: string }> = []
      try {
        const uri = await reads.readContract({
          address: NFT_CONTRACT_ADDRESS,
          abi: SENTINEL_ABI,
          functionName: "tokenURI",
          args: [tokenId],
        })
        tokenURI = uri as string
        // SSRF-safe: scheme + host allowlist + timeout + size cap.
        const meta = await safeFetchTokenMetadata(tokenURI)
        if (meta) {
          image = (meta.image as string | undefined) ?? null
          name = (meta.name as string | undefined) ?? null
          if (Array.isArray(meta.attributes)) attributes = meta.attributes
        }
      } catch {
        // metadata fetch failed; return what we have
      }
      return {
        tokenId: Number(tokenId),
        tokenURI,
        image,
        name: name ?? `SentinelETH #${tokenId}`,
        attributes,
      }
    }))

    enriched.sort((a, b) => a.tokenId - b.tokenId)

    return NextResponse.json({
      address,
      count: enriched.length,
      holdings: enriched,
      scannedFromBlock: Number(fromBlock),
      scannedToBlock: Number(latest),
      truncated: seenTokenIds.size > HARD_TOKEN_CAP,
    })
  } catch (err) {
    console.error("/api/nft/my-holdings failed:", err)
    return NextResponse.json({ error: "Lookup failed" }, { status: 500 })
  }
}
