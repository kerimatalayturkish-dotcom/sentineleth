import { NextRequest, NextResponse } from "next/server"
import { createPublicClient, isAddress, getAddress, formatEther } from "viem"
import { requireAdmin } from "@/lib/auth"
import { ethChain, NFT_CONTRACT_ADDRESS } from "@/lib/chain"
import { SENTINEL_ABI } from "@/lib/contract"
import { serverHttp } from "@/lib/server-rpc"

const publicClient = createPublicClient({ chain: ethChain, transport: serverHttp() })

const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`

const HOLDINGS_LOOKBACK_BLOCKS = BigInt(
  process.env.HOLDINGS_LOOKBACK_BLOCKS || "200000",
) // ~28 days at 12s blocks

export async function GET(request: NextRequest) {
  const admin = await requireAdmin()
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const url = new URL(request.url)
  const raw = url.searchParams.get("address")
  if (!raw || !isAddress(raw)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 })
  }
  const address = getAddress(raw)

  try {
    const [publicMintedBy, balance, currentBlock] = await Promise.all([
      publicClient.readContract({
        address: NFT_CONTRACT_ADDRESS,
        abi: SENTINEL_ABI,
        functionName: "publicMintedBy",
        args: [address],
      }) as Promise<bigint>,
      publicClient.readContract({
        address: NFT_CONTRACT_ADDRESS,
        abi: SENTINEL_ABI,
        functionName: "balanceOf",
        args: [address],
      }) as Promise<bigint>,
      publicClient.getBlockNumber(),
    ])

    // Find every Transfer(from=0x0, to=address) event = mint events for this wallet.
    const fromBlock =
      currentBlock > HOLDINGS_LOOKBACK_BLOCKS ? currentBlock - HOLDINGS_LOOKBACK_BLOCKS : 0n

    const mintLogs = await publicClient.getLogs({
      address: NFT_CONTRACT_ADDRESS,
      event: {
        type: "event",
        name: "Transfer",
        inputs: [
          { type: "address", name: "from", indexed: true },
          { type: "address", name: "to", indexed: true },
          { type: "uint256", name: "tokenId", indexed: true },
        ],
      },
      args: { from: ZERO, to: address },
      fromBlock,
      toBlock: "latest",
    })

    // Resolve unique block timestamps
    const uniqueBlocks = Array.from(new Set(mintLogs.map((l) => l.blockNumber)))
    const blockTs = new Map<bigint, number>()
    await Promise.all(
      uniqueBlocks.map(async (bn) => {
        try {
          const blk = await publicClient.getBlock({ blockNumber: bn })
          blockTs.set(bn, Number(blk.timestamp))
        } catch {
          blockTs.set(bn, 0)
        }
      }),
    )

    // Group multi-token mints (one tx can produce multiple Transfer events).
    // Fetch tx for each unique mint tx to get value paid + signer.
    const uniqueTxs = Array.from(new Set(mintLogs.map((l) => l.transactionHash)))
    const txInfo = new Map<
      string,
      { from: `0x${string}` | null; valueWei: bigint }
    >()
    await Promise.all(
      uniqueTxs.map(async (hash) => {
        try {
          const tx = await publicClient.getTransaction({ hash })
          txInfo.set(hash, { from: tx.from ?? null, valueWei: tx.value })
        } catch {
          txInfo.set(hash, { from: null, valueWei: 0n })
        }
      }),
    )

    const mints = mintLogs
      .map((log) => {
        const tx = txInfo.get(log.transactionHash) ?? { from: null, valueWei: 0n }
        return {
          tokenId: Number(log.args.tokenId),
          mintTxHash: log.transactionHash,
          mintSigner: tx.from,
          ethPaid: formatEther(tx.valueWei),
          blockNumber: Number(log.blockNumber),
          mintedAt: blockTs.get(log.blockNumber) ?? 0,
        }
      })
      .sort((a, b) => a.tokenId - b.tokenId)

    return NextResponse.json({
      address,
      counters: {
        publicMintedBy: Number(publicMintedBy),
        currentBalance: Number(balance),
        totalMintsInWindow: mints.length,
      },
      mints,
      lookbackFromBlock: Number(fromBlock),
      lookbackToBlock: Number(currentBlock),
    })
  } catch (err) {
    console.error("admin/wallet lookup failed:", err)
    const message = err instanceof Error ? err.message.split("\n")[0] : "Lookup failed"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204 })
}
