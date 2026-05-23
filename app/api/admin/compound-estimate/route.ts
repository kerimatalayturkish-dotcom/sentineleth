import { NextRequest, NextResponse } from "next/server"
import { createPublicClient, formatEther, http, parseAbiItem, parseEther } from "viem"
import { requireAdminWithRateLimit } from "@/lib/auth"
import { resolveMiningOperator, sameAddress } from "@/lib/mining-admin-actions"
import { getOptionalMiningServerConfig } from "@/lib/mining-server-config"
import { miningChain, miningPublicConfig } from "@/lib/mining-config"
import { SENTI_ABI, SENTI_LIQUIDITY_MANAGER_ABI } from "@/lib/mining-contracts"
import { readTrackedPositionComposition } from "@/lib/mining-position"
import { readJsonBody } from "@/lib/safe-body"

interface Body {
  ethAmount?: unknown
}

const COMPOUND_EVENT = parseAbiItem(
  "event LiquidityCompounded(address indexed caller, uint256 indexed tokenId, uint256 liquidityIncrease, uint256 sentiAmountMax, uint256 ethAmountMax, uint256 deadline)",
)
const MAX_LOG_SCAN_BLOCKS = 200_000n
const LOG_SCAN_CHUNK_SIZE = 10_000n

function parseTokenAmount(name: string, value: unknown): bigint {
  const raw = String(value ?? "").trim()
  if (!raw) throw new Error(`${name} is required`)
  try {
    return parseEther(raw)
  } catch {
    throw new Error(`${name} must be a valid decimal amount`)
  }
}

function minBigint(...values: bigint[]): bigint {
  return values.reduce((smallest, value) => (value < smallest ? value : smallest))
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("division by zero")
  return numerator === 0n ? 0n : ((numerator - 1n) / denominator) + 1n
}

