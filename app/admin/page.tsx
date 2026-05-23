"use client"

import { useState, useEffect, useCallback, useRef } from "react"

interface ContractStatus {
  contract: {
    address: string
    treasury: string
    watcher: string | null
    watcherHasUriSetterRole: boolean
    ownerSigner: string | null
    ownerHasAdminRole: boolean
    ownerConfigured: boolean
    airdropRoot: string
    airdropRootSet: boolean
    publicClosed: boolean
    airdropClosed: boolean
    paused: boolean
  }
  constants: {
    maxSupply: number
    publicCap: number
    airdropCap: number
    mintPrice: string
    mintPriceWei: string
    currency: string
    maxPerWallet: number
  }
  supply: {
    total: number
    max: number
    publicMinted: number
    publicCap: number
    publicRemaining: number
    airdropMinted: number
    airdropCap: number
    airdropRemaining: number
    remaining: number
  }
  balances: {
    treasuryEth: string | null
    serverEth: string | null
    contractEth: string | null
  }
  timing: { now: number }
}

interface WalletHistory {
  address: string
  counters: {
    publicMintedBy: number
    currentBalance: number
    totalMintsInWindow: number
  }
  mints: Array<{
    tokenId: number
    mintTxHash: string
    mintSigner: string | null
    ethPaid: string
    blockNumber: number
    mintedAt: number
  }>
  lookbackFromBlock: number
  lookbackToBlock: number
}

interface IrysStatus {
  address: string
  network: "devnet" | "mainnet"
  token: string
  loadedBalanceAtomic: string
  loadedBalance: string
  estimate: {
    bytes: number
    priceAtomic: string
    price: string
    estimatedMintsRemaining: number | null
  } | null
}

interface AdminAuthResponse {
  ok?: boolean
  requiresTotp?: boolean
  resetTotpStep?: boolean
  error?: string
}

interface ManualExecutionPayload {
  to: string
  data: string
  valueWei: string
  valueEth: string
  chainId: number
  chainName: string
  requiredSigners: string[]
  note: string
}

interface OperatorActionResult {
  action: string
  mode: "direct" | "manual"
  txHash: string | null
  localSigner?: string | null
  warning?: string | null
  execution: ManualExecutionPayload | null
}

interface MiningStatus {
  configured: boolean
  error: string | null
  chainId: number
  chainName: string
  explorerUrl: string
  contract: {
    address: string
    admin: string
    adminSigner: string | null
    adminSignerConfigured: boolean
    adminSignerIsAdmin: boolean
    signer: string
    senti: string
    currentBlock: number
    startBlock: number | null
    started: boolean
    active: boolean
    maxRewardRounds: number
    rewardedRounds: number
    remainingRewardRounds: number
    mined: string
    remainingMineableSupply: string
    phaseOneSupply: string
    initialLiquiditySupply: string
    initialLiquidityMinted: boolean
    mineableSupply: string
    liquidityManagerReserveSupply: string
    maxAiAgentReservedSupply: string
    aiAgentReservedSupply: string
    aiAgentMinter: string
    aiAgentMinterSet: boolean
    aiAgentMinted: string
    aiAgentRemainingSupply: string
    blockReward: string
  } | null
}

interface ContractStatus {
  mining?: MiningStatus
}

interface TokenStatus {
  configured: boolean
  error: string | null
  chainId: number
  chainName: string
  explorerUrl: string
  contract: {
    address: string
    senti: string
    positionManager: string
    permit2: string
    adminSafe: string
    opsSafe: string
    adminSigner: string | null
    adminSignerConfigured: boolean
    adminSignerIsAdminSafe: boolean
    adminSignerIsOpsSafe: boolean
    adminSignerAuthorizedKeeper: boolean
    adminSignerCanCompound: boolean
    reserveTarget: string | null
    reserveEthBalance: string
    reserveSentiBalance: string
    sentiIsCurrency0: boolean
    poolKey: {
      currency0: string
      currency1: string
      fee: number
      tickSpacing: number
      hooks: string
    }
    poolId: string
    trackedPositionTokenId: string
    trackedPositionSet: boolean
    trackedPositionOwner: string | null
    trackedPositionLiquidity: string | null
    trackedPositionTickLower: number | null
    trackedPositionTickUpper: number | null
    trackedPositionCurrentTick: number | null
    trackedPositionEthBalance: string | null
    trackedPositionSentiBalance: string | null
    minEthToCompound: string
    compoundCooldown: number
    maxEthPerCompound: string
    maxSentiPerCompound: string
    maxDeadlineWindow: number
    lastCompoundAt: number
  } | null
}

interface CompoundEstimate {
  targetEth: string
  amount0Max: string
  amount1Max: string
  estimatedSenti: string
  liquidityIncrease: string
  validated: boolean
  cooldownActive: boolean
  nextCompoundAt: number
  deadlineOffset: number
  sentiIsCurrency0: boolean
  basis: {
    source: "compound_history" | "tracked_position"
    txHash: string | null
    blockNumber: number | null
    liquidityIncrease: string
    ethAmountMax: string
    sentiAmountMax: string
    trackedPositionTokenId: string | null
    currentTick: number | null
  }
}

interface ContractStatus {
  token?: TokenStatus
}

function formatTime(ts: number): string {
  if (ts === 0) return "—"
  return new Date(ts * 1000).toLocaleString()
}

function shortAddr(addr: string): string {
  if (!addr) return ""
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function shortTx(hash: string): string {
  if (!hash) return ""
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`
}

const EXPLORER =
  process.env.NEXT_PUBLIC_EXPLORER_URL || "https://etherscan.io"

function TxLink({ hash, explorer = EXPLORER }: { hash: string; explorer?: string }) {
  return (
    <a
      href={`${explorer}/tx/${hash}`}
      target="_blank"
      rel="noopener noreferrer"
      className="text-blue-300 hover:text-blue-200 underline-offset-2 hover:underline"
    >
      {shortTx(hash)}
    </a>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="shrink-0 text-zinc-500">{label}</span>
      <span className={`min-w-0 break-all text-right text-zinc-200 ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  )
}

function OperatorActionNotice({ result, explorer }: { result: OperatorActionResult; explorer: string }) {
  if (result.mode === "direct" && result.txHash) {
    return (
      <div className="bg-green-900/30 border border-green-700 rounded p-2 text-xs text-green-200">
        {result.action} ok &middot; <TxLink hash={result.txHash} explorer={explorer} />
      </div>
    )
  }

  if (!result.execution) {
    return null
  }

  return (
    <div className="bg-yellow-900/30 border border-yellow-700 rounded p-3 text-xs text-yellow-100 space-y-2">
      <div className="font-medium">{result.action} requires manual or Safe execution.</div>
      {result.warning ? <div className="text-yellow-200/90">{result.warning}</div> : null}
      <Row label="Chain" value={`${result.execution.chainName} (${result.execution.chainId})`} />
      <Row label="Local Signer" value={result.localSigner ?? "(none resolved on server)"} mono />
      <Row label="Required Signers" value={result.execution.requiredSigners.join(", ")} mono />
      <Row label="Target" value={result.execution.to} mono />
      <Row label="Value" value={`${result.execution.valueEth} ETH (${result.execution.valueWei} wei)`} mono />
      <div>
        <div className="mb-1 text-zinc-400">Calldata</div>
        <div className="break-all rounded bg-zinc-950/70 p-2 font-mono text-[11px] text-zinc-200">
          {result.execution.data}
        </div>
      </div>
      <div className="text-yellow-50/90">{result.execution.note}</div>
    </div>
  )
}

function StatCard({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0
  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-3">
      <div className="text-[10px] uppercase text-zinc-500">{label}</div>
      <div className={`text-2xl font-bold ${color}`}>{value.toLocaleString()}</div>
      <div className="text-[10px] text-zinc-500">
        of {max.toLocaleString()} ({pct}%)
      </div>
    </div>
  )
}

