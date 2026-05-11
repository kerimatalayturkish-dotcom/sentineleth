import { NextRequest, NextResponse } from "next/server"
import { createPublicClient, http } from "viem"
import { ethChain, NFT_CONTRACT_ADDRESS } from "@/lib/chain"
import { SENTINEL_ABI } from "@/lib/contract"
import { checkRateLimit, getClientIp, rateLimitResponse } from "@/lib/rate-limit"
import { serverHttp } from "@/lib/server-rpc"
import { safeFetchTokenMetadata } from "@/lib/safe-fetch"

const publicClient = createPublicClient({
  chain: ethChain,
  transport: serverHttp(),
})

// Logs use the public RPC so that providers with stricter getLogs ranges
// don't throttle our private read transport.
const logsClient = createPublicClient({
  chain: ethChain,
  transport: http(process.env.NEXT_PUBLIC_ETH_RPC_URL),
})

const TRANSFER_EVENT = {
  type: "event",
  name: "Transfer",
  inputs: [
    { type: "address", name: "from", indexed: true },
    { type: "address", name: "to", indexed: true },
    { type: "uint256", name: "tokenId", indexed: true },
  ],
} as const

const LOOKBACK_BLOCKS = BigInt(process.env.HOLDINGS_LOOKBACK_BLOCKS || "200000")
const CHUNK_BLOCKS = 50_000n
const PARALLEL_CHUNKS = 6

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tokenId: string }> },
) {
  const ip = getClientIp(request)
  const rl = checkRateLimit(`collection-detail:${ip}`, 30, 60_000)
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs)
  const { tokenId: tokenIdStr } = await params
  const tokenId = Number(tokenIdStr)

  if (isNaN(tokenId) || tokenId < 0) {
    return NextResponse.json({ error: "Invalid token ID" }, { status: 400 })
  }

  try {
    const totalSupply = await publicClient.readContract({
      address: NFT_CONTRACT_ADDRESS,
      abi: SENTINEL_ABI,
      functionName: "totalSupply",
    })

    // ERC-721A in this contract is 1-indexed: valid IDs are 1..totalSupply.
    if (tokenId < 1 || tokenId > Number(totalSupply)) {
      return NextResponse.json({ error: "Token does not exist" }, { status: 404 })
    }

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

    // Look up the mint TX by scanning Transfer(from=0x0, tokenId=N) logs.
    let mintTxHash: string | null = null
    let mintBlockNumber: number | null = null
    let mintRecipient: string | null = null
    let mintedAt: number | null = null

    try {
      const currentBlock = await publicClient.getBlockNumber()
      const fromBlock = currentBlock > LOOKBACK_BLOCKS ? currentBlock - LOOKBACK_BLOCKS : 0n

      // Chunk the range so providers with strict getLogs limits (e.g. publicnode)
      // don't reject the whole query. We bail out as soon as we find the mint.
      const ranges: Array<[bigint, bigint]> = []
      for (let f = fromBlock; f <= currentBlock; f += CHUNK_BLOCKS) {
        const t = f + CHUNK_BLOCKS - 1n > currentBlock ? currentBlock : f + CHUNK_BLOCKS - 1n
        ranges.push([f, t])
      }

      type Log = Awaited<ReturnType<typeof logsClient.getLogs>>[number]
      let foundLog: Log | null = null
      outer: for (let i = 0; i < ranges.length; i += PARALLEL_CHUNKS) {
        const batch = ranges.slice(i, i + PARALLEL_CHUNKS)
        const settled = await Promise.allSettled(batch.map(([f, t]) =>
          logsClient.getLogs({
            address: NFT_CONTRACT_ADDRESS,
            event: TRANSFER_EVENT,
            args: {
              from: "0x0000000000000000000000000000000000000000" as `0x${string}`,
              tokenId: BigInt(tokenId),
            },
            fromBlock: f,
            toBlock: t,
          }),
        ))
        for (const s of settled) {
          if (s.status === "fulfilled" && s.value.length > 0) {
            foundLog = s.value[0]
            break outer
          }
        }
      }

      if (foundLog) {
        mintTxHash = foundLog.transactionHash
        mintBlockNumber = Number(foundLog.blockNumber)
        const toTopic = foundLog.topics[2]
        if (toTopic) {
          mintRecipient = (`0x${toTopic.slice(26)}`)
        }
        try {
          if (foundLog.blockNumber !== null) {
            const blk = await publicClient.getBlock({ blockNumber: foundLog.blockNumber })
            mintedAt = Number(blk.timestamp)
          }
        } catch {
          // ignore
        }
      }
    } catch (err) {
      console.error(`Token ${tokenId} mint TX lookup failed:`, err)
    }

    // SSRF-safe: scheme + host allowlist + timeout + size cap
    const metadata = await safeFetchTokenMetadata(tokenURI as string)

    return NextResponse.json({
      tokenId,
      name: metadata?.name || `SentinelETH #${tokenId}`,
      description: metadata?.description || null,
      image: metadata?.image || null,
      attributes: metadata?.attributes || [],
      owner: owner as string,
      tokenURI: tokenURI as string,
      mintTxHash,
      mintBlockNumber,
      mintRecipient,
      mintedAt,
    })
  } catch (err) {
    console.error(`Token ${tokenId} fetch failed:`, err)
    return NextResponse.json(
      { error: "Failed to fetch token" },
      { status: 500 },
    )
  }
}
