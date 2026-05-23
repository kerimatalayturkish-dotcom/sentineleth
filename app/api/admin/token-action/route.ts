import { NextRequest, NextResponse } from "next/server"
import { createPublicClient, createWalletClient, http, parseEther } from "viem"
import { requireAdminWithRateLimit } from "@/lib/auth"
import { getOptionalMiningServerConfig } from "@/lib/mining-server-config"
import { buildManualExecution, resolveMiningOperator, sameAddress, uniqueAddresses } from "@/lib/mining-admin-actions"
import { miningChain } from "@/lib/mining-config"
import { PATROL_MINER_ABI, SENTI_LIQUIDITY_MANAGER_ABI } from "@/lib/mining-contracts"
import { readJsonBody } from "@/lib/safe-body"

type Action =
  | "setAiAgentMinter"
  | "burnUnmintedAiAgentSupply"
  | "setKeeper"
  | "setTrackedPositionTokenId"
  | "setCompoundConfig"
  | "compoundLiquidity"
  | "burnReserveSenti"
  | "refreshPermit2Allowance"

interface Body {
  action?: unknown
  address?: unknown
  amount?: unknown
  authorized?: unknown
  tokenId?: unknown
  minEthToCompound?: unknown
  compoundCooldown?: unknown
  maxEthPerCompound?: unknown
  maxSentiPerCompound?: unknown
  maxDeadlineWindow?: unknown
  liquidityIncrease?: unknown
  amount0Max?: unknown
  amount1Max?: unknown
  deadline?: unknown
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

function parseAddress(name: string, value: unknown): `0x${string}` {
  const raw = String(value ?? "").trim()
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error(`${name} must be a valid 0x address`)
  return raw as `0x${string}`
}

function parseBoolean(name: string, value: unknown): boolean {
  if (typeof value === "boolean") return value
  if (value === "true") return true
  if (value === "false") return false
  throw new Error(`${name} must be true or false`)
}

function parseBigint(name: string, value: unknown): bigint {
  const raw = String(value ?? "").trim()
  if (!raw) throw new Error(`${name} is required`)
  try {
    const parsed = BigInt(raw)
    if (parsed < 0n) throw new Error(`${name} must be non-negative`)
    return parsed
  } catch {
    throw new Error(`${name} must be an integer string`)
  }
}

function parseTokenAmount(name: string, value: unknown): bigint {
  const raw = String(value ?? "").trim()
  if (!raw) throw new Error(`${name} is required`)
  try {
    return parseEther(raw)
  } catch {
    throw new Error(`${name} must be a valid decimal amount`)
  }
}

function actionNeedsManagerAdmin(action: Action): boolean {
  return action !== "compoundLiquidity"
}

function manualResponse(params: {
  action: Action
  to: `0x${string}`
  abi: typeof PATROL_MINER_ABI | typeof SENTI_LIQUIDITY_MANAGER_ABI
  functionName: string
  args?: readonly unknown[]
  value?: bigint
  requiredSigners: `0x${string}`[]
  note: string
  localSigner?: `0x${string}` | null
  warning?: string | null
}) {
  return NextResponse.json({
    ok: true,
    action: params.action,
    mode: "manual",
    localSigner: params.localSigner ?? null,
    warning: params.warning ?? null,
    execution: buildManualExecution({
      to: params.to,
      abi: params.abi,
      functionName: params.functionName,
      args: params.args,
      value: params.value,
      requiredSigners: params.requiredSigners,
      note: params.note,
    }),
  })
}

export async function POST(request: NextRequest) {
  const auth = await requireAdminWithRateLimit(request, { bucket: "admin-token-action", limit: 20 })
  if (auth instanceof Response) return auth

  const parsed = await readJsonBody<Body>(request)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status })

  const action = parsed.body.action as Action
  if (!action) {
    return NextResponse.json({ error: "action is required" }, { status: 400 })
  }

  const config = getOptionalMiningServerConfig()
  if (!config.miningChain.rpcUrl) {
    return NextResponse.json({ error: "MINING_RPC_URL not configured" }, { status: 503 })
  }
  const operator = resolveMiningOperator(config)
  const adminAccount = operator.account

  const publicClient = createPublicClient({ chain: miningChain, transport: http(config.miningChain.rpcUrl) })

  const patrolMiner = config.miningChain.contracts.patrolMiner
  const liquidityManager = config.miningChain.contracts.liquidityManager

  try {
    if (action === "setAiAgentMinter" || action === "burnUnmintedAiAgentSupply") {
      if (!patrolMiner) {
        return NextResponse.json({ error: "NEXT_PUBLIC_PATROL_MINER_ADDRESS not configured" }, { status: 503 })
      }

      const onChainAdmin = await publicClient.readContract({ address: patrolMiner, abi: PATROL_MINER_ABI, functionName: "admin" })
      const localSignerAddress = adminAccount?.address ?? null
      const walletClient = adminAccount
        ? createWalletClient({ chain: miningChain, transport: http(config.miningChain.rpcUrl), account: adminAccount })
        : null

      if (action === "setAiAgentMinter") {
        const address = parseAddress("address", parsed.body.address)
        if (!sameAddress(onChainAdmin, localSignerAddress)) {
          return manualResponse({
            action,
            to: patrolMiner,
            abi: PATROL_MINER_ABI,
            functionName: "setAiAgentMinter",
            args: [address],
            requiredSigners: [onChainAdmin],
            localSigner: localSignerAddress,
            warning: operator.warning,
            note: localSignerAddress
              ? `Configured signer ${localSignerAddress} is not PatrolMiner admin ${onChainAdmin}. Submit this transaction from the admin Safe or a wallet that controls that address.`
              : `No local mining operator signer is available. Submit this transaction from the PatrolMiner admin ${onChainAdmin}.`,
          })
        }
        await publicClient.simulateContract({
          address: patrolMiner,
          abi: PATROL_MINER_ABI,
          functionName: "setAiAgentMinter",
          args: [address],
          account: localSignerAddress,
        })
        const hash = await walletClient!.writeContract({
          address: patrolMiner,
          abi: PATROL_MINER_ABI,
          functionName: "setAiAgentMinter",
          args: [address],
        })
        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
        if (receipt.status !== "success") {
          return NextResponse.json({ error: "Transaction reverted", txHash: hash }, { status: 500 })
        }
        return NextResponse.json({ ok: true, action, txHash: hash, blockNumber: Number(receipt.blockNumber) })
      }

      const amount = parseTokenAmount("amount", parsed.body.amount)
      if (!sameAddress(onChainAdmin, localSignerAddress)) {
        return manualResponse({
          action,
          to: patrolMiner,
          abi: PATROL_MINER_ABI,
          functionName: "burnUnmintedAiAgentSupply",
          args: [amount],
          requiredSigners: [onChainAdmin],
          localSigner: localSignerAddress,
          warning: operator.warning,
          note: localSignerAddress
            ? `Configured signer ${localSignerAddress} is not PatrolMiner admin ${onChainAdmin}. Submit this transaction from the admin Safe or a wallet that controls that address.`
            : `No local mining operator signer is available. Submit this transaction from the PatrolMiner admin ${onChainAdmin}.`,
        })
      }
      await publicClient.simulateContract({
        address: patrolMiner,
        abi: PATROL_MINER_ABI,
        functionName: "burnUnmintedAiAgentSupply",
        args: [amount],
        account: localSignerAddress,
      })
      const hash = await walletClient!.writeContract({
        address: patrolMiner,
        abi: PATROL_MINER_ABI,
        functionName: "burnUnmintedAiAgentSupply",
        args: [amount],
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
      if (receipt.status !== "success") {
        return NextResponse.json({ error: "Transaction reverted", txHash: hash }, { status: 500 })
      }
      return NextResponse.json({ ok: true, action, mode: "direct", txHash: hash, blockNumber: Number(receipt.blockNumber) })
    }

    if (!liquidityManager) {
      return NextResponse.json({ error: "NEXT_PUBLIC_SENTI_LIQUIDITY_MANAGER_ADDRESS not configured" }, { status: 503 })
    }

    const localSignerAddress = adminAccount?.address ?? null
    const [adminSafe, opsSafe, isAuthorizedKeeper] = await Promise.all([
      publicClient.readContract({ address: liquidityManager, abi: SENTI_LIQUIDITY_MANAGER_ABI, functionName: "adminSafe" }),
      publicClient.readContract({ address: liquidityManager, abi: SENTI_LIQUIDITY_MANAGER_ABI, functionName: "opsSafe" }),
      adminAccount
        ? publicClient.readContract({
            address: liquidityManager,
            abi: SENTI_LIQUIDITY_MANAGER_ABI,
            functionName: "authorizedKeepers",
            args: [adminAccount.address],
          })
        : Promise.resolve(false),
    ])
    const walletClient = adminAccount
      ? createWalletClient({ chain: miningChain, transport: http(config.miningChain.rpcUrl), account: adminAccount })
      : null

    const signerIsAdminSafe = sameAddress(adminSafe, localSignerAddress)
    const signerCanCompound = signerIsAdminSafe || sameAddress(opsSafe, localSignerAddress) || isAuthorizedKeeper

    if (action === "setKeeper") {
      const address = parseAddress("address", parsed.body.address)
      if (address.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
        return NextResponse.json({ error: "address must not be zero" }, { status: 400 })
      }
      const authorized = parseBoolean("authorized", parsed.body.authorized)
      if (!signerIsAdminSafe) {
        return manualResponse({
          action,
          to: liquidityManager,
          abi: SENTI_LIQUIDITY_MANAGER_ABI,
          functionName: "setKeeper",
          args: [address, authorized],
          requiredSigners: [adminSafe],
          localSigner: localSignerAddress,
          warning: operator.warning,
          note: localSignerAddress
            ? `Configured signer ${localSignerAddress} is not SentiLiquidityManager adminSafe ${adminSafe}. Submit this transaction from the admin Safe or a wallet that controls that address.`
            : `No local mining operator signer is available. Submit this transaction from the SentiLiquidityManager adminSafe ${adminSafe}.`,
        })
      }
      await publicClient.simulateContract({
        address: liquidityManager,
        abi: SENTI_LIQUIDITY_MANAGER_ABI,
        functionName: "setKeeper",
        args: [address, authorized],
        account: localSignerAddress,
      })
      const hash = await walletClient!.writeContract({
        address: liquidityManager,
        abi: SENTI_LIQUIDITY_MANAGER_ABI,
        functionName: "setKeeper",
        args: [address, authorized],
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
      if (receipt.status !== "success") return NextResponse.json({ error: "Transaction reverted", txHash: hash }, { status: 500 })
      return NextResponse.json({ ok: true, action, mode: "direct", txHash: hash, blockNumber: Number(receipt.blockNumber) })
    }

    if (action === "setTrackedPositionTokenId") {
      const tokenId = parseBigint("tokenId", parsed.body.tokenId)
      if (!signerIsAdminSafe) {
        return manualResponse({
          action,
          to: liquidityManager,
          abi: SENTI_LIQUIDITY_MANAGER_ABI,
          functionName: "setTrackedPositionTokenId",
          args: [tokenId],
          requiredSigners: [adminSafe],
          localSigner: localSignerAddress,
          warning: operator.warning,
          note: localSignerAddress
            ? `Configured signer ${localSignerAddress} is not SentiLiquidityManager adminSafe ${adminSafe}. Submit this transaction from the admin Safe or a wallet that controls that address.`
            : `No local mining operator signer is available. Submit this transaction from the SentiLiquidityManager adminSafe ${adminSafe}.`,
        })
      }
      await publicClient.simulateContract({
        address: liquidityManager,
        abi: SENTI_LIQUIDITY_MANAGER_ABI,
        functionName: "setTrackedPositionTokenId",
        args: [tokenId],
        account: localSignerAddress,
      })
      const hash = await walletClient!.writeContract({
        address: liquidityManager,
        abi: SENTI_LIQUIDITY_MANAGER_ABI,
        functionName: "setTrackedPositionTokenId",
        args: [tokenId],
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
      if (receipt.status !== "success") return NextResponse.json({ error: "Transaction reverted", txHash: hash }, { status: 500 })
      return NextResponse.json({ ok: true, action, mode: "direct", txHash: hash, blockNumber: Number(receipt.blockNumber) })
    }

    if (action === "setCompoundConfig") {
      const minEthToCompound = parseTokenAmount("minEthToCompound", parsed.body.minEthToCompound)
      const compoundCooldown = parseBigint("compoundCooldown", parsed.body.compoundCooldown)
      const maxEthPerCompound = parseTokenAmount("maxEthPerCompound", parsed.body.maxEthPerCompound)
      const maxSentiPerCompound = parseTokenAmount("maxSentiPerCompound", parsed.body.maxSentiPerCompound)
      const maxDeadlineWindow = parseBigint("maxDeadlineWindow", parsed.body.maxDeadlineWindow)

      if (!signerIsAdminSafe) {
        return manualResponse({
          action,
          to: liquidityManager,
          abi: SENTI_LIQUIDITY_MANAGER_ABI,
          functionName: "setCompoundConfig",
          args: [minEthToCompound, compoundCooldown, maxEthPerCompound, maxSentiPerCompound, maxDeadlineWindow],
          requiredSigners: [adminSafe],
          localSigner: localSignerAddress,
          warning: operator.warning,
          note: localSignerAddress
            ? `Configured signer ${localSignerAddress} is not SentiLiquidityManager adminSafe ${adminSafe}. Submit this transaction from the admin Safe or a wallet that controls that address.`
            : `No local mining operator signer is available. Submit this transaction from the SentiLiquidityManager adminSafe ${adminSafe}.`,
        })
      }

      await publicClient.simulateContract({
        address: liquidityManager,
        abi: SENTI_LIQUIDITY_MANAGER_ABI,
        functionName: "setCompoundConfig",
        args: [minEthToCompound, compoundCooldown, maxEthPerCompound, maxSentiPerCompound, maxDeadlineWindow],
        account: localSignerAddress,
      })
      const hash = await walletClient!.writeContract({
        address: liquidityManager,
        abi: SENTI_LIQUIDITY_MANAGER_ABI,
        functionName: "setCompoundConfig",
        args: [minEthToCompound, compoundCooldown, maxEthPerCompound, maxSentiPerCompound, maxDeadlineWindow],
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
      if (receipt.status !== "success") return NextResponse.json({ error: "Transaction reverted", txHash: hash }, { status: 500 })
      return NextResponse.json({ ok: true, action, mode: "direct", txHash: hash, blockNumber: Number(receipt.blockNumber) })
    }

    if (action === "compoundLiquidity") {
      const liquidityIncrease = parseBigint("liquidityIncrease", parsed.body.liquidityIncrease)
      const amount0Max = parseTokenAmount("amount0Max", parsed.body.amount0Max)
      const amount1Max = parseTokenAmount("amount1Max", parsed.body.amount1Max)
      const deadline = parsed.body.deadline === undefined
        ? BigInt(Math.floor(Date.now() / 1000) + 300)
        : parseBigint("deadline", parsed.body.deadline)

      const [lastCompoundAt, compoundCooldown] = await Promise.all([
        publicClient.readContract({
          address: liquidityManager,
          abi: SENTI_LIQUIDITY_MANAGER_ABI,
          functionName: "lastCompoundAt",
        }),
        publicClient.readContract({
          address: liquidityManager,
          abi: SENTI_LIQUIDITY_MANAGER_ABI,
          functionName: "compoundCooldown",
        }),
      ])

      const now = BigInt(Math.floor(Date.now() / 1000))
      const nextCompoundAt = lastCompoundAt + compoundCooldown
      if (lastCompoundAt !== 0n && now < nextCompoundAt) {
        return NextResponse.json(
          {
            error: `Compound cooldown active until ${nextCompoundAt.toString()} (${new Date(Number(nextCompoundAt) * 1000).toISOString()})`,
            nextCompoundAt: nextCompoundAt.toString(),
          },
          { status: 409 },
        )
      }

      if (!signerCanCompound) {
        return manualResponse({
          action,
          to: liquidityManager,
          abi: SENTI_LIQUIDITY_MANAGER_ABI,
          functionName: "compoundLiquidity",
          args: [liquidityIncrease, amount0Max, amount1Max, deadline],
          requiredSigners: uniqueAddresses([adminSafe, opsSafe]),
          localSigner: localSignerAddress,
          warning: operator.warning,
          note: localSignerAddress
            ? `Configured signer ${localSignerAddress} is not authorized to compound on ${liquidityManager}. Submit this transaction from the adminSafe ${adminSafe}, opsSafe ${opsSafe}, or an already-authorized keeper.`
            : `No local mining operator signer is available. Submit this transaction from the adminSafe ${adminSafe}, opsSafe ${opsSafe}, or an already-authorized keeper.`,
        })
      }

      await publicClient.simulateContract({
        address: liquidityManager,
        abi: SENTI_LIQUIDITY_MANAGER_ABI,
        functionName: "compoundLiquidity",
        args: [liquidityIncrease, amount0Max, amount1Max, deadline],
        account: localSignerAddress,
      })
      const hash = await walletClient!.writeContract({
        address: liquidityManager,
        abi: SENTI_LIQUIDITY_MANAGER_ABI,
        functionName: "compoundLiquidity",
        args: [liquidityIncrease, amount0Max, amount1Max, deadline],
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
      if (receipt.status !== "success") return NextResponse.json({ error: "Transaction reverted", txHash: hash }, { status: 500 })
      return NextResponse.json({ ok: true, action, mode: "direct", txHash: hash, blockNumber: Number(receipt.blockNumber) })
    }

    if (action === "burnReserveSenti") {
      const amount = parseTokenAmount("amount", parsed.body.amount)
      if (!signerIsAdminSafe) {
        return manualResponse({
          action,
          to: liquidityManager,
          abi: SENTI_LIQUIDITY_MANAGER_ABI,
          functionName: "burnReserveSenti",
          args: [amount],
          requiredSigners: [adminSafe],
          localSigner: localSignerAddress,
          warning: operator.warning,
          note: localSignerAddress
            ? `Configured signer ${localSignerAddress} is not SentiLiquidityManager adminSafe ${adminSafe}. Submit this transaction from the admin Safe or a wallet that controls that address.`
            : `No local mining operator signer is available. Submit this transaction from the SentiLiquidityManager adminSafe ${adminSafe}.`,
        })
      }
      await publicClient.simulateContract({
        address: liquidityManager,
        abi: SENTI_LIQUIDITY_MANAGER_ABI,
        functionName: "burnReserveSenti",
        args: [amount],
        account: localSignerAddress,
      })
      const hash = await walletClient!.writeContract({
        address: liquidityManager,
        abi: SENTI_LIQUIDITY_MANAGER_ABI,
        functionName: "burnReserveSenti",
        args: [amount],
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
      if (receipt.status !== "success") return NextResponse.json({ error: "Transaction reverted", txHash: hash }, { status: 500 })
      return NextResponse.json({ ok: true, action, mode: "direct", txHash: hash, blockNumber: Number(receipt.blockNumber) })
    }

    if (action === "refreshPermit2Allowance") {
      if (!signerIsAdminSafe) {
        return manualResponse({
          action,
          to: liquidityManager,
          abi: SENTI_LIQUIDITY_MANAGER_ABI,
          functionName: "refreshPermit2Allowance",
          requiredSigners: [adminSafe],
          localSigner: localSignerAddress,
          warning: operator.warning,
          note: localSignerAddress
            ? `Configured signer ${localSignerAddress} is not SentiLiquidityManager adminSafe ${adminSafe}. Submit this transaction from the admin Safe or a wallet that controls that address.`
            : `No local mining operator signer is available. Submit this transaction from the SentiLiquidityManager adminSafe ${adminSafe}.`,
        })
      }
      await publicClient.simulateContract({
        address: liquidityManager,
        abi: SENTI_LIQUIDITY_MANAGER_ABI,
        functionName: "refreshPermit2Allowance",
        account: localSignerAddress,
      })
      const hash = await walletClient!.writeContract({
        address: liquidityManager,
        abi: SENTI_LIQUIDITY_MANAGER_ABI,
        functionName: "refreshPermit2Allowance",
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
      if (receipt.status !== "success") return NextResponse.json({ error: "Transaction reverted", txHash: hash }, { status: 500 })
      return NextResponse.json({ ok: true, action, mode: "direct", txHash: hash, blockNumber: Number(receipt.blockNumber) })
    }

    return NextResponse.json({ error: `Unsupported action: ${action}` }, { status: 400 })
  } catch (err) {
    console.error(`admin/token-action ${action} failed:`, err)
    const message = err instanceof Error ? err.message.split("\n")[0] : `${action} failed`
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204 })
}