function ProgressBar({ label, current, max, color }: { label: string; current: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, (current / max) * 100) : 0
  return (
    <div>
      <div className="flex justify-between text-[10px] mb-1">
        <span className="text-zinc-400">{label}</span>
        <span className="text-zinc-300">
          {current.toLocaleString()} / {max.toLocaleString()}
        </span>
      </div>
      <div className="w-full h-2 bg-zinc-800 rounded overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export default function AdminPage() {
  const [authed, setAuthed] = useState(false)
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [totpCode, setTotpCode] = useState("")
  const [loginError, setLoginError] = useState("")
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginStep, setLoginStep] = useState<"credentials" | "totp">("credentials")
  const [status, setStatus] = useState<ContractStatus | null>(null)
  const [fetchError, setFetchError] = useState("")
  const [pauseBusy, setPauseBusy] = useState(false)
  const [pauseError, setPauseError] = useState("")
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState("")
  const [actionResult, setActionResult] = useState<{ action: string; txHash: string } | null>(null)
  const [treasuryInput, setTreasuryInput] = useState("")
  const [airdropRootInput, setAirdropRootInput] = useState("")
  const [grantInput, setGrantInput] = useState("")
  const [revokeInput, setRevokeInput] = useState("")
  const [walletQuery, setWalletQuery] = useState("")
  const [walletData, setWalletData] = useState<WalletHistory | null>(null)
  const [walletBusy, setWalletBusy] = useState(false)
  const [walletError, setWalletError] = useState("")
  const [irysStatus, setIrysStatus] = useState<IrysStatus | null>(null)
  const [irysError, setIrysError] = useState("")
  const [irysAmount, setIrysAmount] = useState("")
  const [irysBusy, setIrysBusy] = useState(false)
  const [miningBusy, setMiningBusy] = useState(false)
  const [miningError, setMiningError] = useState("")
  const [miningResult, setMiningResult] = useState<OperatorActionResult | null>(null)
  const [tokenBusy, setTokenBusy] = useState<string | null>(null)
  const [tokenError, setTokenError] = useState("")
  const [tokenResult, setTokenResult] = useState<OperatorActionResult | null>(null)
  const [aiAgentMinterInput, setAiAgentMinterInput] = useState("")
  const [aiAgentBurnAmountInput, setAiAgentBurnAmountInput] = useState("")
  const [keeperAddressInput, setKeeperAddressInput] = useState("")
  const [trackedPositionTokenIdInput, setTrackedPositionTokenIdInput] = useState("")
  const [compoundMinEthInput, setCompoundMinEthInput] = useState("")
  const [compoundCooldownInput, setCompoundCooldownInput] = useState("")
  const [compoundMaxEthInput, setCompoundMaxEthInput] = useState("")
  const [compoundMaxSentiInput, setCompoundMaxSentiInput] = useState("")
  const [compoundMaxDeadlineWindowInput, setCompoundMaxDeadlineWindowInput] = useState("")
  const [compoundEthTargetInput, setCompoundEthTargetInput] = useState("")
  const [compoundEstimateBusy, setCompoundEstimateBusy] = useState(false)
  const [compoundEstimateError, setCompoundEstimateError] = useState("")
  const [compoundEstimate, setCompoundEstimate] = useState<CompoundEstimate | null>(null)
  const [compoundLiquidityInput, setCompoundLiquidityInput] = useState("")
  const [compoundAmount0MaxInput, setCompoundAmount0MaxInput] = useState("")
  const [compoundAmount1MaxInput, setCompoundAmount1MaxInput] = useState("")
  const [compoundDeadlineInput, setCompoundDeadlineInput] = useState("")
  const [reserveBurnAmountInput, setReserveBurnAmountInput] = useState("")
  const compoundEstimateRequestId = useRef(0)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/status")
      if (res.status === 401) {
        setAuthed(false)
        return
      }
      if (!res.ok) throw new Error("Failed to fetch")
      const data = await res.json()
      setStatus(data)
      setFetchError("")
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Error")
    }
  }, [])

  const fetchIrys = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/irys")
      if (res.status === 401) {
        setAuthed(false)
        return
      }
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Irys status failed")
      setIrysStatus(data)
      setIrysError("")
    } catch (err) {
      setIrysError(err instanceof Error ? err.message : "Irys status failed")
    }
  }, [])

  async function handlePauseAction(action: "pause" | "unpause") {
    if (!status) return
    const verb = action === "pause" ? "PAUSE" : "UNPAUSE"
    const tail =
      action === "pause"
        ? "\n\nThis halts ALL minting (publicMint + claim) until you unpause."
        : "\n\nThis resumes minting."
    if (!window.confirm(`Are you sure you want to ${verb} the contract?${tail}`)) return

    setPauseBusy(true)
    setPauseError("")
    try {
      const res = await fetch("/api/admin/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `${action} failed`)
      await fetchStatus()
    } catch (err) {
      setPauseError(err instanceof Error ? err.message : `${action} failed`)
    } finally {
      setPauseBusy(false)
    }
  }

  async function handleContractAction(
    action:
      | "withdraw"
      | "closeMint"
      | "closeAirdrop"
      | "setTreasury"
      | "setAirdropRoot"
      | "grantUriSetter"
      | "revokeUriSetter",
    extra: Record<string, string> = {},
    confirmMsg?: string,
  ) {
    if (confirmMsg && !window.confirm(confirmMsg)) return
    setActionBusy(action)
    setActionError("")
    setActionResult(null)
    try {
      const res = await fetch("/api/admin/contract-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `${action} failed`)
      setActionResult({ action, txHash: data.txHash })
      await fetchStatus()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : `${action} failed`)
    } finally {
      setActionBusy(null)
    }
  }

  async function handleWalletLookup(e: React.FormEvent) {
    e.preventDefault()
    const addr = walletQuery.trim()
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
      setWalletError("Enter a valid 0x… 40-hex address")
      return
    }
    setWalletBusy(true)
    setWalletError("")
    try {
      const res = await fetch(`/api/admin/wallet?address=${addr}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Lookup failed")
      setWalletData(data)
    } catch (err) {
      setWalletError(err instanceof Error ? err.message : "Lookup failed")
      setWalletData(null)
    } finally {
      setWalletBusy(false)
    }
  }

  async function handleIrysFund(e: React.FormEvent) {
    e.preventDefault()
    const amt = irysAmount.trim()
    if (!/^\d+(\.\d+)?$/.test(amt) || Number(amt) <= 0) {
      setIrysError("Enter a positive token amount (e.g. 0.05)")
      return
    }
    if (!window.confirm(
      `Fund the Irys uploader with ${amt} ${irysStatus?.token ?? "tokens"}?\n\nThis transfers from IRYS_PRIVATE_KEY to the Irys node and is non-refundable except via Irys' own withdraw flow.`,
    )) return
    setIrysBusy(true)
    setIrysError("")
    try {
      const res = await fetch("/api/admin/irys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: amt }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Fund failed")
      setIrysAmount("")
      await fetchIrys()
    } catch (err) {
      setIrysError(err instanceof Error ? err.message : "Fund failed")
    } finally {
      setIrysBusy(false)
    }
  }

  async function handleMiningStart() {
    const mining = status?.mining
    const contract = mining?.contract
    if (!mining || !contract) return

    if (!window.confirm(
      `Start $SENTI mining on ${mining.chainName} now?\n\nThe current block becomes miningStartBlock. Skipped chain blocks do not consume rewards; mining stays open until ${contract.maxRewardRounds.toLocaleString()} rewarded rounds are claimed. This can only happen once.`,
    )) return

    setMiningBusy(true)
    setMiningError("")
    setMiningResult(null)
    try {
      const res = await fetch("/api/admin/mining-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "startMining" }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "startMining failed")
      setMiningResult({
        action: "startMining",
        mode: data.mode === "manual" ? "manual" : "direct",
        txHash: data.txHash ?? null,
        localSigner: data.localSigner ?? null,
        warning: data.warning ?? null,
        execution: data.execution ?? null,
      })
      if (data.mode !== "manual") {
        await fetchStatus()
      }
    } catch (err) {
      setMiningError(err instanceof Error ? err.message : "startMining failed")
    } finally {
      setMiningBusy(false)
    }
  }

  async function handleTokenAction(
    action:
      | "setAiAgentMinter"
      | "burnUnmintedAiAgentSupply"
      | "setKeeper"
      | "setTrackedPositionTokenId"
      | "setCompoundConfig"
      | "compoundLiquidity"
      | "burnReserveSenti"
      | "refreshPermit2Allowance",
    extra: Record<string, string | boolean> = {},
    confirmMsg?: string,
  ) {
    if (confirmMsg && !window.confirm(confirmMsg)) return
    setTokenBusy(action)
    setTokenError("")
    setTokenResult(null)
    try {
      const res = await fetch("/api/admin/token-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `${action} failed`)
      setTokenResult({
        action,
        mode: data.mode === "manual" ? "manual" : "direct",
        txHash: data.txHash ?? null,
        localSigner: data.localSigner ?? null,
        warning: data.warning ?? null,
        execution: data.execution ?? null,
      })
      if (data.mode !== "manual") {
        await fetchStatus()
      }
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : `${action} failed`)
    } finally {
      setTokenBusy(null)
    }
  }

  const estimateCompoundFromEth = useCallback(async (ethAmount: string) => {
    const requestId = ++compoundEstimateRequestId.current
    if (!ethAmount.trim()) {
      setCompoundEstimateBusy(false)
      setCompoundEstimateError("")
      setCompoundEstimate(null)
      return
    }

    setCompoundEstimateBusy(true)
    setCompoundEstimateError("")
    try {
      const res = await fetch("/api/admin/compound-estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ethAmount }),
      })
      const data = await res.json()
      if (requestId !== compoundEstimateRequestId.current) return
      if (!res.ok) throw new Error(data.error || "Compound estimate failed")

      setCompoundEstimate(data as CompoundEstimate)
      setCompoundLiquidityInput(data.liquidityIncrease)
      setCompoundAmount0MaxInput(data.amount0Max)
      setCompoundAmount1MaxInput(data.amount1Max)
    } catch (err) {
      if (requestId !== compoundEstimateRequestId.current) return
      setCompoundEstimate(null)
      setCompoundEstimateError(err instanceof Error ? err.message : "Compound estimate failed")
    } finally {
      if (requestId === compoundEstimateRequestId.current) {
        setCompoundEstimateBusy(false)
      }
    }
  }, [])

  const resetPendingTotpStep = useCallback(async () => {
    await fetch("/api/admin/auth", { method: "DELETE" })
    setLoginStep("credentials")
    setPassword("")
    setTotpCode("")
    setLoginError("")
  }, [])

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoginError("")
    setLoginBusy(true)

    try {
      const payload = loginStep === "totp"
        ? { totpCode }
        : { username, password }

      const res = await fetch("/api/admin/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const data = await res.json() as AdminAuthResponse

      if (!res.ok) {
        if (data.resetTotpStep) {
          setLoginStep("credentials")
          setTotpCode("")
        }
        setLoginError(data.error || (loginStep === "totp" ? "Code verification failed" : "Login failed"))
        return
      }

      if (data.requiresTotp) {
        setLoginStep("totp")
        setPassword("")
        setTotpCode("")
        return
      }

      setAuthed(true)
      setLoginStep("credentials")
      setPassword("")
      setTotpCode("")
      void fetchStatus()
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : "Login failed")
    } finally {
      setLoginBusy(false)
    }
  }

  async function handleLogout() {
    await fetch("/api/admin/auth", { method: "DELETE" })
    setAuthed(false)
    setLoginStep("credentials")
    setPassword("")
    setTotpCode("")
    setLoginError("")
    setStatus(null)
  }

  // Auto-refresh every 10 seconds
  useEffect(() => {
    if (!authed) return
    fetchStatus()
    fetchIrys()
    const interval = setInterval(() => {
      fetchStatus()
      fetchIrys()
    }, 10_000)
    return () => clearInterval(interval)
  }, [authed, fetchStatus, fetchIrys])

  useEffect(() => {
    const tokenContract = status?.token?.contract
    if (!tokenContract) return
    setTrackedPositionTokenIdInput((current) => current || (tokenContract.trackedPositionSet ? tokenContract.trackedPositionTokenId : ""))
    setCompoundMinEthInput((current) => current || tokenContract.minEthToCompound)
    setCompoundCooldownInput((current) => current || String(tokenContract.compoundCooldown))
    setCompoundMaxEthInput((current) => current || tokenContract.maxEthPerCompound)
    setCompoundMaxSentiInput((current) => current || tokenContract.maxSentiPerCompound)
    setCompoundMaxDeadlineWindowInput((current) => current || String(tokenContract.maxDeadlineWindow))
  }, [status?.token?.contract])

  useEffect(() => {
    if (!authed || !status?.token?.contract?.address) return

    const trimmed = compoundEthTargetInput.trim()
    if (!trimmed) {
      compoundEstimateRequestId.current += 1
      setCompoundEstimateBusy(false)
      setCompoundEstimateError("")
      setCompoundEstimate(null)
      return
    }

    const timeoutId = window.setTimeout(() => {
      void estimateCompoundFromEth(trimmed)
    }, 450)

    return () => window.clearTimeout(timeoutId)
  }, [authed, compoundEthTargetInput, estimateCompoundFromEth, status?.token?.contract?.address])

  if (!authed) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <form onSubmit={handleLogin} className="bg-zinc-900 p-8 rounded-lg border border-zinc-700 w-80 space-y-4">
          <h1 className="text-white text-lg font-bold text-center">Admin Monitor</h1>
          {loginStep === "credentials" ? (
            <>
              <input
                type="text"
                placeholder="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded text-white text-sm"
                autoComplete="username"
              />
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded text-white text-sm"
                autoComplete="current-password"
              />
              <p className="text-xs text-zinc-400">
                If admin 2FA is enabled, you will enter a 6-digit Google Authenticator code after the password step.
              </p>
            </>
          ) : (
            <>
              <div className="rounded border border-zinc-700 bg-zinc-800/80 p-3 text-xs text-zinc-300">
                Password accepted. Enter the 6-digit code from Google Authenticator to finish sign-in.
              </div>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                placeholder="6-digit code"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded text-white text-sm tracking-[0.35em]"
                autoComplete="one-time-code"
              />
            </>
          )}
          {loginError && <p className="text-red-400 text-xs">{loginError}</p>}
          {loginStep === "totp" ? (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void resetPendingTotpStep()}
                className="w-full py-2 bg-zinc-800 hover:bg-zinc-700 text-white rounded text-sm font-medium border border-zinc-600"
                disabled={loginBusy}
              >
                Back
              </button>
              <button type="submit" className="w-full py-2 bg-blue-600 hover:bg-blue-500 text-white rounded text-sm font-medium" disabled={loginBusy || totpCode.length !== 6}>
                {loginBusy ? "Verifying..." : "Verify code"}
              </button>
            </div>
          ) : (
            <button type="submit" className="w-full py-2 bg-blue-600 hover:bg-blue-500 text-white rounded text-sm font-medium" disabled={loginBusy}>
              {loginBusy ? "Checking..." : "Continue"}
            </button>
          )}
        </form>
      </div>
    )
  }

  const s = status
  const c = s?.contract
  const sup = s?.supply
  const mining = s?.mining
  const miningContract = mining?.contract
  const token = s?.token
  const tokenContract = token?.contract
  const miningStartDisabled =
    !miningContract ||
    miningContract.started ||
    miningBusy
  const aiReserveAdminDisabled =
    !miningContract ||
    tokenBusy !== null
  const tokenAdminDisabled =
    !tokenContract ||
    tokenBusy !== null
  const tokenNextCompoundAt = tokenContract ? tokenContract.lastCompoundAt + tokenContract.compoundCooldown : 0
  const tokenCompoundCooldownActive = tokenContract ? tokenContract.lastCompoundAt !== 0 && Math.floor(Date.now() / 1000) < tokenNextCompoundAt : false
  const tokenCompoundDisabled =
    !tokenContract ||
    tokenCompoundCooldownActive ||
    tokenBusy !== null

  return (
    <div className="min-h-screen bg-black text-white p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold">SentinelETH Admin Monitor</h1>
          <button onClick={handleLogout} className="text-xs text-zinc-400 hover:text-white px-3 py-1 border border-zinc-700 rounded">
            Logout
          </button>
        </div>

        {fetchError && (
          <div className="bg-red-900/50 border border-red-700 rounded p-3 text-red-300 text-sm">
            {fetchError}
          </div>
        )}

        {c && sup && (
          <>
            {/* Status Banner */}
            <div
              className={`rounded-lg p-6 text-center ${
                c.paused ? "bg-red-700" : c.publicClosed ? "bg-purple-700" : "bg-green-700"
              }`}
            >
              <div className="text-3xl font-bold">
                {c.paused ? "PAUSED" : c.publicClosed ? "PUBLIC CLOSED (AIRDROP ONLY)" : "MINT OPEN"}
              </div>
              <div className="mt-2 text-sm opacity-90">
                {sup.publicRemaining.toLocaleString()} public mints remaining ·{" "}
                {sup.airdropRemaining.toLocaleString()} airdrop slots
              </div>
              <div className="mt-4 flex items-center justify-center gap-3">
                {!c.paused ? (
                  <button
                    onClick={() => handlePauseAction("pause")}
                    disabled={pauseBusy || !c.ownerConfigured}
                    title={
                      !c.ownerConfigured
                        ? "OWNER_PRIVATE_KEY not configured on server"
                        : "Halt all minting"
                    }
                    className="px-4 py-2 text-sm font-bold rounded bg-red-600 hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {pauseBusy ? "Working…" : "Emergency Pause"}
                  </button>
                ) : (
                  <button
                    onClick={() => handlePauseAction("unpause")}
                    disabled={pauseBusy || !c.ownerConfigured}
                    title={!c.ownerConfigured ? "OWNER_PRIVATE_KEY not configured on server" : "Resume minting"}
                    className="px-4 py-2 text-sm font-bold rounded bg-green-600 hover:bg-green-500 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {pauseBusy ? "Working…" : "Unpause"}
                  </button>
                )}
                {!c.ownerConfigured && (
                  <span className="text-xs opacity-75">Owner key not configured</span>
                )}
              </div>
              {pauseError && <div className="mt-2 text-xs text-red-200">{pauseError}</div>}
            </div>

            {/* Contract Actions */}
            <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-4 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-zinc-400 uppercase">NFT Contract Actions</h2>
                {!c.ownerConfigured && (
                  <span className="text-xs text-yellow-400">OWNER_PRIVATE_KEY not set</span>
                )}
              </div>

              {actionResult && (
                <div className="bg-green-900/30 border border-green-700 rounded p-2 text-xs text-green-200">
                  {actionResult.action} ok &middot; <TxLink hash={actionResult.txHash} />
                </div>
              )}
              {actionError && (
                <div className="bg-red-900/30 border border-red-700 rounded p-2 text-xs text-red-300">
                  {actionError}
                </div>
              )}

              {/* Withdraw */}
              <div className="flex items-center justify-between gap-3 border-b border-zinc-800 pb-3">
                <div>
                  <div className="text-sm font-medium">Withdraw to treasury</div>
                  <div className="text-xs text-zinc-500">
                    Sweep contract balance ({s.balances.contractEth ?? "—"} ETH) to treasury.
                  </div>
                </div>
                <button
                  onClick={() =>
                    handleContractAction(
                      "withdraw",
                      {},
                      `Sweep ${s.balances.contractEth ?? "0"} ETH from contract to treasury (${shortAddr(c.treasury)})?`,
                    )
                  }
                  disabled={
                    !c.ownerConfigured ||
                    actionBusy !== null ||
                    !s.balances.contractEth ||
                    s.balances.contractEth === "0"
                  }
                  className="px-3 py-2 text-xs font-medium rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {actionBusy === "withdraw" ? "Working…" : "Withdraw"}
                </button>
              </div>

              {/* Close mint */}
              <div className="flex items-center justify-between gap-3 border-b border-zinc-800 pb-3">
                <div>
                  <div className="text-sm font-medium">Close public mint <span className="text-red-400">(irreversible)</span></div>
                  <div className="text-xs text-zinc-500">
                    Permanently freezes the public pool at {sup.publicMinted.toLocaleString()}.
                  </div>
                </div>
                <button
                  onClick={() =>
                    handleContractAction(
                      "closeMint",
                      {},
                      "PERMANENTLY close the public mint?\n\nThis CANNOT be undone. Any unminted public supply becomes un-mintable forever.",
                    )
                  }
                  disabled={!c.ownerConfigured || actionBusy !== null || c.publicClosed}
                  className="px-3 py-2 text-xs font-medium rounded bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {c.publicClosed ? "Already closed" : actionBusy === "closeMint" ? "Working…" : "Close Mint"}
                </button>
              </div>

              {/* Close airdrop */}
              <div className="flex items-center justify-between gap-3 border-b border-zinc-800 pb-3">
                <div>
                  <div className="text-sm font-medium">Close airdrop <span className="text-red-400">(irreversible)</span></div>
                  <div className="text-xs text-zinc-500">
                    Permanently freezes the airdrop pool at {sup.airdropMinted.toLocaleString()}.
                  </div>
                </div>
                <button
                  onClick={() =>
                    handleContractAction(
                      "closeAirdrop",
                      {},
                      "PERMANENTLY close the airdrop?\n\nThis CANNOT be undone. Unclaimed airdrop slots become un-claimable forever.",
                    )
                  }
                  disabled={!c.ownerConfigured || actionBusy !== null || c.airdropClosed}
                  className="px-3 py-2 text-xs font-medium rounded bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {c.airdropClosed ? "Already closed" : actionBusy === "closeAirdrop" ? "Working…" : "Close Airdrop"}
                </button>
              </div>

              {/* Set treasury */}
              <div className="border-b border-zinc-800 pb-3 space-y-2">
                <div className="text-sm font-medium">Set treasury address</div>
                <div className="text-xs text-zinc-500">
                  Changes destination of <code className="text-zinc-300">withdraw()</code>. Current: {shortAddr(c.treasury)}.
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={treasuryInput}
                    onChange={(e) => setTreasuryInput(e.target.value)}
                    placeholder="0x… new treasury"
                    className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-600 rounded text-white text-xs font-mono"
                  />
                  <button
                    onClick={() =>
                      handleContractAction(
                        "setTreasury",
                        { address: treasuryInput.trim() },
                        `Change treasury to ${treasuryInput.trim()}?`,
                      )
                    }
                    disabled={!c.ownerConfigured || actionBusy !== null || !treasuryInput.trim()}
                    className="px-3 py-2 text-xs rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40"
                  >
                    {actionBusy === "setTreasury" ? "Working…" : "Update"}
                  </button>
                </div>
              </div>

              {/* Set airdrop root */}
              <div className="border-b border-zinc-800 pb-3 space-y-2">
                <div className="text-sm font-medium">Set airdrop merkle root</div>
                <div className="text-xs text-zinc-500">
                  Bytes32 hex (66 chars incl. 0x). Current: {c.airdropRootSet ? shortAddr(c.airdropRoot) : "(unset)"}.
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={airdropRootInput}
                    onChange={(e) => setAirdropRootInput(e.target.value)}
                    placeholder="0x… 32-byte merkle root"
                    className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-600 rounded text-white text-xs font-mono"
                  />
                  <button
                    onClick={() =>
                      handleContractAction(
                        "setAirdropRoot",
                        { root: airdropRootInput.trim() },
                        `Set airdrop root to ${airdropRootInput.trim()}?`,
                      )
                    }
                    disabled={!c.ownerConfigured || actionBusy !== null || !airdropRootInput.trim()}
                    className="px-3 py-2 text-xs rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40"
                  >
                    {actionBusy === "setAirdropRoot" ? "Working…" : "Update"}
                  </button>
                </div>
              </div>

              {/* Grant URI_SETTER_ROLE */}
              <div className="border-b border-zinc-800 pb-3 space-y-2">
                <div className="text-sm font-medium">Grant URI_SETTER_ROLE</div>
                <div className="text-xs text-zinc-500">
                  Authorize an address to call <code className="text-zinc-300">setTokenURIs()</code> (the watcher).
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={grantInput}
                    onChange={(e) => setGrantInput(e.target.value)}
                    placeholder="0x… watcher EOA"
                    className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-600 rounded text-white text-xs font-mono"
                  />
                  <button
                    onClick={() =>
                      handleContractAction(
                        "grantUriSetter",
                        { address: grantInput.trim() },
                        `Grant URI_SETTER_ROLE to ${grantInput.trim()}?`,
                      )
                    }
                    disabled={!c.ownerConfigured || actionBusy !== null || !grantInput.trim()}
                    className="px-3 py-2 text-xs rounded bg-green-600 hover:bg-green-500 disabled:opacity-40"
                  >
                    {actionBusy === "grantUriSetter" ? "Working…" : "Grant"}
                  </button>
                </div>
              </div>

              {/* Revoke URI_SETTER_ROLE */}
              <div className="space-y-2">
                <div className="text-sm font-medium">Revoke URI_SETTER_ROLE</div>
                <div className="text-xs text-zinc-500">
                  Remove an address&apos;s ability to call <code className="text-zinc-300">setTokenURIs()</code>.
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={revokeInput}
                    onChange={(e) => setRevokeInput(e.target.value)}
                    placeholder="0x… address"
                    className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-600 rounded text-white text-xs font-mono"
                  />
                  <button
                    onClick={() =>
                      handleContractAction(
                        "revokeUriSetter",
                        { address: revokeInput.trim() },
                        `Revoke URI_SETTER_ROLE from ${revokeInput.trim()}?`,
                      )
                    }
                    disabled={!c.ownerConfigured || actionBusy !== null || !revokeInput.trim()}
                    className="px-3 py-2 text-xs rounded bg-red-600 hover:bg-red-500 disabled:opacity-40"
                  >
                    {actionBusy === "revokeUriSetter" ? "Working…" : "Revoke"}
                  </button>
                </div>
              </div>
            </div>

            {/* Mining Control */}
            {mining && (
              <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-4 space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-sm font-bold text-zinc-400 uppercase">Mining Control</h2>
                  <span className="text-xs text-zinc-500">
                    {mining.chainName} · {mining.chainId}
                  </span>
                </div>

                {mining.error && (
                  <div className="bg-yellow-900/30 border border-yellow-700 rounded p-2 text-xs text-yellow-200">
                    {mining.error}
                  </div>
                )}
                {miningResult && <OperatorActionNotice result={miningResult} explorer={mining.explorerUrl} />}
                {miningError && (
                  <div className="bg-red-900/30 border border-red-700 rounded p-2 text-xs text-red-300">
                    {miningError}
                  </div>
                )}

                {miningContract ? (
                  <>
                    <div className="grid md:grid-cols-2 gap-3">
                      <div className="bg-zinc-950/60 border border-zinc-800 rounded p-3 space-y-2">
                        <Row label="PatrolMiner" value={miningContract.address} mono />
                        <Row label="SENTI" value={miningContract.senti} mono />
                        <Row label="Backend Signer" value={miningContract.signer} mono />
                        <Row label="Admin" value={miningContract.admin} mono />
                        <Row label="Server Admin Signer" value={miningContract.adminSigner ?? "(not configured)"} mono />
                        <Row label="Signer Is Admin" value={miningContract.adminSignerIsAdmin ? "Yes" : "No"} />
                      </div>
                      <div className="bg-zinc-950/60 border border-zinc-800 rounded p-3 space-y-2">
                        <Row label="Status" value={miningContract.active ? "Active" : miningContract.started ? "Started" : "Not started"} />
                        <Row label="Current Block" value={miningContract.currentBlock.toLocaleString()} />
                        <Row label="Start Block" value={miningContract.startBlock?.toLocaleString() ?? "—"} />
                        <Row label="Rewarded Rounds" value={`${miningContract.rewardedRounds.toLocaleString()} / ${miningContract.maxRewardRounds.toLocaleString()}`} />
                        <Row label="Remaining Rounds" value={miningContract.remainingRewardRounds.toLocaleString()} />
                        <Row label="Mined" value={`${miningContract.mined} / ${miningContract.mineableSupply} SENTI`} />
                        <Row label="Remaining Mineable" value={`${miningContract.remainingMineableSupply} SENTI`} />
                        <Row label="Block Reward" value={`${miningContract.blockReward} SENTI`} />
                        <Row label="Initial LP Seed" value={`${miningContract.initialLiquiditySupply} SENTI ${miningContract.initialLiquidityMinted ? "minted" : "reserved"}`} />
                        <Row label="Manager Reserve Allocation" value={`${miningContract.liquidityManagerReserveSupply} SENTI`} />
                        <Row label="AI Reserve" value={`${miningContract.aiAgentMinted} minted / ${miningContract.aiAgentReservedSupply} current cap`} />
                        <Row label="AI Remaining" value={`${miningContract.aiAgentRemainingSupply} SENTI`} />
                        <Row label="AI Minter" value={miningContract.aiAgentMinterSet ? miningContract.aiAgentMinter : "(not set)"} mono />
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-3 border-t border-zinc-800 pt-3">
                      <div>
                        <div className="text-sm font-medium">Start $SENTI mining <span className="text-red-400">(one-shot)</span></div>
                        <div className="text-xs text-zinc-500">
                          Sets miningStartBlock to the transaction block. Rewards continue until the fixed rewarded-round cap is exhausted.
                        </div>
                      </div>
                      <button
                        onClick={handleMiningStart}
                        disabled={miningStartDisabled}
                        title={
                          miningContract.started
                            ? "Mining already started"
                              : !miningContract.adminSignerIsAdmin
                                ? "Configured signer is not PatrolMiner admin. The route will return Safe/manual calldata instead of sending the tx."
                                : "Start mining now"
                        }
                        className="px-3 py-2 text-xs font-medium rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {miningContract.started ? "Already Started" : miningBusy ? "Working…" : "Start Mining"}
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="text-xs text-zinc-500">
                    PatrolMiner is not configured yet. Deploy mining core, then set NEXT_PUBLIC_PATROL_MINER_ADDRESS.
                  </p>
                )}
              </div>
            )}

            {/* Token Treasury Control */}
            {token && (
              <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-4 space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-sm font-bold text-zinc-400 uppercase">Token Treasury</h2>
                  <span className="text-xs text-zinc-500">
                    {token.chainName} · {token.chainId}
                  </span>
                </div>

                {token.error && (
                  <div className="bg-yellow-900/30 border border-yellow-700 rounded p-2 text-xs text-yellow-200">
                    {token.error}
                  </div>
                )}
                {tokenResult && <OperatorActionNotice result={tokenResult} explorer={token.explorerUrl} />}
                {tokenError && (
                  <div className="bg-red-900/30 border border-red-700 rounded p-2 text-xs text-red-300">
                    {tokenError}
                  </div>
                )}

                {tokenContract ? (
                  <>
                    <div className="grid xl:grid-cols-2 gap-3">
                      <div className="bg-zinc-950/60 border border-zinc-800 rounded p-3 space-y-2">
                        <div className="text-[10px] uppercase text-zinc-500">Manager Status</div>
                        <Row label="Liquidity Manager" value={tokenContract.address} mono />
                        <Row label="SENTI" value={tokenContract.senti} mono />
                        <Row label="Position Manager" value={tokenContract.positionManager} mono />
                        <Row label="Permit2" value={tokenContract.permit2} mono />
                        <Row label="Admin Safe" value={tokenContract.adminSafe} mono />
                        <Row label="Ops Safe" value={tokenContract.opsSafe} mono />
                        <Row label="Server Signer" value={tokenContract.adminSigner ?? "(not configured)"} mono />
                        <Row label="Signer Is Admin Safe" value={tokenContract.adminSignerIsAdminSafe ? "Yes" : "No"} />
                        <Row label="Signer Is Ops Safe" value={tokenContract.adminSignerIsOpsSafe ? "Yes" : "No"} />
                        <Row label="Signer Can Compound" value={tokenContract.adminSignerCanCompound ? "Yes" : "No"} />
                        <Row label="Signer Is Keeper" value={tokenContract.adminSignerAuthorizedKeeper ? "Yes" : "No"} />
                      </div>
                      <div className="bg-zinc-950/60 border border-zinc-800 rounded p-3 space-y-2">
                        <div className="text-[10px] uppercase text-zinc-500">Reserve State</div>
                        <Row label="Reserve Target" value={`${tokenContract.reserveTarget ?? miningContract?.liquidityManagerReserveSupply ?? "—"} SENTI`} />
                        <Row label="Manager SENTI" value={`${tokenContract.reserveSentiBalance} SENTI`} />
                        <Row label="Manager ETH" value={`${tokenContract.reserveEthBalance} ETH`} />
                        <Row label="Tracked Position" value={tokenContract.trackedPositionSet ? tokenContract.trackedPositionTokenId : "(not set)"} mono />
                        <Row label="Tracked Owner" value={tokenContract.trackedPositionOwner ?? "—"} mono />
                        <Row label="Tracked Liquidity" value={tokenContract.trackedPositionLiquidity ?? "—"} mono />
                        <Row label="LP ETH" value={tokenContract.trackedPositionEthBalance !== null ? `${tokenContract.trackedPositionEthBalance} ETH` : "—"} />
                        <Row label="LP SENTI" value={tokenContract.trackedPositionSentiBalance !== null ? `${tokenContract.trackedPositionSentiBalance} SENTI` : "—"} />
                        <Row label="LP Tick Range" value={tokenContract.trackedPositionTickLower !== null && tokenContract.trackedPositionTickUpper !== null ? `[${tokenContract.trackedPositionTickLower}, ${tokenContract.trackedPositionTickUpper}]` : "—"} mono />
                        <Row label="LP Current Tick" value={tokenContract.trackedPositionCurrentTick !== null ? tokenContract.trackedPositionCurrentTick.toLocaleString() : "—"} mono />
                        <Row label="Pool Currency 0" value={tokenContract.poolKey.currency0} mono />
                        <Row label="Pool Currency 1" value={tokenContract.poolKey.currency1} mono />
                        <Row label="Pool Fee / Tick" value={`${tokenContract.poolKey.fee} / ${tokenContract.poolKey.tickSpacing}`} />
                        <Row label="Hook" value={tokenContract.poolKey.hooks} mono />
                        <Row label="SENTI Is Currency 0" value={tokenContract.sentiIsCurrency0 ? "Yes" : "No"} />
                        <Row label="Pool ID" value={tokenContract.poolId} mono />
                        <div className="pt-1 text-[10px] text-zinc-500">
                          LP ETH and LP SENTI are the live principal inside the tracked NFT. Manager ETH and Manager SENTI above are idle balances outside the LP.
                        </div>
                      </div>
                    </div>

                    <div className="grid xl:grid-cols-2 gap-3">
                      <div className="bg-zinc-950/60 border border-zinc-800 rounded p-3 space-y-2">
                        <div className="text-[10px] uppercase text-zinc-500">Compound Guardrails</div>
                        <Row label="Min ETH To Compound" value={`${tokenContract.minEthToCompound} ETH`} />
                        <Row label="Cooldown" value={`${tokenContract.compoundCooldown.toLocaleString()} sec`} />
                        <Row label="Max ETH / Compound" value={`${tokenContract.maxEthPerCompound} ETH`} />
                        <Row label="Max SENTI / Compound" value={`${tokenContract.maxSentiPerCompound} SENTI`} />
                        <Row label="Max Deadline Window" value={`${tokenContract.maxDeadlineWindow.toLocaleString()} sec`} />
                        <Row label="Last Compound" value={tokenContract.lastCompoundAt > 0 ? formatTime(tokenContract.lastCompoundAt) : "—"} />
                      </div>
                      <div className="bg-zinc-950/60 border border-zinc-800 rounded p-3 space-y-2">
                        <div className="text-[10px] uppercase text-zinc-500">AI Reserve State</div>
                        <Row label="Current AI Cap" value={`${miningContract?.aiAgentReservedSupply ?? "—"} SENTI`} />
                        <Row label="AI Minted" value={`${miningContract?.aiAgentMinted ?? "—"} SENTI`} />
                        <Row label="AI Remaining" value={`${miningContract?.aiAgentRemainingSupply ?? "—"} SENTI`} />
                        <Row label="AI Max Reserve" value={`${miningContract?.maxAiAgentReservedSupply ?? "—"} SENTI`} />
                        <Row label="AI Minter" value={miningContract?.aiAgentMinterSet ? miningContract.aiAgentMinter : "(not set)"} mono />
                        <Row label="Miner Admin Signer" value={miningContract?.adminSigner ?? "(not configured)"} mono />
                        <Row label="Miner Signer Is Admin" value={miningContract?.adminSignerIsAdmin ? "Yes" : "No"} />
                      </div>
                    </div>

                    <div className="grid xl:grid-cols-2 gap-4">
                      <div className="space-y-3 border border-zinc-800 rounded-lg p-3 bg-zinc-950/40">
                        <div>
                          <div className="text-sm font-medium">AI-Agent Reserve Controls</div>
                          <div className="text-xs text-zinc-500">
                            PatrolMiner-only controls for the 300M AI reserve lane. Burn here reduces unminted allocation, not mined supply.
                          </div>
                        </div>
                        <div className="space-y-2">
                          <div className="text-xs text-zinc-400">Set AI minter</div>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={aiAgentMinterInput}
                              onChange={(e) => setAiAgentMinterInput(e.target.value)}
                              placeholder={miningContract?.aiAgentMinterSet ? miningContract.aiAgentMinter : "0x… AI agent minter"}
                              className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-600 rounded text-white text-xs font-mono"
                            />
                            <button
                              onClick={() =>
                                handleTokenAction(
                                  "setAiAgentMinter",
                                  { address: aiAgentMinterInput.trim() },
                                  `Set AI minter to ${aiAgentMinterInput.trim()}?`,
                                )
                              }
                              disabled={aiReserveAdminDisabled || !aiAgentMinterInput.trim()}
                              className="px-3 py-2 text-xs rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40"
                            >
                              {tokenBusy === "setAiAgentMinter" ? "Working…" : "Set"}
                            </button>
                          </div>
                        </div>
                        <div className="space-y-2">
                          <div className="text-xs text-zinc-400">Burn unminted AI reserve</div>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={aiAgentBurnAmountInput}
                              onChange={(e) => setAiAgentBurnAmountInput(e.target.value)}
                              placeholder="Amount in SENTI"
                              className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-600 rounded text-white text-xs"
                            />
                            <button
                              onClick={() =>
                                handleTokenAction(
                                  "burnUnmintedAiAgentSupply",
                                  { amount: aiAgentBurnAmountInput.trim() },
                                  `Burn ${aiAgentBurnAmountInput.trim()} SENTI from the unminted AI reserve?`,
                                )
                              }
                              disabled={aiReserveAdminDisabled || !aiAgentBurnAmountInput.trim()}
                              className="px-3 py-2 text-xs rounded bg-red-600 hover:bg-red-500 disabled:opacity-40"
                            >
                              {tokenBusy === "burnUnmintedAiAgentSupply" ? "Working…" : "Burn"}
                            </button>
                          </div>
                        </div>
                      </div>

                      <div className="space-y-3 border border-zinc-800 rounded-lg p-3 bg-zinc-950/40">
                        <div>
                          <div className="text-sm font-medium">Keeper Access</div>
                          <div className="text-xs text-zinc-500">
                            Authorize or remove compound keepers on the liquidity manager.
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={keeperAddressInput}
                            onChange={(e) => setKeeperAddressInput(e.target.value)}
                            placeholder="0x… keeper address"
                            className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-600 rounded text-white text-xs font-mono"
                          />
                          <button
                            onClick={() =>
                              handleTokenAction(
                                "setKeeper",
                                { address: keeperAddressInput.trim(), authorized: true },
                                `Authorize ${keeperAddressInput.trim()} as a keeper?`,
                              )
                            }
                            disabled={tokenAdminDisabled || !keeperAddressInput.trim()}
                            className="px-3 py-2 text-xs rounded bg-green-600 hover:bg-green-500 disabled:opacity-40"
                          >
                            {tokenBusy === "setKeeper" ? "Working…" : "Authorize"}
                          </button>
                          <button
                            onClick={() =>
                              handleTokenAction(
                                "setKeeper",
                                { address: keeperAddressInput.trim(), authorized: false },
                                `Remove ${keeperAddressInput.trim()} as a keeper?`,
                              )
                            }
                            disabled={tokenAdminDisabled || !keeperAddressInput.trim()}
                            className="px-3 py-2 text-xs rounded bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40"
                          >
                            {tokenBusy === "setKeeper" ? "Working…" : "Remove"}
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="grid xl:grid-cols-2 gap-4">
                      <div className="space-y-3 border border-zinc-800 rounded-lg p-3 bg-zinc-950/40">
                        <div>
                          <div className="text-sm font-medium">Tracked Position / Permit2</div>
                          <div className="text-xs text-zinc-500">
                            Keep the manager pinned to the canonical Uniswap v4 LP position and refresh its Permit2 allowance when needed.
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={trackedPositionTokenIdInput}
                            onChange={(e) => setTrackedPositionTokenIdInput(e.target.value)}
                            placeholder="Uniswap position token ID"
                            className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-600 rounded text-white text-xs"
                          />
                          <button
                            onClick={() =>
                              handleTokenAction(
                                "setTrackedPositionTokenId",
                                { tokenId: trackedPositionTokenIdInput.trim() },
                                `Set tracked position token ID to ${trackedPositionTokenIdInput.trim()}?`,
                              )
                            }
                            disabled={tokenAdminDisabled || !trackedPositionTokenIdInput.trim()}
                            className="px-3 py-2 text-xs rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40"
                          >
                            {tokenBusy === "setTrackedPositionTokenId" ? "Working…" : "Update"}
                          </button>
                        </div>
                        <button
                          onClick={() => handleTokenAction("refreshPermit2Allowance", {}, "Refresh Permit2 allowance for the position manager?")}
                          disabled={tokenAdminDisabled}
                          className="px-3 py-2 text-xs rounded bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40"
                        >
                          {tokenBusy === "refreshPermit2Allowance" ? "Working…" : "Refresh Permit2 Allowance"}
                        </button>
                      </div>

                      <div className="space-y-3 border border-zinc-800 rounded-lg p-3 bg-zinc-950/40">
                        <div>
                          <div className="text-sm font-medium">Burn Manager Reserve</div>
                          <div className="text-xs text-zinc-500">
                            Burns manager-held SENTI only. This cannot touch mined balances or third-party holdings.
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={reserveBurnAmountInput}
                            onChange={(e) => setReserveBurnAmountInput(e.target.value)}
                            placeholder="Amount in SENTI"
                            className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-600 rounded text-white text-xs"
                          />
                          <button
                            onClick={() =>
                              handleTokenAction(
                                "burnReserveSenti",
                                { amount: reserveBurnAmountInput.trim() },
                                `Burn ${reserveBurnAmountInput.trim()} SENTI from the manager reserve?`,
                              )
                            }
                            disabled={tokenAdminDisabled || !reserveBurnAmountInput.trim()}
                            className="px-3 py-2 text-xs rounded bg-red-600 hover:bg-red-500 disabled:opacity-40"
                          >
                            {tokenBusy === "burnReserveSenti" ? "Working…" : "Burn Reserve"}
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-3 border border-zinc-800 rounded-lg p-3 bg-zinc-950/40">
                      <div>
                        <div className="text-sm font-medium">Compound Guardrails</div>
                        <div className="text-xs text-zinc-500">
                          ETH and SENTI values are decimal token amounts. Cooldown and deadline window are raw seconds.
                        </div>
                      </div>
                      <div className="grid md:grid-cols-5 gap-2">
                        <input
                          type="text"
                          value={compoundMinEthInput}
                          onChange={(e) => setCompoundMinEthInput(e.target.value)}
                          placeholder="Min ETH"
                          className="px-3 py-2 bg-zinc-800 border border-zinc-600 rounded text-white text-xs"
                        />
                        <input
                          type="text"
                          value={compoundCooldownInput}
                          onChange={(e) => setCompoundCooldownInput(e.target.value)}
                          placeholder="Cooldown sec"
                          className="px-3 py-2 bg-zinc-800 border border-zinc-600 rounded text-white text-xs"
                        />
                        <input
                          type="text"
                          value={compoundMaxEthInput}
                          onChange={(e) => setCompoundMaxEthInput(e.target.value)}
                          placeholder="Max ETH"
                          className="px-3 py-2 bg-zinc-800 border border-zinc-600 rounded text-white text-xs"
                        />
                        <input
                          type="text"
                          value={compoundMaxSentiInput}
                          onChange={(e) => setCompoundMaxSentiInput(e.target.value)}
                          placeholder="Max SENTI"
                          className="px-3 py-2 bg-zinc-800 border border-zinc-600 rounded text-white text-xs"
                        />
                        <input
                          type="text"
                          value={compoundMaxDeadlineWindowInput}
                          onChange={(e) => setCompoundMaxDeadlineWindowInput(e.target.value)}
                          placeholder="Max deadline sec"
                          className="px-3 py-2 bg-zinc-800 border border-zinc-600 rounded text-white text-xs"
                        />
                      </div>
                      <button
                        onClick={() =>
                          handleTokenAction(
                            "setCompoundConfig",
                            {
                              minEthToCompound: compoundMinEthInput.trim(),
                              compoundCooldown: compoundCooldownInput.trim(),
                              maxEthPerCompound: compoundMaxEthInput.trim(),
                              maxSentiPerCompound: compoundMaxSentiInput.trim(),
                              maxDeadlineWindow: compoundMaxDeadlineWindowInput.trim(),
                            },
                            "Update liquidity compounding guardrails?",
                          )
                        }
                        disabled={
                          tokenAdminDisabled
                          || !compoundMinEthInput.trim()
                          || !compoundCooldownInput.trim()
                          || !compoundMaxEthInput.trim()
                          || !compoundMaxSentiInput.trim()
                          || !compoundMaxDeadlineWindowInput.trim()
                        }
                        className="px-3 py-2 text-xs rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40"
                      >
                        {tokenBusy === "setCompoundConfig" ? "Working…" : "Update Guardrails"}
                      </button>
                    </div>

                    <div className="space-y-3 border border-zinc-800 rounded-lg p-3 bg-zinc-950/40">
                      <div>
                        <div className="text-sm font-medium">Compound Liquidity</div>
                        <div className="text-xs text-zinc-500">
                          Enter the ETH target and the page will auto-fill the raw liquidity delta plus token caps. Amount caps are decimal token amounts. Leave deadline blank to use now + 300 seconds.
                        </div>
                      </div>
                      <div className="space-y-2 rounded border border-zinc-800 bg-zinc-900/50 p-3">
                        <div className="text-[11px] text-zinc-400">
                          Pool order: amount0 = {tokenContract?.sentiIsCurrency0 ? "SENTI" : "ETH"}, amount1 = {tokenContract?.sentiIsCurrency0 ? "ETH" : "SENTI"}.
                        </div>
                        <input
                          type="text"
                          value={compoundEthTargetInput}
                          onChange={(e) => setCompoundEthTargetInput(e.target.value)}
                          placeholder="Target ETH to add"
                          className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded text-white text-xs"
                        />
                        {compoundEstimateBusy && (
                          <div className="text-[11px] text-zinc-500">
                            Estimating compound inputs from recent compounding or live LP state…
                          </div>
                        )}
                        {compoundEstimateError && (
                          <div className="text-[11px] text-red-400">{compoundEstimateError}</div>
                        )}
                        {compoundEstimate && (
                          <div className="space-y-1 text-[11px] text-zinc-400">
                            {compoundEstimate.basis.source === "compound_history" && compoundEstimate.basis.txHash ? (
                              <div>
                                Auto-filled from <TxLink hash={compoundEstimate.basis.txHash} explorer={token?.explorerUrl || EXPLORER} /> using the latest successful compound caps of {compoundEstimate.basis.ethAmountMax} ETH and {compoundEstimate.basis.sentiAmountMax} SENTI.
                              </div>
                            ) : (
                              <div>
                                Auto-filled from live tracked LP position {compoundEstimate.basis.trackedPositionTokenId ? `#${compoundEstimate.basis.trackedPositionTokenId}` : "state"}
                                {compoundEstimate.basis.currentTick !== null ? ` at tick ${compoundEstimate.basis.currentTick}` : ""}
                                {` using the current LP balances of ${compoundEstimate.basis.ethAmountMax} ETH and ${compoundEstimate.basis.sentiAmountMax} SENTI as the first compound anchor.`}
                              </div>
                            )}
                            <div>
                              Estimated SENTI cap: {compoundEstimate.estimatedSenti} SENTI. {compoundEstimate.validated
                                ? "Live simulation passed for the current manager state."
                                : compoundEstimate.cooldownActive
                                  ? `Cooldown is active until ${formatTime(compoundEstimate.nextCompoundAt)}, so the fill is based on the latest live ratio and will revalidate when you compound later.`
                                  : compoundEstimate.basis.source === "compound_history"
                                    ? "Using the latest successful compound ratio."
                                    : "Using the current tracked LP ratio as the first compound anchor."}
                            </div>
                          </div>
                        )}
                      </div>
                      <div className="grid md:grid-cols-4 gap-2">
                        <input
                          type="text"
                          value={compoundLiquidityInput}
                          onChange={(e) => setCompoundLiquidityInput(e.target.value)}
                          placeholder="Liquidity increase"
                          className="px-3 py-2 bg-zinc-800 border border-zinc-600 rounded text-white text-xs"
                        />
                        <input
                          type="text"
                          value={compoundAmount0MaxInput}
                          onChange={(e) => setCompoundAmount0MaxInput(e.target.value)}
                          placeholder={tokenContract?.sentiIsCurrency0 ? "Amount0 max (SENTI)" : "Amount0 max (ETH)"}
                          className="px-3 py-2 bg-zinc-800 border border-zinc-600 rounded text-white text-xs"
                        />
                        <input
                          type="text"
                          value={compoundAmount1MaxInput}
                          onChange={(e) => setCompoundAmount1MaxInput(e.target.value)}
                          placeholder={tokenContract?.sentiIsCurrency0 ? "Amount1 max (ETH)" : "Amount1 max (SENTI)"}
                          className="px-3 py-2 bg-zinc-800 border border-zinc-600 rounded text-white text-xs"
                        />
                        <input
                          type="text"
                          value={compoundDeadlineInput}
                          onChange={(e) => setCompoundDeadlineInput(e.target.value)}
                          placeholder="Deadline unix ts (optional)"
                          className="px-3 py-2 bg-zinc-800 border border-zinc-600 rounded text-white text-xs"
                        />
                      </div>
                      <button
                        onClick={() =>
                          handleTokenAction(
                            "compoundLiquidity",
                            {
                              liquidityIncrease: compoundLiquidityInput.trim(),
                              amount0Max: compoundAmount0MaxInput.trim(),
                              amount1Max: compoundAmount1MaxInput.trim(),
                              ...(compoundDeadlineInput.trim() ? { deadline: compoundDeadlineInput.trim() } : {}),
                            },
                            "Run a manager compound transaction now?",
                          )
                        }
                        disabled={
                          tokenCompoundDisabled
                          || !compoundLiquidityInput.trim()
                          || !compoundAmount0MaxInput.trim()
                          || !compoundAmount1MaxInput.trim()
                        }
                        className="px-3 py-2 text-xs rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40"
                      >
                        {tokenBusy === "compoundLiquidity"
                          ? "Working…"
                          : tokenCompoundCooldownActive
                            ? `Compound Locked Until ${formatTime(tokenNextCompoundAt)}`
                            : "Compound Now"}
                      </button>
                      {tokenCompoundCooldownActive && (
                        <div className="text-[11px] text-amber-400">
                          Manager cooldown is still active until {formatTime(tokenNextCompoundAt)}. The form stays filled, but the transaction is blocked until then.
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="text-xs text-zinc-500">
                    SentiLiquidityManager is not configured yet. Deploy it and set NEXT_PUBLIC_SENTI_LIQUIDITY_MANAGER_ADDRESS.
                  </p>
                )}
              </div>
            )}

            {/* Supply Grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <StatCard label="Total Minted" value={sup.total} max={sup.max} color="text-white" />
              <StatCard label="Public" value={sup.publicMinted} max={sup.publicCap} color="text-green-400" />
              <StatCard label="Airdrop" value={sup.airdropMinted} max={sup.airdropCap} color="text-yellow-400" />
              <StatCard label="Remaining" value={sup.remaining} max={sup.max} color="text-blue-400" />
            </div>

            <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-4 space-y-3">
              <h2 className="text-sm font-bold text-zinc-400 uppercase">Supply Progress</h2>
              <ProgressBar label="Total" current={sup.total} max={sup.max} color="bg-white" />
              <ProgressBar label="Public Sale" current={sup.publicMinted} max={sup.publicCap} color="bg-green-500" />
              <ProgressBar label="Airdrop Claims" current={sup.airdropMinted} max={sup.airdropCap} color="bg-yellow-500" />
            </div>

            {/* Balances */}
            <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-4 space-y-2">
              <h2 className="text-sm font-bold text-zinc-400 uppercase">ETH Balances</h2>
              <Row
                label="Treasury"
                value={s.balances.treasuryEth !== null ? `${s.balances.treasuryEth} ETH` : "—"}
              />
              <Row
                label="Watcher (URI setter)"
                value={s.balances.serverEth !== null ? `${s.balances.serverEth} ETH` : "—"}
              />
              <Row
                label="Contract (pending withdraw)"
                value={s.balances.contractEth !== null ? `${s.balances.contractEth} ETH` : "—"}
              />
            </div>

            {/* Contract Info */}
            <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-4 space-y-2">
              <h2 className="text-sm font-bold text-zinc-400 uppercase">NFT Contract</h2>
              <Row label="Address" value={c.address} mono />
              <Row label="Treasury" value={c.treasury} mono />
              <Row label="Owner Signer (server)" value={c.ownerSigner ?? "(not configured)"} mono />
              <Row label="Owner has DEFAULT_ADMIN_ROLE" value={c.ownerHasAdminRole ? "Yes" : "No"} />
              <Row label="Watcher (server)" value={c.watcher ?? "(not configured)"} mono />
              <Row label="Watcher has URI_SETTER_ROLE" value={c.watcherHasUriSetterRole ? "Yes" : "No"} />
              <Row label="Airdrop Root" value={c.airdropRootSet ? c.airdropRoot : "(not set)"} mono />
              <Row label="Public Closed" value={c.publicClosed ? "Yes" : "No"} />
              <Row label="Airdrop Closed" value={c.airdropClosed ? "Yes" : "No"} />
              <Row label="Server Time" value={new Date().toLocaleString()} />
            </div>

            {/* Constants */}
            <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-4 space-y-2">
              <h2 className="text-sm font-bold text-zinc-400 uppercase">Constants</h2>
              <Row label="Max Supply" value={String(s.constants.maxSupply)} />
              <Row label="Public Cap" value={String(s.constants.publicCap)} />
              <Row label="Airdrop Cap" value={String(s.constants.airdropCap)} />
              <Row label="Mint Price" value={`${s.constants.mintPrice} ${s.constants.currency}`} />
              <Row label="Max Per Wallet" value={String(s.constants.maxPerWallet)} />
            </div>

            {/* Wallet History Lookup */}
            <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-4 space-y-3">
              <h2 className="text-sm font-bold text-zinc-400 uppercase">Wallet History</h2>
              <form onSubmit={handleWalletLookup} className="flex gap-2">
                <input
                  type="text"
                  value={walletQuery}
                  onChange={(e) => setWalletQuery(e.target.value)}
                  placeholder="0x… recipient address"
                  className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-600 rounded text-white text-sm font-mono"
                />
                <button
                  type="submit"
                  disabled={walletBusy}
                  className="px-4 py-2 text-sm rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50"
                >
                  {walletBusy ? "Loading…" : "Lookup"}
                </button>
              </form>
              {walletError && <p className="text-xs text-red-400">{walletError}</p>}
              {walletData && (
                <div className="space-y-3">
                  <div className="grid grid-cols-3 gap-3 text-xs">
                    <div className="bg-zinc-800 rounded p-2">
                      <div className="text-zinc-500">Public Minted (counter)</div>
                      <div className="text-lg font-bold text-green-400">{walletData.counters.publicMintedBy}</div>
                    </div>
                    <div className="bg-zinc-800 rounded p-2">
                      <div className="text-zinc-500">Currently Holds</div>
                      <div className="text-lg font-bold">{walletData.counters.currentBalance}</div>
                    </div>
                    <div className="bg-zinc-800 rounded p-2">
                      <div className="text-zinc-500">Mints In Window</div>
                      <div className="text-lg font-bold text-blue-400">{walletData.counters.totalMintsInWindow}</div>
                    </div>
                  </div>
                  {walletData.mints.length === 0 ? (
                    <p className="text-xs text-zinc-500">
                      No mints found in lookback window (blocks{" "}
                      {walletData.lookbackFromBlock.toLocaleString()}–
                      {walletData.lookbackToBlock.toLocaleString()}).
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead className="text-zinc-500 uppercase">
                          <tr className="border-b border-zinc-800">
                            <th className="text-left py-2 pr-3">Token</th>
                            <th className="text-left py-2 pr-3">Mint Tx</th>
                            <th className="text-left py-2 pr-3">Signer</th>
                            <th className="text-right py-2 pr-3">ETH Paid</th>
                            <th className="text-left py-2 pr-3">Block</th>
                            <th className="text-left py-2">Minted</th>
                          </tr>
                        </thead>
                        <tbody>
                          {walletData.mints.map((m) => (
                            <tr key={m.tokenId} className="border-b border-zinc-800/50">
                              <td className="py-2 pr-3 font-mono">#{m.tokenId}</td>
                              <td className="py-2 pr-3 font-mono">
                                <TxLink hash={m.mintTxHash} />
                              </td>
                              <td className="py-2 pr-3 font-mono">
                                {m.mintSigner ? shortAddr(m.mintSigner) : "—"}
                              </td>
                              <td className="py-2 pr-3 text-right font-mono">{m.ethPaid}</td>
                              <td className="py-2 pr-3 text-zinc-400">{m.blockNumber.toLocaleString()}</td>
                              <td className="py-2 text-zinc-400">{formatTime(m.mintedAt)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Irys */}
            <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-4 space-y-3">
              <h2 className="text-sm font-bold text-zinc-400 uppercase">Irys Storage</h2>
              {irysError && <p className="text-xs text-red-400">{irysError}</p>}
              {irysStatus && (
                <>
                  <Row label="Network" value={irysStatus.network} />
                  <Row label="Token" value={irysStatus.token} />
                  <Row label="Address" value={irysStatus.address} mono />
                  <Row label="Loaded Balance" value={`${irysStatus.loadedBalance} ${irysStatus.token}`} />
                  {irysStatus.estimate && (
                    <Row
                      label="≈ Mints Remaining"
                      value={
                        irysStatus.estimate.estimatedMintsRemaining !== null
                          ? irysStatus.estimate.estimatedMintsRemaining.toLocaleString()
                          : "—"
                      }
                    />
                  )}
                  <form onSubmit={handleIrysFund} className="flex gap-2 pt-2">
                    <input
                      type="text"
                      value={irysAmount}
                      onChange={(e) => setIrysAmount(e.target.value)}
                      placeholder="0.05"
                      className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-600 rounded text-white text-sm font-mono"
                    />
                    <button
                      type="submit"
                      disabled={irysBusy}
                      className="px-4 py-2 text-sm rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50"
                    >
                      {irysBusy ? "Funding…" : "Fund Irys"}
                    </button>
                  </form>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
