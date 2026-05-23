"use client"

import Link from "next/link"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import { ArrowLeft, ArrowUpDown, ExternalLink, Loader2, RefreshCw, ShieldCheck } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useAccount, useBalance, useChainId, usePublicClient, useSwitchChain, useWriteContract } from "wagmi"
import {
  encodeAbiParameters,
  formatUnits,
  isAddressEqual,
  parseAbiParameters,
  parseEther,
  parseUnits,
  zeroAddress,
  type Address,
  type Hex,
} from "viem"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { miningExplorerTx, miningPublicConfig } from "@/lib/mining-config"
import {
  PERMIT2_ALLOWANCE_TRANSFER_ABI,
  SENTI_ABI,
  SENTI_LIQUIDITY_MANAGER_ABI,
  UNIVERSAL_ROUTER_ABI,
  V4_QUOTER_ABI,
} from "@/lib/mining-contracts"

type TradeMode = "buy" | "sell"

interface PoolKey {
  currency0: Address
  currency1: Address
  fee: number
  tickSpacing: number
  hooks: Address
}

interface QuoteState {
  status: "idle" | "loading" | "ready" | "error"
  amountOut: bigint | null
  minAmountOut: bigint | null
  gasEstimate: bigint | null
  error: string | null
  updatedAt: number | null
}

interface ApprovalState {
  loading: boolean
  erc20Allowance: bigint | null
  permit2Allowance: bigint | null
  permit2Expiration: number | null
  error: string | null
}

interface TokenBalanceState {
  value: bigint
  decimals: number
  symbol: string
}

const UNIVERSAL_ROUTER_BY_CHAIN: Record<number, Address> = {
  1: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
  11155111: "0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b",
}

const V4_SWAP_COMMAND: Hex = "0x10"
const V4_EXACT_INPUT_ACTIONS: Hex = "0x060c0f"
const MAX_UINT48 = 281_474_976_710_655
const MAX_UINT160 = (1n << 160n) - 1n
const MAX_UINT256 = (1n << 256n) - 1n
const DEFAULT_SLIPPAGE_BPS = 500
const DEFAULT_DEADLINE_MINUTES = 15

const EXACT_INPUT_SINGLE_PARAMETERS = parseAbiParameters(
  "((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)"
)
const SETTLE_TAKE_PARAMETERS = parseAbiParameters("address currency, uint256 amount")
const ROUTER_INPUT_PARAMETERS = parseAbiParameters("bytes actions, bytes[] params")

function formatAmount(value: bigint | null | undefined, decimals = 18, maxFraction = 6) {
  if (value === null || value === undefined) return "-"
  const formatted = formatUnits(value, decimals)
  if (!formatted.includes(".")) return formatted

  const [whole, fraction = ""] = formatted.split(".")
  const trimmedFraction = fraction.slice(0, maxFraction).replace(/0+$/, "")
  return trimmedFraction ? `${whole}.${trimmedFraction}` : whole
}

function toErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)

  if (message.includes("User rejected") || message.includes("rejected the request")) {
    return "Transaction rejected in wallet."
  }

  if (message.includes("insufficient funds")) {
    return "Wallet balance is too low for this transaction."
  }

  return message
}

function parseTradeAmount(value: string, mode: TradeMode) {
  const trimmed = value.trim()
  if (!trimmed) return null

  try {
    const parsed = mode === "buy" ? parseEther(trimmed) : parseUnits(trimmed, 18)
    return parsed > 0n ? parsed : null
  } catch {
    return null
  }
}

function routerAddressForChain(chainId: number) {
  const configured = process.env.NEXT_PUBLIC_UNISWAP_UNIVERSAL_ROUTER_ADDRESS?.trim()
  if (configured && /^0x[a-fA-F0-9]{40}$/.test(configured)) {
    return configured as Address
  }

  return UNIVERSAL_ROUTER_BY_CHAIN[chainId]
}

