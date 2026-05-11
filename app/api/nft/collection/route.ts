import { NextRequest, NextResponse } from "next/server"
import { createPublicClient } from "viem"
import { ethChain, NFT_CONTRACT_ADDRESS } from "@/lib/chain"
import { SENTINEL_ABI } from "@/lib/contract"
import { checkRateLimit, getClientIp, rateLimitResponse } from "@/lib/rate-limit"
import { serverHttp } from "@/lib/server-rpc"
import { safeFetchTokenMetadata } from "@/lib/safe-fetch"

const publicClient = createPublicClient({
  chain: ethChain,
  transport: serverHttp(),
})

export async function GET(request: NextRequest) {
  const ip = getClientIp(request)
  const rl = checkRateLimit(`collection:${ip}`, 20, 60_000)
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs)

  const page = Math.max(1, Number(request.nextUrl.searchParams.get("page") || "1"))
  const limit = Math.min(50, Math.max(1, Number(request.nextUrl.searchParams.get("limit") || "20")))

  try {
    const [totalSupply, maxSupply] = await Promise.all([
      publicClient.readContract({
        address: NFT_CONTRACT_ADDRESS,
        abi: SENTINEL_ABI,
        functionName: "totalSupply",
      }),
      publicClient.readContract({
        address: NFT_CONTRACT_ADDRESS,
        abi: SENTINEL_ABI,
        functionName: "MAX_SUPPLY",
      }),
    ])

    const total = Number(totalSupply)
    const max = Number(maxSupply)
    // Tokens are 1-indexed (see SentinelETH._startTokenId), so the global
    // valid range is 1..total. Page N covers IDs [(N-1)*limit + 1 ... N*limit].
    const startId = (page - 1) * limit + 1
    const endId = Math.min(startId + limit - 1, total)

    if (startId > total) {
      return NextResponse.json({
        items: [],
        total,
        maxSupply: max,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      })
    }

    // Fetch tokenURI + owner for each token in the page range
    const tokenIds = Array.from({ length: endId - startId + 1 }, (_, i) => startId + i)

    const items = await Promise.all(
      tokenIds.map(async (tokenId) => {
        try {
          const [tokenURI, owner] = await Promise.all([
            publicClient.readContract({
              address: NFT_CONTRACT_ADDRESS,
              abi: SENTINEL_ABI,
              functionName: "tokenURI",
              args: [BigInt(tokenId)],
            }),
            publicClient.readContract({
              address: NFT_CONTRACT_ADDRESS,
              abi: SENTINEL_ABI,
              functionName: "ownerOf",
              args: [BigInt(tokenId)],
            }),
          ])

          // Fetch metadata from Irys (SSRF-safe: scheme + host allowlist + timeout)
          const metadata = await safeFetchTokenMetadata(tokenURI as string)

          return {
            tokenId,
            name: metadata?.name || `SentinelETH #${tokenId}`,
            image: metadata?.image || null,
            attributes: metadata?.attributes || [],
            owner: owner as string,
            tokenURI: tokenURI as string,
          }
        } catch {
          return {
            tokenId,
            name: `SentinelETH #${tokenId}`,
            image: null,
            attributes: [],
            owner: null,
            tokenURI: null,
          }
        }
      }),
    )

    return NextResponse.json({
      items,
      total,
      maxSupply: max,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    })
  } catch (err) {
    console.error("Collection fetch failed:", err)
    return NextResponse.json(
      { error: "Failed to fetch collection" },
      { status: 500 },
    )
  }
}
