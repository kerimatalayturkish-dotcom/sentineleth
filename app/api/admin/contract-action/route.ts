import { NextRequest, NextResponse } from "next/server"
import {
  createPublicClient,
  createWalletClient,
  isAddress,
  isHex,
  keccak256,
  toBytes,
  type Hex,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { requireAdminWithRateLimit } from "@/lib/auth"
import { readJsonBody } from "@/lib/safe-body"
import { getOptionalServerEnv } from "@/lib/env"
import { ethChain, NFT_CONTRACT_ADDRESS } from "@/lib/chain"
import { SENTINEL_ABI } from "@/lib/contract"
import { serverHttp } from "@/lib/server-rpc"

/**
 * Unified admin contract-action endpoint.
 *
 * All write actions are signed by OWNER_PRIVATE_KEY (the deployer EOA, which
 * holds DEFAULT_ADMIN_ROLE + PAUSER_ROLE + URI_SETTER_ROLE by default).
 *
 * Body:
 *   { action: "withdraw" }
 *   { action: "closeMint" }
 *   { action: "closeAirdrop" }
 *   { action: "setTreasury",     address: "0x..." }
 *   { action: "setAirdropRoot",  root: "0x...32 bytes" }
 *   { action: "grantUriSetter",  address: "0x..." }
 *   { action: "revokeUriSetter", address: "0x..." }
 *
 * Response: { ok: true, action, txHash, blockNumber }
 */

type Action =
  | "withdraw"
  | "closeMint"
  | "closeAirdrop"
  | "setTreasury"
  | "setAirdropRoot"
  | "grantUriSetter"
  | "revokeUriSetter"

const URI_SETTER_ROLE = keccak256(toBytes("URI_SETTER_ROLE")) as Hex

interface Body {
  action?: unknown
  address?: unknown
  root?: unknown
}

export async function POST(request: NextRequest) {
  // Per-session+IP rate limit: at most 30 on-chain admin actions / minute.
  // Defends against a stolen session cookie being used to spam withdraws,
  // pauses, or merkle-root rewrites in rapid succession.
  const auth = await requireAdminWithRateLimit(request, { bucket: "admin-contract-action" })
  if (auth instanceof Response) return auth

  const parsed = await readJsonBody<Body>(request)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status })
  const body = parsed.body

  const action = body.action as Action
  const validActions: Action[] = [
    "withdraw",
    "closeMint",
    "closeAirdrop",
    "setTreasury",
    "setAirdropRoot",
    "grantUriSetter",
    "revokeUriSetter",
  ]
  if (!validActions.includes(action)) {
    return NextResponse.json({ error: `action must be one of ${validActions.join(", ")}` }, { status: 400 })
  }

  // Per-action input validation.
  let functionName: string
  let args: readonly unknown[] = []
  switch (action) {
    case "withdraw":
      functionName = "withdraw"
      break
    case "closeMint":
      functionName = "closeMint"
      break
    case "closeAirdrop":
      functionName = "closeAirdrop"
      break
    case "setTreasury": {
      const addr = body.address
      if (typeof addr !== "string" || !isAddress(addr)) {
        return NextResponse.json({ error: "address must be a 0x-prefixed 20-byte address" }, { status: 400 })
      }
      functionName = "setTreasury"
      args = [addr]
      break
    }
    case "setAirdropRoot": {
      const root = body.root
      if (typeof root !== "string" || !isHex(root) || root.length !== 66) {
        return NextResponse.json({ error: "root must be a 0x-prefixed 32-byte hex" }, { status: 400 })
      }
      functionName = "setAirdropRoot"
      args = [root]
      break
    }
    case "grantUriSetter": {
      const addr = body.address
      if (typeof addr !== "string" || !isAddress(addr)) {
        return NextResponse.json({ error: "address must be a 0x-prefixed 20-byte address" }, { status: 400 })
      }
      functionName = "grantRole"
      args = [URI_SETTER_ROLE, addr]
      break
    }
    case "revokeUriSetter": {
      const addr = body.address
      if (typeof addr !== "string" || !isAddress(addr)) {
        return NextResponse.json({ error: "address must be a 0x-prefixed 20-byte address" }, { status: 400 })
      }
      functionName = "revokeRole"
      args = [URI_SETTER_ROLE, addr]
      break
    }
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
    // Pre-simulate so we surface a clean revert reason instead of "tx reverted".
    await publicClient.simulateContract({
      address: NFT_CONTRACT_ADDRESS,
      abi: SENTINEL_ABI,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      functionName: functionName as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: args as any,
      account: owner.address,
    })

    const hash = await walletClient.writeContract({
      address: NFT_CONTRACT_ADDRESS,
      abi: SENTINEL_ABI,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      functionName: functionName as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: args as any,
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
    console.error(`admin/contract-action ${action} failed:`, err)
    const message = err instanceof Error ? err.message.split("\n")[0] : `${action} failed`
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204 })
}