function encodeExactInputSwap(args: {
  poolKey: PoolKey
  inputCurrency: Address
  outputCurrency: Address
  amountIn: bigint
  minAmountOut: bigint
}) {
  const zeroForOne = isAddressEqual(args.inputCurrency, args.poolKey.currency0)

  const params = [
    encodeAbiParameters(EXACT_INPUT_SINGLE_PARAMETERS, [
      {
        poolKey: args.poolKey,
        zeroForOne,
        amountIn: args.amountIn,
        amountOutMinimum: args.minAmountOut,
        hookData: "0x",
      },
    ]),
    encodeAbiParameters(SETTLE_TAKE_PARAMETERS, [args.inputCurrency, args.amountIn]),
    encodeAbiParameters(SETTLE_TAKE_PARAMETERS, [args.outputCurrency, args.minAmountOut]),
  ]

  return {
    commands: V4_SWAP_COMMAND,
    inputs: [encodeAbiParameters(ROUTER_INPUT_PARAMETERS, [V4_EXACT_INPUT_ACTIONS, params])] as const,
  }
}

export default function TradePage() {
  const sentiToken = miningPublicConfig.miningChain.contracts.sentiToken
  const liquidityManager = miningPublicConfig.miningChain.contracts.liquidityManager
  const quoter = miningPublicConfig.miningChain.uniswap.v4Quoter
  const miningChainId = miningPublicConfig.miningChain.chainId
  const miningChainName = miningPublicConfig.miningChain.name
  const routerAddress = routerAddressForChain(miningChainId)

  const { address, isConnected } = useAccount()
  const activeChainId = useChainId()
  const publicClient = usePublicClient({ chainId: miningChainId })
  const { switchChainAsync, isPending: switchPending } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()

  const [mode, setMode] = useState<TradeMode>("buy")
  const [amount, setAmount] = useState("")
  const [slippageBps, setSlippageBps] = useState(DEFAULT_SLIPPAGE_BPS)
  const [deadlineMinutes, setDeadlineMinutes] = useState(DEFAULT_DEADLINE_MINUTES)
  const [poolKey, setPoolKey] = useState<PoolKey | null>(null)
  const [permit2Address, setPermit2Address] = useState<Address | null>(null)
  const [poolError, setPoolError] = useState<string | null>(null)
  const [quoteState, setQuoteState] = useState<QuoteState>({
    status: "idle",
    amountOut: null,
    minAmountOut: null,
    gasEstimate: null,
    error: null,
    updatedAt: null,
  })
  const [approvalState, setApprovalState] = useState<ApprovalState>({
    loading: false,
    erc20Allowance: null,
    permit2Allowance: null,
    permit2Expiration: null,
    error: null,
  })
  const [quoteRefreshNonce, setQuoteRefreshNonce] = useState(0)
  const [approvalRefreshNonce, setApprovalRefreshNonce] = useState(0)
  const [isApproving, setIsApproving] = useState(false)
  const [isSwapping, setIsSwapping] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [latestTxHash, setLatestTxHash] = useState<Hex | null>(null)

  const chainMismatch = isConnected && activeChainId !== miningChainId
  const amountIn = useMemo(() => parseTradeAmount(amount, mode), [amount, mode])

  const inputCurrency = useMemo(() => {
    if (!sentiToken) return null
    return mode === "buy" ? zeroAddress : sentiToken
  }, [mode, sentiToken])

  const outputCurrency = useMemo(() => {
    if (!poolKey || !inputCurrency) return null
    return isAddressEqual(inputCurrency, poolKey.currency0) ? poolKey.currency1 : poolKey.currency0
  }, [inputCurrency, poolKey])

  const zeroForOne = useMemo(() => {
    if (!poolKey || !inputCurrency) return null
    return isAddressEqual(inputCurrency, poolKey.currency0)
  }, [inputCurrency, poolKey])

  const shortcuts = mode === "buy" ? ["0.05", "0.1", "0.25", "0.5"] : ["500", "1000", "5000", "10000"]

  const { data: ethBalance, refetch: refetchEthBalance } = useBalance({
    address,
    chainId: miningChainId,
    query: { enabled: !!address },
  })
  const [sentiBalance, setSentiBalance] = useState<TokenBalanceState | null>(null)

  const refetchSentiBalance = useCallback(async () => {
    if (!publicClient || !address || !sentiToken) {
      setSentiBalance(null)
      return null
    }

    const value = await publicClient.readContract({
      address: sentiToken,
      abi: SENTI_ABI,
      functionName: "balanceOf",
      args: [address],
    })

    const nextBalance = {
      value,
      decimals: 18,
      symbol: "SENTI",
    } satisfies TokenBalanceState

    setSentiBalance(nextBalance)
    return nextBalance
  }, [address, publicClient, sentiToken])

  const sellApprovalReady = useMemo(() => {
    if (mode !== "sell") return true
    if (!amountIn) return false
    if (!approvalState.erc20Allowance || approvalState.erc20Allowance < amountIn) return false
    if (!approvalState.permit2Allowance || approvalState.permit2Allowance < amountIn) return false
    if (!approvalState.permit2Expiration) return false

    return approvalState.permit2Expiration > Math.floor(Date.now() / 1000)
  }, [amountIn, approvalState.erc20Allowance, approvalState.permit2Allowance, approvalState.permit2Expiration, mode])

  useEffect(() => {
    setAmount("")
    setActionError(null)
    setStatusMessage(null)
    setQuoteState({
      status: "idle",
      amountOut: null,
      minAmountOut: null,
      gasEstimate: null,
      error: null,
      updatedAt: null,
    })
  }, [mode])

  useEffect(() => {
    void refetchSentiBalance()
  }, [refetchSentiBalance])

  useEffect(() => {
    if (!publicClient || !liquidityManager || !sentiToken) {
      setPoolKey(null)
      setPermit2Address(null)
      return
    }

    let active = true

    void (async () => {
      try {
        setPoolError(null)

        const [rawPoolKey, rawPermit2] = await Promise.all([
          publicClient.readContract({
            address: liquidityManager,
            abi: SENTI_LIQUIDITY_MANAGER_ABI,
            functionName: "poolKey",
          }),
          publicClient.readContract({
            address: liquidityManager,
            abi: SENTI_LIQUIDITY_MANAGER_ABI,
            functionName: "permit2",
          }),
        ])

        if (!active) return

        const [currency0, currency1, fee, tickSpacing, hooks] = rawPoolKey
        const nextPoolKey = {
          currency0,
          currency1,
          fee: Number(fee),
          tickSpacing: Number(tickSpacing),
          hooks,
        } satisfies PoolKey

        if (!isAddressEqual(nextPoolKey.currency0, zeroAddress) && !isAddressEqual(nextPoolKey.currency1, zeroAddress)) {
          throw new Error("Configured pool is not an ETH pair.")
        }

        if (!isAddressEqual(nextPoolKey.currency0, sentiToken) && !isAddressEqual(nextPoolKey.currency1, sentiToken)) {
          throw new Error("Configured liquidity manager does not point at the SENTI pool.")
        }

        setPoolKey(nextPoolKey)
        setPermit2Address(rawPermit2)
      } catch (error) {
        if (!active) return
        setPoolError(toErrorMessage(error))
      }
    })()

    return () => {
      active = false
    }
  }, [liquidityManager, publicClient, sentiToken])

  useEffect(() => {
    if (!publicClient || !quoter || !poolKey || zeroForOne === null || !amountIn) {
      setQuoteState({
        status: amount.trim() ? "error" : "idle",
        amountOut: null,
        minAmountOut: null,
        gasEstimate: null,
        error: amount.trim() ? "Enter a valid positive amount." : null,
        updatedAt: null,
      })
      return
    }

    let active = true
    const timeout = window.setTimeout(() => {
      void (async () => {
        try {
          setQuoteState({
            status: "loading",
            amountOut: null,
            minAmountOut: null,
            gasEstimate: null,
            error: null,
            updatedAt: null,
          })

          const quoteResult = await publicClient.readContract({
            address: quoter,
            abi: V4_QUOTER_ABI,
            functionName: "quoteExactInputSingle",
            args: [
              {
                poolKey,
                zeroForOne,
                exactAmount: amountIn,
                hookData: "0x",
              },
            ],
          }) as readonly [bigint, bigint]

          const [amountOut, gasEstimate] = quoteResult

          if (!active) return

          const boundedSlippage = Math.min(Math.max(slippageBps, 1), 5_000)
          const minAmountOut = amountOut * BigInt(10_000 - boundedSlippage) / 10_000n

          setQuoteState({
            status: "ready",
            amountOut,
            minAmountOut,
            gasEstimate,
            error: null,
            updatedAt: Date.now(),
          })
        } catch (error) {
          if (!active) return

          setQuoteState({
            status: "error",
            amountOut: null,
            minAmountOut: null,
            gasEstimate: null,
            error: toErrorMessage(error),
            updatedAt: null,
          })
        }
      })()
    }, 300)

    return () => {
      active = false
      window.clearTimeout(timeout)
    }
  }, [amount, amountIn, poolKey, publicClient, quoter, quoteRefreshNonce, slippageBps, zeroForOne])

  useEffect(() => {
    if (!publicClient || !address || !sentiToken || !permit2Address || !routerAddress || mode !== "sell") {
      setApprovalState({
        loading: false,
        erc20Allowance: null,
        permit2Allowance: null,
        permit2Expiration: null,
        error: null,
      })
      return
    }

    let active = true

    void (async () => {
      try {
        setApprovalState((current) => ({ ...current, loading: true, error: null }))

        const [erc20Allowance, permit2Allowance] = await Promise.all([
          publicClient.readContract({
            address: sentiToken,
            abi: SENTI_ABI,
            functionName: "allowance",
            args: [address, permit2Address],
          }),
          publicClient.readContract({
            address: permit2Address,
            abi: PERMIT2_ALLOWANCE_TRANSFER_ABI,
            functionName: "allowance",
            args: [address, sentiToken, routerAddress],
          }),
        ])

        if (!active) return

        const [permit2Amount, permit2Expiration] = permit2Allowance as readonly [bigint, number, number]

        setApprovalState({
          loading: false,
          erc20Allowance,
          permit2Allowance: permit2Amount,
          permit2Expiration,
          error: null,
        })
      } catch (error) {
        if (!active) return

        setApprovalState({
          loading: false,
          erc20Allowance: null,
          permit2Allowance: null,
          permit2Expiration: null,
          error: toErrorMessage(error),
        })
      }
    })()

    return () => {
      active = false
    }
  }, [address, mode, permit2Address, publicClient, routerAddress, sentiToken, approvalRefreshNonce])

  const handleSwitchChain = async () => {
    if (!switchChainAsync) return
    setActionError(null)

    try {
      await switchChainAsync({ chainId: miningChainId })
    } catch (error) {
      setActionError(toErrorMessage(error))
    }
  }

  const enableSelling = async () => {
    if (!address || !publicClient || !sentiToken || !permit2Address || !routerAddress || !amountIn) {
      setActionError("Wallet, token approvals, or trade amount are not ready.")
      return
    }

    setIsApproving(true)
    setActionError(null)
    setStatusMessage("Preparing SENTI approvals for sell orders.")

    try {
      if (!approvalState.erc20Allowance || approvalState.erc20Allowance < amountIn) {
        const approvalHash = await writeContractAsync({
          address: sentiToken,
          abi: SENTI_ABI,
          functionName: "approve",
          args: [permit2Address, MAX_UINT256],
          chainId: miningChainId,
        })

        setLatestTxHash(approvalHash)
        setStatusMessage("Waiting for SENTI approval confirmation.")
        await publicClient.waitForTransactionReceipt({ hash: approvalHash })
      }

      if (
        !approvalState.permit2Allowance ||
        approvalState.permit2Allowance < amountIn ||
        !approvalState.permit2Expiration ||
        approvalState.permit2Expiration <= Math.floor(Date.now() / 1000)
      ) {
        const permit2Hash = await writeContractAsync({
          address: permit2Address,
          abi: PERMIT2_ALLOWANCE_TRANSFER_ABI,
          functionName: "approve",
          args: [sentiToken, routerAddress, MAX_UINT160, MAX_UINT48],
          chainId: miningChainId,
        })

        setLatestTxHash(permit2Hash)
        setStatusMessage("Waiting for Permit2 approval confirmation.")
        await publicClient.waitForTransactionReceipt({ hash: permit2Hash })
      }

      setStatusMessage("Sell approvals are ready.")
      setApprovalRefreshNonce((value) => value + 1)
      await refetchSentiBalance()
    } catch (error) {
      setActionError(toErrorMessage(error))
      setStatusMessage(null)
    } finally {
      setIsApproving(false)
    }
  }

  const submitSwap = async () => {
    if (!address || !publicClient || !routerAddress || !poolKey || !inputCurrency || !outputCurrency || !amountIn) {
      setActionError("Trade route is not ready yet.")
      return
    }

    if (!quoteState.minAmountOut) {
      setActionError("Quote is still loading. Refresh it and try again.")
      return
    }

    if (mode === "sell" && !sellApprovalReady) {
      setActionError("Enable SENTI selling first.")
      return
    }

    setIsSwapping(true)
    setActionError(null)
    setStatusMessage("Submitting swap transaction.")

    try {
      const { commands, inputs } = encodeExactInputSwap({
        poolKey,
        inputCurrency,
        outputCurrency,
        amountIn,
        minAmountOut: quoteState.minAmountOut,
      })
      const deadline = BigInt(Math.floor(Date.now() / 1000) + Math.max(1, deadlineMinutes) * 60)
      const swapHash = await writeContractAsync({
        address: routerAddress,
        abi: UNIVERSAL_ROUTER_ABI,
        functionName: "execute",
        args: [commands, inputs, deadline],
        value: mode === "buy" ? amountIn : 0n,
        chainId: miningChainId,
      })

      setLatestTxHash(swapHash)
      setStatusMessage("Waiting for trade confirmation.")
      await publicClient.waitForTransactionReceipt({ hash: swapHash })
      setStatusMessage(`${mode === "buy" ? "Buy" : "Sell"} transaction confirmed.`)
      setQuoteRefreshNonce((value) => value + 1)
      setApprovalRefreshNonce((value) => value + 1)
      await Promise.all([refetchEthBalance(), refetchSentiBalance()])
    } catch (error) {
      setActionError(toErrorMessage(error))
      setStatusMessage(null)
    } finally {
      setIsSwapping(false)
    }
  }

  const tradeBlockedReason = !sentiToken
    ? "NEXT_PUBLIC_SENTI_TOKEN_ADDRESS is missing."
    : !liquidityManager
      ? "NEXT_PUBLIC_SENTI_LIQUIDITY_MANAGER_ADDRESS is missing."
      : !quoter
        ? "Uniswap v4 Quoter is not configured for this chain."
        : !routerAddress
          ? "Universal Router address is not configured for this chain."
          : poolError
            ? poolError
            : null

  const primaryActionDisabled =
    isSwapping ||
    isApproving ||
    !isConnected ||
    chainMismatch ||
    !amountIn ||
    !quoteState.minAmountOut ||
    !!tradeBlockedReason ||
    (mode === "sell" && !sellApprovalReady)

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <section className="space-y-3 border-b border-sentinel/15 pb-6">
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/mine"
            className="inline-flex h-8 items-center justify-center gap-1 rounded-lg border border-border bg-background/70 px-3 text-sm font-medium text-foreground transition hover:bg-muted"
          >
            <ArrowLeft className="size-4" /> Back to Mine
          </Link>
          <span className="inline-flex h-7 items-center rounded-full border border-sentinel/25 bg-sentinel/10 px-3 text-[11px] uppercase tracking-[0.2em] text-sentinel">
            live senti trade
          </span>
        </div>
        <div className="space-y-2">
          <h1 className="font-pixel text-xl text-sentinel sm:text-3xl">Trade SENTI</h1>
          <p className="max-w-3xl text-sm text-muted-foreground sm:text-base">
            Buy or sell directly from this page using the live Uniswap v4 pool and the Universal Router on {miningChainName}. Quotes come from the v4 Quoter, and the current hook fee is reflected in the output quote.
          </p>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.85fr)]">
        <Card className="sentinel-card rounded-lg border border-sentinel/15 bg-card/90">
          <CardHeader className="gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <ArrowUpDown className="size-4 text-sentinel" /> Exact-Input Swap
              </CardTitle>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setMode("buy")}
                  className={`inline-flex h-8 items-center rounded-lg border px-3 text-sm font-medium transition ${mode === "buy" ? "border-sentinel/30 bg-sentinel/10 text-sentinel" : "border-border bg-background/70 text-foreground hover:bg-muted"}`}
                >
                  Buy
                </button>
                <button
                  type="button"
                  onClick={() => setMode("sell")}
                  className={`inline-flex h-8 items-center rounded-lg border px-3 text-sm font-medium transition ${mode === "sell" ? "border-sentinel/30 bg-sentinel/10 text-sentinel" : "border-border bg-background/70 text-foreground hover:bg-muted"}`}
                >
                  Sell
                </button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="rounded-xl border border-sentinel/15 bg-background/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                    {mode === "buy" ? "You pay" : "You sell"}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Balance: {mode === "buy" ? `${formatAmount(ethBalance?.value)} ETH` : `${formatAmount(sentiBalance?.value)} SENTI`}
                  </div>
                </div>
                <div className="text-sm font-medium text-foreground">{mode === "buy" ? "ETH" : "SENTI"}</div>
              </div>
              <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
                <label className="flex-1">
                  <span className="sr-only">Trade amount</span>
                  <input
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    inputMode="decimal"
                    placeholder={mode === "buy" ? "0.10" : "1000"}
                    className="h-14 w-full rounded-lg border border-sentinel/20 bg-card/70 px-4 text-xl text-foreground outline-none transition placeholder:text-muted-foreground/60 focus:border-sentinel/40"
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  {shortcuts.map((shortcut) => (
                    <button
                      key={shortcut}
                      type="button"
                      onClick={() => setAmount(shortcut)}
                      className="inline-flex h-9 items-center rounded-lg border border-border bg-background/70 px-3 text-sm text-foreground transition hover:bg-muted"
                    >
                      {shortcut}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-sentinel/15 bg-background/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Estimated receive</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Minimum after slippage: {quoteState.minAmountOut ? `${formatAmount(quoteState.minAmountOut)} ${mode === "buy" ? "SENTI" : "ETH"}` : "-"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setQuoteRefreshNonce((value) => value + 1)}
                  className="inline-flex h-8 items-center gap-1 rounded-lg border border-border bg-background/70 px-3 text-xs font-medium text-foreground transition hover:bg-muted"
                >
                  <RefreshCw className="size-3.5" /> Refresh quote
                </button>
              </div>
              <div className="mt-4 flex min-h-14 items-center justify-between gap-3 rounded-lg border border-sentinel/10 bg-card/70 px-4">
                <div className="text-2xl text-foreground">
                  {quoteState.status === "loading" ? "Refreshing..." : quoteState.amountOut ? formatAmount(quoteState.amountOut) : "-"}
                </div>
                <div className="text-sm font-medium text-foreground">{mode === "buy" ? "SENTI" : "ETH"}</div>
              </div>
              <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
                <span>Slippage: {slippageBps / 100}%</span>
                <span>Deadline: {deadlineMinutes} min</span>
                <span>Gas estimate: {quoteState.gasEstimate ? quoteState.gasEstimate.toLocaleString() : "-"}</span>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-2">
                <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Slippage %</span>
                <input
                  value={(slippageBps / 100).toString()}
                  onChange={(event) => {
                    const next = Number(event.target.value)
                    if (!Number.isFinite(next)) {
                      setSlippageBps(DEFAULT_SLIPPAGE_BPS)
                      return
                    }
                    setSlippageBps(Math.max(1, Math.min(5000, Math.round(next * 100))))
                  }}
                  inputMode="decimal"
                  className="h-11 w-full rounded-lg border border-sentinel/20 bg-card/70 px-3 text-sm text-foreground outline-none transition focus:border-sentinel/40"
                />
              </label>
              <label className="space-y-2">
                <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Deadline minutes</span>
                <input
                  value={deadlineMinutes.toString()}
                  onChange={(event) => {
                    const next = Number(event.target.value)
                    if (!Number.isFinite(next)) {
                      setDeadlineMinutes(DEFAULT_DEADLINE_MINUTES)
                      return
                    }
                    setDeadlineMinutes(Math.max(1, Math.min(60, Math.round(next))))
                  }}
                  inputMode="numeric"
                  className="h-11 w-full rounded-lg border border-sentinel/20 bg-card/70 px-3 text-sm text-foreground outline-none transition focus:border-sentinel/40"
                />
              </label>
            </div>

            {tradeBlockedReason ? (
              <div className="rounded-lg border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-100">
                {tradeBlockedReason}
              </div>
            ) : null}

            {quoteState.error ? (
              <div className="rounded-lg border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-100">
                {quoteState.error}
              </div>
            ) : null}

            {approvalState.error ? (
              <div className="rounded-lg border border-yellow-400/30 bg-yellow-400/10 px-4 py-3 text-sm text-yellow-100">
                {approvalState.error}
              </div>
            ) : null}

            {actionError ? (
              <div className="rounded-lg border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-100">
                {actionError}
              </div>
            ) : null}

            <div className="space-y-3">
              {!isConnected ? (
                <div className="rounded-lg border border-sentinel/15 bg-background/60 p-4">
                  <div className="mb-3 text-sm text-muted-foreground">Connect a wallet on {miningChainName} to trade.</div>
                  <ConnectButton showBalance={false} />
                </div>
              ) : chainMismatch ? (
                <Button className="h-11 w-full justify-center" onClick={() => void handleSwitchChain()} disabled={switchPending}>
                  {switchPending ? <Loader2 className="size-4 animate-spin" /> : null}
                  Switch to {miningChainName}
                </Button>
              ) : mode === "sell" && !sellApprovalReady ? (
                <Button className="h-11 w-full justify-center" onClick={() => void enableSelling()} disabled={isApproving || !amountIn || !!tradeBlockedReason || approvalState.loading}>
                  {isApproving ? <Loader2 className="size-4 animate-spin" /> : null}
                  Enable SENTI Selling
                </Button>
              ) : (
                <Button className="h-11 w-full justify-center" onClick={() => void submitSwap()} disabled={primaryActionDisabled}>
                  {isSwapping ? <Loader2 className="size-4 animate-spin" /> : null}
                  {mode === "buy" ? "Buy SENTI" : "Sell SENTI"}
                </Button>
              )}

              <div className="rounded-lg border border-sentinel/15 bg-background/60 px-4 py-3 text-xs text-muted-foreground">
                Exact-input only. Your current hook rejects exact-output swaps, so this page quotes and executes the exact amount you enter.
              </div>

              {statusMessage ? (
                <div className="rounded-lg border border-sentinel/20 bg-sentinel/10 px-4 py-3 text-sm text-sentinel">
                  {statusMessage}
                </div>
              ) : null}

              {latestTxHash ? (
                <a
                  href={miningExplorerTx(latestTxHash)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-sentinel transition hover:text-sentinel/80"
                >
                  View latest transaction <ExternalLink className="size-4" />
                </a>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card className="sentinel-card rounded-lg border border-sentinel/15 bg-card/90">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="size-4 text-sentinel" /> Route
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <div className="rounded-lg border border-sentinel/15 bg-background/60 p-3">
                Chain: <span className="text-foreground">{miningChainName}</span>
              </div>
              <div className="rounded-lg border border-sentinel/15 bg-background/60 p-3">
                Router: <span className="break-all text-foreground">{routerAddress ?? "Unavailable"}</span>
              </div>
              <div className="rounded-lg border border-sentinel/15 bg-background/60 p-3">
                Quoter: <span className="break-all text-foreground">{quoter ?? "Unavailable"}</span>
              </div>
              <div className="rounded-lg border border-sentinel/15 bg-background/60 p-3">
                SENTI: <span className="break-all text-foreground">{sentiToken ?? "Unavailable"}</span>
              </div>
              {permit2Address ? (
                <div className="rounded-lg border border-sentinel/15 bg-background/60 p-3">
                  Permit2: <span className="break-all text-foreground">{permit2Address}</span>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card className="sentinel-card rounded-lg border border-sentinel/15 bg-card/90">
            <CardHeader>
              <CardTitle className="text-base">Execution Notes</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>
                The quote is read directly from the Uniswap v4 Quoter on the configured chain. The swap is then sent to the Universal Router with the current pool key from your liquidity manager.
              </p>
              <p>
                Sell orders need two approvals the first time: SENTI to Permit2, then Permit2 to the Universal Router. Buy orders use native ETH and do not need token approval.
              </p>
              <p>
                If the market moves or your slippage is too tight, the router transaction will revert instead of filling at a worse rate.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  )
}