async function canSimulateCompound(
  publicClient: ReturnType<typeof createPublicClient>,
  account: `0x${string}`,
  liquidityManager: `0x${string}`,
  liquidityIncrease: bigint,
  amount0Max: bigint,
  amount1Max: bigint,
  deadline: bigint,
) {
  try {
    await publicClient.simulateContract({
      address: liquidityManager,
      abi: SENTI_LIQUIDITY_MANAGER_ABI,
      functionName: "compoundLiquidity",
      args: [liquidityIncrease, amount0Max, amount1Max, deadline],
      account,
    })
    return true
  } catch {
    return false
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAdminWithRateLimit(request, { bucket: "admin-compound-estimate", limit: 30 })
  if (auth instanceof Response) return auth

  const parsed = await readJsonBody<Body>(request)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status })

  let targetEth: bigint
  try {
    targetEth = parseTokenAmount("ethAmount", parsed.body.ethAmount)
  } catch (err) {
    const message = err instanceof Error ? err.message : "ethAmount is invalid"
    return NextResponse.json({ error: message }, { status: 400 })
  }

  const config = getOptionalMiningServerConfig()
  if (!config.miningChain.rpcUrl) {
    return NextResponse.json({ error: "MINING_RPC_URL not configured" }, { status: 503 })
  }
  const operator = resolveMiningOperator(config)
  const adminAccount = operator.account

  const liquidityManager = config.miningChain.contracts.liquidityManager
  if (!liquidityManager) {
    return NextResponse.json({ error: "NEXT_PUBLIC_SENTI_LIQUIDITY_MANAGER_ADDRESS not configured" }, { status: 503 })
  }

  const publicClient = createPublicClient({ chain: miningChain, transport: http(config.miningChain.rpcUrl) })

  try {
    const senti = await publicClient.readContract({
      address: liquidityManager,
      abi: SENTI_LIQUIDITY_MANAGER_ABI,
      functionName: "senti",
    })

    const [
      adminSafe,
      opsSafe,
      isAuthorizedKeeper,
      positionManager,
      trackedPositionTokenId,
      sentiIsCurrency0,
      minEthToCompound,
      compoundCooldown,
      maxEthPerCompound,
      maxSentiPerCompound,
      maxDeadlineWindow,
      lastCompoundAt,
      reserveEthBalance,
      reserveSentiBalance,
    ] = await Promise.all([
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
      publicClient.readContract({ address: liquidityManager, abi: SENTI_LIQUIDITY_MANAGER_ABI, functionName: "positionManager" }),
      publicClient.readContract({ address: liquidityManager, abi: SENTI_LIQUIDITY_MANAGER_ABI, functionName: "trackedPositionTokenId" }),
      publicClient.readContract({ address: liquidityManager, abi: SENTI_LIQUIDITY_MANAGER_ABI, functionName: "sentiIsCurrency0" }),
      publicClient.readContract({ address: liquidityManager, abi: SENTI_LIQUIDITY_MANAGER_ABI, functionName: "minEthToCompound" }),
      publicClient.readContract({ address: liquidityManager, abi: SENTI_LIQUIDITY_MANAGER_ABI, functionName: "compoundCooldown" }),
      publicClient.readContract({ address: liquidityManager, abi: SENTI_LIQUIDITY_MANAGER_ABI, functionName: "maxEthPerCompound" }),
      publicClient.readContract({ address: liquidityManager, abi: SENTI_LIQUIDITY_MANAGER_ABI, functionName: "maxSentiPerCompound" }),
      publicClient.readContract({ address: liquidityManager, abi: SENTI_LIQUIDITY_MANAGER_ABI, functionName: "maxDeadlineWindow" }),
      publicClient.readContract({ address: liquidityManager, abi: SENTI_LIQUIDITY_MANAGER_ABI, functionName: "lastCompoundAt" }),
      publicClient.getBalance({ address: liquidityManager }),
      publicClient.readContract({
        address: senti,
        abi: SENTI_ABI,
        functionName: "balanceOf",
        args: [liquidityManager],
      }),
    ])

    const signerCanCompound =
      sameAddress(adminSafe, adminAccount?.address)
      || sameAddress(opsSafe, adminAccount?.address)
      || isAuthorizedKeeper
    const simulationAccount = signerCanCompound
      ? adminAccount?.address ?? adminSafe
      : adminSafe

    if (targetEth < minEthToCompound) {
      return NextResponse.json(
        { error: `ETH target must be at least ${formatEther(minEthToCompound)} ETH` },
        { status: 400 },
      )
    }
    if (targetEth > maxEthPerCompound) {
      return NextResponse.json(
        { error: `ETH target must not exceed ${formatEther(maxEthPerCompound)} ETH` },
        { status: 400 },
      )
    }
    if (targetEth > reserveEthBalance) {
      return NextResponse.json(
        { error: `Manager only has ${formatEther(reserveEthBalance)} ETH available` },
        { status: 400 },
      )
    }

    const latestBlock = await publicClient.getBlockNumber()
    let remainingBlocksToScan = MAX_LOG_SCAN_BLOCKS
    let chunkEnd = latestBlock
    let latestCompound:
      | {
          args: {
            liquidityIncrease: bigint | undefined
            sentiAmountMax: bigint | undefined
            ethAmountMax: bigint | undefined
          }
          transactionHash: `0x${string}` | null
          blockNumber: bigint
          logIndex: number | null
        }
      | undefined

    while (!latestCompound && remainingBlocksToScan > 0n) {
      const currentChunkSize = remainingBlocksToScan < LOG_SCAN_CHUNK_SIZE ? remainingBlocksToScan : LOG_SCAN_CHUNK_SIZE
      const chunkStart = chunkEnd >= currentChunkSize ? chunkEnd - currentChunkSize + 1n : 0n
      const logs = await publicClient.getLogs({
        address: liquidityManager,
        event: COMPOUND_EVENT,
        fromBlock: chunkStart,
        toBlock: chunkEnd,
      })

      logs.sort((left, right) => {
        if (left.blockNumber === right.blockNumber) {
          return Number((right.logIndex ?? 0) - (left.logIndex ?? 0))
        }
        return Number(right.blockNumber - left.blockNumber)
      })

      const newestLog = logs[0]
      if (newestLog) {
        latestCompound = {
          args: {
            liquidityIncrease: newestLog.args.liquidityIncrease,
            sentiAmountMax: newestLog.args.sentiAmountMax,
            ethAmountMax: newestLog.args.ethAmountMax,
          },
          transactionHash: newestLog.transactionHash ?? null,
          blockNumber: newestLog.blockNumber,
          logIndex: newestLog.logIndex ?? null,
        }
        break
      }

      if (chunkStart === 0n) break
      remainingBlocksToScan -= currentChunkSize
      chunkEnd = chunkStart - 1n
    }

    let basisSource: "compound_history" | "tracked_position"
    let basisTxHash: `0x${string}` | null
    let basisBlockNumber: bigint | null
    let basisLiquidityIncrease: bigint
    let basisEthMax: bigint
    let basisSentiMax: bigint
    let basisTrackedPositionTokenId: bigint | null = null
    let basisCurrentTick: number | null = null

    if (latestCompound?.args.liquidityIncrease && latestCompound.transactionHash) {
      const historyEthMax = latestCompound.args.ethAmountMax
      const historySentiMax = latestCompound.args.sentiAmountMax
      if (!historyEthMax || !historySentiMax) {
        return NextResponse.json(
          { error: "Latest successful compound is missing the cap values needed for estimation" },
          { status: 409 },
        )
      }

      basisSource = "compound_history"
      basisTxHash = latestCompound.transactionHash
      basisBlockNumber = latestCompound.blockNumber
      basisLiquidityIncrease = latestCompound.args.liquidityIncrease
      basisEthMax = historyEthMax
      basisSentiMax = historySentiMax
    } else {
      const poolManager = miningPublicConfig.miningChain.uniswap.v4PoolManager
      if (!poolManager) {
        return NextResponse.json(
          { error: "No successful compound history found and NEXT_PUBLIC_UNISWAP_V4_POOL_MANAGER_ADDRESS is not configured for live fallback." },
          { status: 503 },
        )
      }
      if (trackedPositionTokenId === 0n) {
        return NextResponse.json(
          { error: "No successful compound history found yet, and no tracked LP position is set on the manager." },
          { status: 409 },
        )
      }

      const trackedPosition = await readTrackedPositionComposition({
        miningClient: publicClient,
        poolManager,
        positionManager,
        trackedPositionTokenId,
        sentiIsCurrency0,
      })

      if (
        trackedPosition.liquidity === 0n
        || trackedPosition.ethBalanceWei === null
        || trackedPosition.sentiBalanceWei === null
        || trackedPosition.ethBalanceWei === 0n
        || trackedPosition.sentiBalanceWei === 0n
      ) {
        return NextResponse.json(
          { error: "No successful compound history found yet, and the current tracked LP position does not expose a usable live two-sided balance anchor." },
          { status: 409 },
        )
      }

      basisSource = "tracked_position"
      basisTxHash = null
      basisBlockNumber = null
      basisLiquidityIncrease = trackedPosition.liquidity
      basisEthMax = trackedPosition.ethBalanceWei
      basisSentiMax = trackedPosition.sentiBalanceWei
      basisTrackedPositionTokenId = trackedPositionTokenId
      basisCurrentTick = trackedPosition.currentTick
    }

    const baseSenti = ceilDiv(basisSentiMax * targetEth, basisEthMax)
    const sentiBuffer = baseSenti / 20n
    const suggestedSentiMax = minBigint(
      reserveSentiBalance,
      maxSentiPerCompound,
      baseSenti + (sentiBuffer > 0n ? sentiBuffer : 1n),
    )
    if (suggestedSentiMax === 0n) {
      return NextResponse.json({ error: "Manager has no SENTI available to compound" }, { status: 400 })
    }

    const rawLiquidityIncrease = (basisLiquidityIncrease * targetEth) / basisEthMax
    if (rawLiquidityIncrease <= 0n) {
      return NextResponse.json({ error: "Target ETH is too small to produce a positive liquidity increase" }, { status: 400 })
    }

    const amount0Max = sentiIsCurrency0 ? suggestedSentiMax : targetEth
    const amount1Max = sentiIsCurrency0 ? targetEth : suggestedSentiMax

    const now = Math.floor(Date.now() / 1000)
    const deadlineOffset = Math.min(300, Number(maxDeadlineWindow))
    const deadline = BigInt(now + deadlineOffset)
    const nextCompoundAt = Number(lastCompoundAt + compoundCooldown)
    const cooldownActive = Number(lastCompoundAt) !== 0 && now < nextCompoundAt

    let recommendedLiquidityIncrease = rawLiquidityIncrease
    let validated = false

    if (!cooldownActive) {
      let low = 1n
      let high = rawLiquidityIncrease
      let best = 0n
      while (low <= high) {
        const mid = (low + high) / 2n
        if (await canSimulateCompound(publicClient, simulationAccount, liquidityManager, mid, amount0Max, amount1Max, deadline)) {
          best = mid
          low = mid + 1n
        } else {
          high = mid - 1n
        }
      }

      if (best === 0n) {
        return NextResponse.json(
          { error: "Estimator could not find a valid liquidity increase for that ETH target under the current caps" },
          { status: 409 },
        )
      }

      recommendedLiquidityIncrease = best
      validated = true
    }

    return NextResponse.json({
      ok: true,
      targetEth: formatEther(targetEth),
      amount0Max: formatEther(amount0Max),
      amount1Max: formatEther(amount1Max),
      estimatedSenti: formatEther(suggestedSentiMax),
      liquidityIncrease: recommendedLiquidityIncrease.toString(),
      validated,
      cooldownActive,
      nextCompoundAt,
      deadlineOffset,
      sentiIsCurrency0,
      basis: {
        source: basisSource,
        txHash: basisTxHash,
        blockNumber: basisBlockNumber === null ? null : Number(basisBlockNumber),
        liquidityIncrease: basisLiquidityIncrease.toString(),
        ethAmountMax: formatEther(basisEthMax),
        sentiAmountMax: formatEther(basisSentiMax),
        trackedPositionTokenId: basisTrackedPositionTokenId === null ? null : basisTrackedPositionTokenId.toString(),
        currentTick: basisCurrentTick,
      },
    })
  } catch (err) {
    console.error("admin/compound-estimate failed:", err)
    const message = err instanceof Error ? err.message.split("\n")[0] : "compound estimate failed"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}