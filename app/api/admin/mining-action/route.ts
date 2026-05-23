import { NextRequest, NextResponse } from "next/server"
import { createPublicClient, createWalletClient, http } from "viem"
import { requireAdminWithRateLimit } from "@/lib/auth"
import { readJsonBody } from "@/lib/safe-body"
import { getOptionalMiningServerConfig } from "@/lib/mining-server-config"
import { buildManualExecution, resolveMiningOperator, sameAddress } from "@/lib/mining-admin-actions"
import { miningChain } from "@/lib/mining-config"
import { PATROL_MINER_ABI } from "@/lib/mining-contracts"

type Action = "startMining"

interface Body {
  action?: unknown
}

export async function POST(request: NextRequest) {
  const auth = await requireAdminWithRateLimit(request, { bucket: "admin-mining-action", limit: 10 })
  if (auth instanceof Response) return auth

  const parsed = await readJsonBody<Body>(request)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status })

  const action = parsed.body.action as Action
  if (action !== "startMining") {
    return NextResponse.json({ error: "action must be startMining" }, { status: 400 })
  }

  const config = getOptionalMiningServerConfig()
  const patrolMiner = config.miningChain.contracts.patrolMiner
  if (!patrolMiner) {
    return NextResponse.json({ error: "NEXT_PUBLIC_PATROL_MINER_ADDRESS not configured" }, { status: 503 })
  }
  if (!config.miningChain.rpcUrl) {
    return NextResponse.json({ error: "MINING_RPC_URL not configured" }, { status: 503 })
  }
  const operator = resolveMiningOperator(config)
  const adminAccount = operator.account

  const publicClient = createPublicClient({ chain: miningChain, transport: http(config.miningChain.rpcUrl) })

  try {
    const [onChainAdmin, miningStartBlock] = await Promise.all([
      publicClient.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: "admin" }),
      publicClient.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: "miningStartBlock" }),
    ])

    if (!sameAddress(onChainAdmin, adminAccount?.address)) {
      return NextResponse.json(
        {
          ok: true,
          action,
          mode: "manual",
          localSigner: adminAccount?.address ?? null,
          warning: operator.warning,
          execution: buildManualExecution({
            to: patrolMiner,
            abi: PATROL_MINER_ABI,
            functionName: "startMining",
            requiredSigners: [onChainAdmin],
            note: adminAccount
              ? `Configured signer ${adminAccount.address} is not PatrolMiner admin ${onChainAdmin}. Submit this transaction from the admin Safe or a wallet that controls that address.`
              : `No local mining operator signer is available. Submit this transaction from the PatrolMiner admin ${onChainAdmin}.`,
          }),
        },
      )
    }
    if (!adminAccount) {
      return NextResponse.json(
        {
          ok: true,
          action,
          mode: "manual",
          localSigner: null,
          warning: operator.warning,
          execution: buildManualExecution({
            to: patrolMiner,
            abi: PATROL_MINER_ABI,
            functionName: "startMining",
            requiredSigners: [onChainAdmin],
            note: `No local mining operator signer is available. Submit this transaction from the PatrolMiner admin ${onChainAdmin}.`,
          }),
        },
      )
    }
    if (miningStartBlock !== 0n) {
      return NextResponse.json({ error: `Mining already started at block ${miningStartBlock}` }, { status: 409 })
    }

    const walletClient = createWalletClient({ chain: miningChain, transport: http(config.miningChain.rpcUrl), account: adminAccount })

    await publicClient.simulateContract({
      address: patrolMiner,
      abi: PATROL_MINER_ABI,
      functionName: "startMining",
      account: adminAccount.address,
    })

    const hash = await walletClient.writeContract({
      address: patrolMiner,
      abi: PATROL_MINER_ABI,
      functionName: "startMining",
    })
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
    if (receipt.status !== "success") {
      return NextResponse.json({ error: "Transaction reverted", txHash: hash }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      action,
      mode: "direct",
      txHash: hash,
      blockNumber: Number(receipt.blockNumber),
    })
  } catch (err) {
    console.error(`admin/mining-action ${action} failed:`, err)
    const message = err instanceof Error ? err.message.split("\n")[0] : `${action} failed`
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204 })
}