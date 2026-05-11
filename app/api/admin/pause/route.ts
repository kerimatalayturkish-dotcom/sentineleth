import { NextRequest, NextResponse } from "next/server"
import { createPublicClient, createWalletClient } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { requireAdminWithRateLimit } from "@/lib/auth"
import { readJsonBody } from "@/lib/safe-body"
import { getOptionalServerEnv } from "@/lib/env"
import { ethChain, NFT_CONTRACT_ADDRESS } from "@/lib/chain"
import { SENTINEL_ABI } from "@/lib/contract"
import { serverHttp } from "@/lib/server-rpc"

/**
 * Owner-only pause/unpause. Uses OZ Pausable (no count cap).
 */
export async function POST(request: NextRequest) {
  // Per-session+IP rate limit, same as contract-action.
  const auth = await requireAdminWithRateLimit(request, { bucket: "admin-pause" })
  if (auth instanceof Response) return auth

  const parsed = await readJsonBody<{ action?: unknown }>(request)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status })
  const body = parsed.body

  const action = body.action
  if (action !== "pause" && action !== "unpause") {
    return NextResponse.json({ error: "action must be 'pause' or 'unpause'" }, { status: 400 })
  }

  const env = getOptionalServerEnv()
  if (!env.ownerPrivateKey) {
    return NextResponse.json(
      { error: "OWNER_PRIVATE_KEY not configured on server" },
      { status: 503 },
    )
  }

  const owner = privateKeyToAccount(env.ownerPrivateKey)
  const publicClient = createPublicClient({ chain: ethChain, transport: serverHttp() })
  const walletClient = createWalletClient({ chain: ethChain, transport: serverHttp(), account: owner })

  try {
    const isPaused = (await publicClient.readContract({
      address: NFT_CONTRACT_ADDRESS,
      abi: SENTINEL_ABI,
      functionName: "paused",
    })) as boolean

    if (action === "pause" && isPaused) {
      return NextResponse.json({ error: "Already paused" }, { status: 409 })
    }
    if (action === "unpause" && !isPaused) {
      return NextResponse.json({ error: "Not currently paused" }, { status: 409 })
    }

    const hash = await walletClient.writeContract({
      address: NFT_CONTRACT_ADDRESS,
      abi: SENTINEL_ABI,
      functionName: action,
      args: [],
    })

    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
    if (receipt.status !== "success") {
      return NextResponse.json({ error: "Transaction reverted", txHash: hash }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      action,
      txHash: hash,
      blockNumber: Number(receipt.blockNumber),
    })
  } catch (err) {
    console.error(`admin/pause ${action} failed:`, err)
    const message = err instanceof Error ? err.message.split("\n")[0] : `${action} failed`
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204 })
}
