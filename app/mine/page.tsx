"use client"

import Link from "next/link"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useAccount, useChainId, useWriteContract } from "wagmi"
import { Activity, ArrowUpRight, ChevronDown, ChevronUp, Clock, Database, Radio, RefreshCw, ShieldAlert, ShieldCheck, Square, Zap } from "lucide-react"
import { Mining3DBlocks, type MiningBlocksStreamTimeline } from "@/components/Mining3DBlocks"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { fetchJson } from "@/lib/fetch-json"
import { miningExplorerTx, miningPublicConfig } from "@/lib/mining-config"
import { PATROL_MINER_ABI } from "@/lib/mining-contracts"

interface MiningChallenge {
  id: string
  type: string
  prompt: string
  inputMode: string
  issuedAt: string
  expiresAt: string
  answerWindowSeconds: number
}

interface MiningSession {
  id: string
  wallet: string
  connectedAt: string
  lastHeartbeatAt: string
  warmupUntil: string
  warmupRemainingSeconds: number
  warmupPassed?: boolean
  active: boolean
  sessionStatus: "warming_up" | "active" | "challenge_pending" | "stopped"
  stopReason: string | null
  stoppedAt: string | null
  nextChallengeAt: string | null
  challengeFailureStreak: number
  miningLockedUntil: string | null
  lockRemainingSeconds: number
  heartbeatEverySeconds: number
  inactiveAfterSeconds: number
  challenge: MiningChallenge | null
}

interface MiningStats {
  chain: {
    deployment: string
    miningChainName: string
    nftSourceChainName: string
  }
  activeMiners: number
  activePower: string
  database: {
    configured: boolean
    error: string | null
  }
  patrolMiner: {
    configured: boolean
    address: string | null
    currentBlock: number | null
    startBlock?: number | null
    started: boolean
    active: boolean
    mined?: string
    mineableSupply?: string
    rewardedRounds?: number
    maxRewardRounds?: number
    blockReward?: string
    error: string | null
  }
  winnerStats: {
    totalWins: number
    claimedWins: number
    pendingWins: number
  }
}

interface PowerStatus {
  wallet: string
  status: string
  walletPower: string
  nftCount: number
  eligibleNftCount: number
  rulesCommitment: string | null
  computedAt: string | null
  expiresAt: string | null
  tokens: unknown[]
}

interface MiningWin {
  blockNumber: number
  bucketId: number | null
  blockHash: `0x${string}`
  winner: `0x${string}`
  winnerPower: string
  signature: `0x${string}`
  claimed: boolean
  claimedTxHash: `0x${string}` | null
  reward: string | null
  createdAt: string
}

interface AggregateClaimVoucher {
  winner: `0x${string}`
  bucketIds: number[]
  cumulativeRounds: number[]
  roundCount: number
  reward: string
  signature: `0x${string}`
}

interface WinsResponse {
  wallet: string
  pendingCount: number
  aggregateClaim: AggregateClaimVoucher | null
  wins: MiningWin[]
}

interface ClaimedWinsResponse {
  wallet: string
  claimedCount: number
  claimedRewardTotal: string
  wins: MiningWin[]
}

interface MiningStreamRefreshPayload {
  wallet?: string | null
  issuedAt?: string
  timeline?: MiningBlocksStreamTimeline
}

interface ConnectResponse {
  ok: boolean
  session?: MiningSession
  reason?: string
  error?: string
  retryAt?: string | null
  retryInSeconds?: number
  challengeFailureStreak?: number
}

interface SessionResponse {
  ok: boolean
  session: MiningSession | null
  reason?: string
}

function compact(value: string | null | undefined) {
  if (!value) return "-"
  if (value.length <= 14) return value
  return `${value.slice(0, 6)}...${value.slice(-4)}`
}

function numberText(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") return "-"
  if (typeof value === "number") return value.toLocaleString()
  try {
    return BigInt(value).toLocaleString()
  } catch {
    return value
  }
}

function sumRewardText(wins: Array<{ reward: string | null }>) {
  return wins.reduce((total, win) => {
    if (!win.reward) return total
    try {
      return total + BigInt(win.reward)
    } catch {
      return total
    }
  }, 0n)
}

function secondsUntilLocal(value: string | null | undefined) {
  if (!value) return 0
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return 0
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1000))
}

function durationText(totalSeconds: number) {
  const seconds = Math.max(0, totalSeconds)
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}:${String(rest).padStart(2, "0")}`
}

function StatusPill({ label, tone = "neutral" }: { label: string; tone?: "neutral" | "live" | "warn" | "down" }) {
  const cls = tone === "live"
    ? "border-status-live/30 bg-status-live/10 text-status-live"
    : tone === "warn"
      ? "border-yellow-400/30 bg-yellow-400/10 text-yellow-200"
      : tone === "down"
        ? "border-red-400/30 bg-red-400/10 text-red-200"
        : "border-sentinel/25 bg-sentinel/10 text-sentinel"
  return <span className={`inline-flex h-6 items-center rounded-md border px-2 text-[10px] ${cls}`}>{label}</span>
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-h-[4.5rem] min-w-0 flex-col justify-between rounded-lg border border-sentinel/15 bg-background/60 p-3">
      <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
      <div className="mt-2 min-w-0 break-words text-sm leading-snug text-foreground">{value}</div>
    </div>
  )
}

export default function MinePage() {
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const { writeContractAsync } = useWriteContract()
  const [session, setSession] = useState<MiningSession | null>(null)
  const [stats, setStats] = useState<MiningStats | null>(null)
  const [power, setPower] = useState<PowerStatus | null>(null)
  const [wins, setWins] = useState<MiningWin[]>([])
  const [pendingWinsCount, setPendingWinsCount] = useState(0)
  const [aggregateClaim, setAggregateClaim] = useState<AggregateClaimVoucher | null>(null)
  const [claimedWins, setClaimedWins] = useState<MiningWin[]>([])
  const [claimedWinsCount, setClaimedWinsCount] = useState(0)
  const [claimedRewardTotal, setClaimedRewardTotal] = useState("0")
  const [streamTimeline, setStreamTimeline] = useState<MiningBlocksStreamTimeline | null>(null)
  const [busy, setBusy] = useState(false)
  const [claimingWins, setClaimingWins] = useState(false)
  const [claimPendingTxHash, setClaimPendingTxHash] = useState<`0x${string}` | null>(null)
  const [claimConfirmedTxHash, setClaimConfirmedTxHash] = useState<`0x${string}` | null>(null)
  const [pendingTrayOpen, setPendingTrayOpen] = useState(false)
  const [claimedTrayOpen, setClaimedTrayOpen] = useState(false)

  const [error, setError] = useState<string | null>(null)
  const [lockUntil, setLockUntil] = useState<string | null>(null)
  const [challengeAnswer, setChallengeAnswer] = useState("")
  const [challengeBusy, setChallengeBusy] = useState(false)
  const [nowTick, setNowTick] = useState(0)

  const sessionWalletMatches = useMemo(() => {
    if (!address || !session) return false
    return session.wallet.toLowerCase() === address.toLowerCase()
  }, [address, session])

  const activeChallenge = sessionWalletMatches ? session?.challenge ?? null : null
  const lockRemainingSeconds = Math.max(
    secondsUntilLocal(lockUntil),
    sessionWalletMatches ? session?.lockRemainingSeconds ?? 0 : 0,
  )
  const challengeRemainingSeconds = activeChallenge ? secondsUntilLocal(activeChallenge.expiresAt) : 0
  const pendingRewardTotal = useMemo(() => {
    if (aggregateClaim?.reward) return aggregateClaim.reward
    return sumRewardText(wins).toString()
  }, [aggregateClaim, wins])
  const displayCurrentBlock = streamTimeline?.currentBlock ?? stats?.patrolMiner.currentBlock ?? null

  const loadStats = useCallback(async () => {
    const data = await fetchJson<MiningStats>("/api/mining/stats", { cache: "no-store" })
    setStats(data)
    return data
  }, [])

  const loadPower = useCallback(async (wallet: string) => {
    const data = await fetchJson<PowerStatus>(`/api/mining/me/power?wallet=${wallet}`, { cache: "no-store" })
    setPower(data)
  }, [])

  const loadWins = useCallback(async (wallet: string) => {
    const data = await fetchJson<WinsResponse>(`/api/mining/me/wins?wallet=${wallet}`, { cache: "no-store" })
    setWins(data.wins)
    setPendingWinsCount(data.pendingCount)
    setAggregateClaim(data.aggregateClaim)
  }, [])

  const loadClaimedWins = useCallback(async (wallet: string) => {
    const data = await fetchJson<ClaimedWinsResponse>(`/api/mining/me/wins/claimed?wallet=${wallet}`, { cache: "no-store" })
    setClaimedWins(data.wins)
    setClaimedWinsCount(data.claimedCount)
    setClaimedRewardTotal(data.claimedRewardTotal)
  }, [])

  const refreshMiningWalletState = useCallback(async (wallet: string) => {
    await Promise.all([loadWins(wallet), loadClaimedWins(wallet), loadStats()])
  }, [loadClaimedWins, loadStats, loadWins])

  const claimWins = useCallback(async () => {
    if (!address) {
      setError("Connect a wallet before claiming")
      return
    }
    if (!aggregateClaim) {
      setError("Claim voucher is still syncing from the backend")
      return
    }
    if (!miningPublicConfig.miningChain.contracts.patrolMiner) {
      setError("PatrolMiner address is not configured")
      return
    }
    if (chainId !== miningPublicConfig.miningChain.chainId) {
      setError(`Switch wallet to ${miningPublicConfig.miningChain.name} before claiming`)
      return
    }

    setClaimingWins(true)
    setClaimConfirmedTxHash(null)
    setError(null)
    try {
      const txHash = await writeContractAsync({
        address: miningPublicConfig.miningChain.contracts.patrolMiner,
        abi: PATROL_MINER_ABI,
        functionName: "aggregateClaim",
        chainId: miningPublicConfig.miningChain.chainId,
        args: [
          aggregateClaim.winner,
          aggregateClaim.bucketIds.map((value) => BigInt(value)),
          aggregateClaim.cumulativeRounds.map((value) => BigInt(value)),
          aggregateClaim.signature,
        ],
      })

      setClaimPendingTxHash(txHash)
      setAggregateClaim(null)
      await refreshMiningWalletState(address)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Claim failed")
    } finally {
      setClaimingWins(false)
    }
  }, [address, aggregateClaim, chainId, refreshMiningWalletState, writeContractAsync])

  const startSession = useCallback(async () => {
    if (!address) return
    setBusy(true)
    setError(null)
    try {
      const latestStats = await loadStats()
      if (!latestStats.patrolMiner.active) {
        setSession(null)
        setError(latestStats.patrolMiner.error ?? "Mining has not been started by admin yet")
        return
      }

      const data = await fetchJson<ConnectResponse>("/api/mining/session/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: address }),
      })
      if (!data.ok) {
        setSession(null)
        setLockUntil(data.retryAt ?? null)
        setError(data.error ?? "Mining is cooling down")
        return
      }
      if (data.session) {
        setSession(data.session)
        setLockUntil(data.session.miningLockedUntil)
      }
      await Promise.all([loadStats(), loadPower(address), loadWins(address), loadClaimedWins(address)])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Mining session failed")
    } finally {
      setBusy(false)
    }
  }, [address, loadClaimedWins, loadPower, loadStats, loadWins])

  const sendHeartbeat = useCallback(async (quiet = false) => {
    try {
      const data = await fetchJson<SessionResponse>("/api/mining/session/heartbeat", {
        method: "POST",
      })
      if (data.session) {
        setSession(data.session)
        setLockUntil(data.session.miningLockedUntil)
        if (!data.session.challenge) setChallengeAnswer("")
      }
    } catch (err) {
      if (!quiet) setError(err instanceof Error ? err.message : "Heartbeat failed")
    }
  }, [])

  const stopSession = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const data = await fetchJson<SessionResponse>("/api/mining/session/stop", { method: "POST" })
      if (data.session) {
        setSession(data.session)
        setLockUntil(data.session.miningLockedUntil)
      } else {
        setSession(null)
      }
      setChallengeAnswer("")
      await loadStats()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Stop mining failed")
    } finally {
      setBusy(false)
    }
  }, [loadStats])

  const submitChallenge = useCallback(async () => {
    if (!activeChallenge) return
    setChallengeBusy(true)
    setError(null)
    try {
      const data = await fetchJson<SessionResponse>("/api/mining/challenge/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId: activeChallenge.id, answer: challengeAnswer }),
      })
      if (data.session) {
        setSession(data.session)
        setLockUntil(data.session.miningLockedUntil)
      }
      if (!data.ok) setError(data.reason === "challenge_expired" ? "Challenge expired. Mining stopped." : "Challenge failed. Mining stopped.")
      setChallengeAnswer("")
      await Promise.all([
        loadStats(),
        address ? loadPower(address) : Promise.resolve(),
        address ? loadWins(address) : Promise.resolve(),
        address ? loadClaimedWins(address) : Promise.resolve(),
      ])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Challenge answer failed")
    } finally {
      setChallengeBusy(false)
    }
  }, [activeChallenge, address, challengeAnswer, loadClaimedWins, loadPower, loadStats, loadWins])

  useEffect(() => {
    if (!address) {
      setSession(null)
      setPower(null)
      setWins([])
      setPendingWinsCount(0)
      setAggregateClaim(null)
      setClaimedWins([])
      setClaimedWinsCount(0)
      setClaimedRewardTotal("0")
      setClaimingWins(false)
      setClaimPendingTxHash(null)
      setClaimConfirmedTxHash(null)
      setPendingTrayOpen(false)
      setClaimedTrayOpen(false)
      setLockUntil(null)
      return
    }
    void sendHeartbeat(true)
  }, [address, sendHeartbeat])

  useEffect(() => {
    if (!claimPendingTxHash) return
    const claimSeen = claimedWins.some((win) => win.claimedTxHash?.toLowerCase() === claimPendingTxHash.toLowerCase())
    if (!claimSeen) return

    setClaimConfirmedTxHash(claimPendingTxHash)
    setClaimPendingTxHash(null)
  }, [claimPendingTxHash, claimedWins])

  useEffect(() => {
    if (!address || !claimPendingTxHash) return

    const refreshClaimState = () => {
      void refreshMiningWalletState(address).catch(() => undefined)
    }

    refreshClaimState()
    const id = window.setInterval(refreshClaimState, 5000)
    return () => window.clearInterval(id)
  }, [address, claimPendingTxHash, refreshMiningWalletState])

  useEffect(() => {
    const refresh = () => {
      void loadStats().catch((err) => setError(err instanceof Error ? err.message : "Stats unavailable"))
      if (!address) return
      void loadPower(address).catch(() => undefined)
      void loadWins(address).catch(() => undefined)
      void loadClaimedWins(address).catch(() => undefined)
    }

    refresh()

    const stream = new EventSource(address ? `/api/mining/stream?wallet=${address}` : "/api/mining/stream")
    const onRefresh = (event: Event) => {
      const message = event as MessageEvent<string>
      try {
        const payload = JSON.parse(message.data) as MiningStreamRefreshPayload
        if (payload.timeline) {
          setStreamTimeline(payload.timeline)
          if (payload.timeline.currentBlock !== null && payload.timeline.currentBlock !== undefined) {
            setStats((value) => value ? {
              ...value,
              patrolMiner: {
                ...value.patrolMiner,
                currentBlock: payload.timeline?.currentBlock ?? value.patrolMiner.currentBlock,
              },
            } : value)
          }
        }
      } catch {
        // Ignore malformed refresh payloads and keep the normal refetch path.
      }
      refresh()
    }

    stream.addEventListener("refresh", onRefresh)
    stream.onerror = () => undefined

    return () => {
      stream.removeEventListener("refresh", onRefresh)
      stream.close()
    }
  }, [address, loadClaimedWins, loadPower, loadStats, loadWins])

  useEffect(() => {
    if (!sessionWalletMatches || session?.sessionStatus === "stopped") return
    const id = window.setInterval(() => {
      void sendHeartbeat(true)
    }, Math.max(5, session?.heartbeatEverySeconds ?? 10) * 1000)
    return () => window.clearInterval(id)
  }, [sendHeartbeat, session?.heartbeatEverySeconds, session?.sessionStatus, sessionWalletMatches])

  useEffect(() => {
    if (!sessionWalletMatches || session?.sessionStatus === "stopped") return

    const handleResume = () => {
      if (document.visibilityState !== "hidden") void sendHeartbeat(true)
    }

    window.addEventListener("focus", handleResume)
    document.addEventListener("visibilitychange", handleResume)

    return () => {
      window.removeEventListener("focus", handleResume)
      document.removeEventListener("visibilitychange", handleResume)
    }
  }, [sendHeartbeat, session?.sessionStatus, sessionWalletMatches])

  useEffect(() => {
    const id = window.setInterval(() => setNowTick((value) => value + 1), 1000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    if (!activeChallenge || challengeRemainingSeconds > 0) return
    void sendHeartbeat(true)
  }, [activeChallenge, challengeRemainingSeconds, sendHeartbeat, nowTick])

  const patrolTone = stats?.patrolMiner.active ? "live" : stats?.patrolMiner.started ? "warn" : "neutral"
  const dbTone = stats?.database.configured ? "live" : "down"
  const sessionTone = sessionWalletMatches && session?.active ? "live" : "neutral"
  const sessionLabel = sessionWalletMatches ? session?.sessionStatus.replace("_", " ") ?? "linked" : "idle"
  const miningCanStart = Boolean(stats?.patrolMiner.active)
  const startDisabled = !isConnected || !miningCanStart || busy || lockRemainingSeconds > 0 || Boolean(sessionWalletMatches && session?.active)
  const startLabel = !miningCanStart
    ? "Admin start required"
    : lockRemainingSeconds > 0
      ? `Locked ${durationText(lockRemainingSeconds)}`
      : "Start"

  return (
    <main className="relative min-h-screen overflow-x-hidden bg-background">
      {activeChallenge && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/85 px-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-lg border border-sentinel/40 bg-card p-5 shadow-2xl shadow-sentinel/10">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm text-sentinel">
                <ShieldAlert className="size-4" /> Presence Check
              </div>
              <div className="flex items-center gap-1 rounded-md border border-yellow-400/30 bg-yellow-400/10 px-2 py-1 text-xs text-yellow-100">
                <Clock className="size-3" /> {durationText(challengeRemainingSeconds)}
              </div>
            </div>
            <div className="mt-5 text-center">
              <div className="text-xs uppercase text-muted-foreground">Solve</div>
              <div className="mt-2 font-pixel text-2xl text-foreground">{activeChallenge.prompt}</div>
            </div>
            <form
              className="mt-5 space-y-3"
              onSubmit={(event) => {
                event.preventDefault()
                void submitChallenge()
              }}
            >
              <input
                value={challengeAnswer}
                onChange={(event) => setChallengeAnswer(event.target.value)}
                inputMode={activeChallenge.inputMode === "numeric" ? "numeric" : "text"}
                autoFocus
                className="w-full rounded-md border border-sentinel/30 bg-background px-3 py-3 text-center text-lg text-foreground outline-none focus:border-sentinel"
              />
              <Button className="w-full" type="submit" disabled={challengeBusy || challengeRemainingSeconds === 0 || !challengeAnswer.trim()}>
                <ShieldCheck className="size-4" /> {challengeBusy ? "Checking" : "Submit"}
              </Button>
            </form>
          </div>
        </div>
      )}

      {/* Main UI Container */}
      <div className="relative mx-auto flex w-full max-w-7xl flex-col gap-5 py-8 sm:px-6 lg:px-8">
        
        {/* Dedicated 3D Blocks Frame - Infinite Width and Flat Panning! */}
        <div className="h-[35vh] w-[100vw] relative left-1/2 right-1/2 -mx-[50vw] z-20 cursor-grab active:cursor-grabbing">
          <Mining3DBlocks currentBlock={displayCurrentBlock} streamTimeline={streamTimeline} />
        </div>

        {/* Start inner constraint for rest of UI */}
        <div className="px-4 w-full mx-auto max-w-7xl">
          <section className="border-b border-sentinel/15 pb-5">
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <StatusPill label={stats?.chain.deployment ?? "testnet"} />
              <StatusPill label={stats?.patrolMiner.active ? "mining active" : stats?.patrolMiner.started ? "started" : "not started"} tone={patrolTone} />
              <StatusPill label={stats?.database.configured ? "db online" : "db offline"} tone={dbTone} />
            </div>
            <h1 className="font-pixel text-xl text-sentinel sm:text-2xl">SENTI Mining</h1>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="text-xs uppercase tracking-[0.14em] text-muted-foreground">SENTI Trade</span>
              <Link
                href="/trade"
                className="inline-flex h-8 items-center justify-center gap-1 rounded-lg border border-sentinel/30 bg-sentinel/10 px-3 text-sm font-medium text-sentinel transition hover:bg-sentinel/20"
              >
                Open Trade Page <ArrowUpRight className="size-4" />
              </Link>
            </div>
          </div>
        </section>

        {error && (
          <div className="rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-100">
            {error}
          </div>
        )}

        <section className="grid gap-4 md:grid-cols-2">
          <Card className="sentinel-card rounded-lg border border-sentinel/15 bg-card/90 md:h-[26rem]">
            <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <ShieldCheck className="size-4 text-sentinel" /> Session
              </CardTitle>
              <StatusPill label={sessionLabel} tone={sessionTone} />
            </CardHeader>
            <CardContent className="flex h-full flex-1 flex-col justify-between gap-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Metric label="Wallet" value={address ? compact(address) : "-"} />
                <Metric label="Warmup" value={sessionWalletMatches ? `${session?.warmupRemainingSeconds ?? 0}s` : "-"} />
                <Metric label="Heartbeat" value={sessionWalletMatches && session ? new Date(session.lastHeartbeatAt).toLocaleTimeString() : "-"} />
                <Metric label="Lock" value={lockRemainingSeconds > 0 ? durationText(lockRemainingSeconds) : "-"} />
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <Button className="w-full justify-center" onClick={startSession} disabled={startDisabled} title="Start mining session">
                  <Zap className="size-4" /> {startLabel}
                </Button>
                <Button className="w-full justify-center" variant="outline" onClick={() => void sendHeartbeat()} disabled={!sessionWalletMatches || busy} title="Send heartbeat">
                  <Radio className="size-4" /> Pulse
                </Button>
                <Button className="w-full justify-center" variant="outline" onClick={stopSession} disabled={!sessionWalletMatches || busy} title="Stop mining session">
                  <Square className="size-4" /> Stop
                </Button>
                <Button className="w-full justify-center" variant="ghost" onClick={() => void loadStats()} title="Refresh stats">
                  <RefreshCw className="size-4" /> Refresh
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card className="sentinel-card rounded-lg border border-sentinel/15 bg-card/90 md:h-[26rem]">
            <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Activity className="size-4 text-sentinel" /> Network
              </CardTitle>
              <StatusPill label={stats?.chain.miningChainName ?? "Sepolia"} />
            </CardHeader>
            <CardContent className="grid h-full flex-1 gap-3 sm:grid-cols-2">
              <Metric label="Current Block" value={displayCurrentBlock?.toLocaleString() ?? "-"} />
              <Metric label="Active Miners" value={numberText(stats?.activeMiners)} />
              <Metric label="Active Power" value={numberText(stats?.activePower)} />
              <Metric label="Reward" value={stats?.patrolMiner.blockReward ? `${stats.patrolMiner.blockReward} SENTI` : "-"} />
              <Metric label="Won Blocks" value={stats?.patrolMiner.maxRewardRounds !== undefined ? `${stats?.winnerStats.totalWins?.toLocaleString() ?? "0"} / ${stats.patrolMiner.maxRewardRounds.toLocaleString()}` : numberText(stats?.winnerStats.totalWins)} />
              <Metric label="Claimed Rounds" value={numberText(stats?.winnerStats.claimedWins)} />
              <Metric label="Global Pending" value={numberText(stats?.winnerStats.pendingWins)} />
              <Metric label="Mined" value={stats?.patrolMiner.mined ? `${stats.patrolMiner.mined} SENTI` : "-"} />
              <Metric label="Mineable" value={stats?.patrolMiner.mineableSupply ? `${stats.patrolMiner.mineableSupply} SENTI` : "-"} />
              <Metric label="Miner" value={compact(stats?.patrolMiner.address)} />
              <div className="sm:col-span-2 rounded-lg border border-sentinel/15 bg-background/60 p-3">
                <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Trade</div>
                <div className="mt-2 text-sm text-foreground">
                  Open the internal SENTI trade page and buy or sell directly on {stats?.chain.miningChainName ?? "Sepolia"}.
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Link
                    href="/trade"
                    className="inline-flex h-8 items-center justify-center gap-1 rounded-lg border border-sentinel/30 bg-sentinel/10 px-3 text-sm font-medium text-sentinel transition hover:bg-sentinel/20"
                  >
                    Open Trade Page <ArrowUpRight className="size-4" />
                  </Link>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="sentinel-card rounded-lg border border-sentinel/15 bg-card/90 md:h-[26rem]">
            <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Database className="size-4 text-sentinel" /> Power Cache
              </CardTitle>
              <StatusPill label={power?.status ?? "not cached"} tone={power?.status === "ready" ? "live" : "warn"} />
            </CardHeader>
            <CardContent className="grid h-full flex-1 gap-3 sm:grid-cols-2">
              <Metric label="Wallet Power" value={numberText(power?.walletPower)} />
              <Metric label="NFTs" value={numberText(power?.nftCount)} />
              <Metric label="Eligible" value={numberText(power?.eligibleNftCount)} />
              <Metric label="Computed" value={power?.computedAt ? new Date(power.computedAt).toLocaleTimeString() : "-"} />
              <Metric label="Expires" value={power?.expiresAt ? new Date(power.expiresAt).toLocaleTimeString() : "-"} />
              <Metric label="Rules" value={compact(power?.rulesCommitment)} />
            </CardContent>
          </Card>

          <Card className="sentinel-card rounded-lg border border-sentinel/15 bg-card/90 md:h-[26rem]">
            <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
              <CardTitle className="text-sm">Readiness</CardTitle>
            </CardHeader>
            <CardContent className="grid h-full flex-1 gap-3 text-xs sm:grid-cols-2">
              <ReadinessRow label="Wallet" ok={isConnected} />
              <ReadinessRow label="Session" ok={Boolean(sessionWalletMatches && session?.active)} />
              <ReadinessRow label="Warmup" ok={Boolean(sessionWalletMatches && session?.warmupRemainingSeconds === 0)} />
              <ReadinessRow label="Presence" ok={Boolean(sessionWalletMatches && session?.sessionStatus !== "challenge_pending" && session?.sessionStatus !== "stopped")} />
              <ReadinessRow label="Power" ok={power?.status === "ready" && power.walletPower !== "0"} />
              <ReadinessRow label="PatrolMiner" ok={Boolean(stats?.patrolMiner.active)} />
            </CardContent>
          </Card>

          <Card className="sentinel-card rounded-lg border border-sentinel/15 bg-card/90 md:col-span-2">
            <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Zap className="size-4 text-sentinel" /> Claim Rewards
              </CardTitle>
              <StatusPill label={`${pendingWinsCount} pending`} tone={pendingWinsCount > 0 ? "live" : "neutral"} />
            </CardHeader>
            <CardContent className="space-y-3">
              {claimConfirmedTxHash && (
                <div className="rounded-lg border border-status-live/25 bg-status-live/10 px-3 py-2 text-xs text-status-live">
                  Claim confirmed: <a className="underline underline-offset-2" href={miningExplorerTx(claimConfirmedTxHash)} target="_blank" rel="noreferrer">{compact(claimConfirmedTxHash)}</a>
                </div>
              )}
              {claimPendingTxHash && (
                <div className="rounded-lg border border-yellow-400/20 bg-yellow-400/10 px-3 py-2 text-xs text-yellow-100">
                  <div>Your wallet submitted the claim transaction. Gas is paid by the connected wallet, and this page will unlock once the backend sees the confirmed tx.</div>
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <a className="underline underline-offset-2" href={miningExplorerTx(claimPendingTxHash)} target="_blank" rel="noreferrer">View transaction {compact(claimPendingTxHash)}</a>
                    <button
                      type="button"
                      className="underline underline-offset-2"
                      onClick={() => {
                        if (!address) return
                        void refreshMiningWalletState(address)
                      }}
                    >
                      Refresh claim status
                    </button>
                    <button
                      type="button"
                      className="underline underline-offset-2"
                      onClick={() => setClaimPendingTxHash(null)}
                    >
                      Clear submitted tx
                    </button>
                  </div>
                </div>
              )}
              {pendingWinsCount === 0 ? (
                <div className="rounded-lg border border-sentinel/10 bg-background/50 px-3 py-4 text-xs text-muted-foreground">
                  No unclaimed wins for this wallet yet.
                </div>
              ) : (
                <>
                  <div className="rounded-lg border border-sentinel/15 bg-background/60 p-3">
                    <div className="grid gap-3 sm:grid-cols-3">
                      <Metric label="Pending Wins" value={numberText(pendingWinsCount)} />
                      <Metric label="Pending Reward" value={`${numberText(pendingRewardTotal)} SENTI`} />
                      <Metric label="Latest Block" value={wins[0]?.blockNumber ? wins[0].blockNumber.toLocaleString() : "-"} />
                    </div>
                    {aggregateClaim ? (
                      <div className="mt-3 rounded-lg border border-status-live/20 bg-status-live/10 px-3 py-2 text-xs text-status-live">
                        Bucket voucher ready: one wallet tx can mint {numberText(aggregateClaim.reward)} SENTI across {aggregateClaim.roundCount.toLocaleString()} live wins.
                      </div>
                    ) : (
                      <div className="mt-3 rounded-lg border border-yellow-400/20 bg-yellow-400/10 px-3 py-2 text-xs text-yellow-100">
                        Claim state is syncing from the backend. The claim button unlocks when the next server-confirmed bucket voucher is ready.
                      </div>
                    )}
                    {claimingWins && (
                      <div className="mt-3 rounded-lg border border-yellow-400/20 bg-yellow-400/10 px-3 py-2 text-xs text-yellow-100">
                        Confirm the claim transaction in your wallet. After the wallet returns a tx hash, this page will track the claim through backend sync.
                      </div>
                    )}
                    <Button className="mt-3 w-full justify-center" onClick={() => void claimWins()} disabled={claimingWins || !aggregateClaim || Boolean(claimPendingTxHash)}>
                      <Zap className="size-4" /> {claimingWins ? "Confirm Claim In Wallet" : claimPendingTxHash ? "Claim Submitted" : aggregateClaim ? "Claim Everything Mined So Far" : "Waiting For Claim Voucher"}
                    </Button>
                  </div>

                  <div className="rounded-lg border border-sentinel/15 bg-background/50 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                        {pendingWinsCount > wins.length ? `Recent Pending Frames (${wins.length} shown)` : "Pending Frames"}
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-expanded={pendingTrayOpen}
                        onClick={() => setPendingTrayOpen((value) => !value)}
                      >
                        {pendingTrayOpen ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
                        {pendingTrayOpen ? "Hide" : "Show"}
                      </Button>
                    </div>
                    {pendingTrayOpen && (
                      <div className="mt-3 space-y-2">
                        {wins.map((win) => (
                          <div key={win.blockNumber} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-sentinel/10 bg-background/60 px-3 py-2 text-xs text-muted-foreground">
                            <div className="flex min-w-0 flex-col gap-1">
                              <span className="font-pixel text-sm text-foreground">Block {win.blockNumber.toLocaleString()}</span>
                              <span>Hash: <span className="text-foreground">{compact(win.blockHash)}</span></span>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              <StatusPill label={win.reward ? `${win.reward} SENTI` : "reward"} tone="live" />
                              <span>Power: <span className="text-foreground">{numberText(win.winnerPower)}</span></span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card className="sentinel-card rounded-lg border border-sentinel/15 bg-card/90 md:col-span-2">
            <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <ShieldCheck className="size-4 text-sentinel" /> Claimed Rewards
              </CardTitle>
              <StatusPill label={`${claimedWinsCount} claimed`} tone={claimedWinsCount > 0 ? "live" : "neutral"} />
            </CardHeader>
            <CardContent className="space-y-3">
              {claimedWinsCount === 0 ? (
                <div className="rounded-lg border border-sentinel/10 bg-background/50 px-3 py-4 text-xs text-muted-foreground">
                  No claimed rewards for this wallet yet.
                </div>
              ) : (
                <>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Metric label="Claimed Wins" value={numberText(claimedWinsCount)} />
                    <Metric label="Claimed Reward" value={`${numberText(claimedRewardTotal)} SENTI`} />
                    <Metric label="Latest Claimed Block" value={claimedWins[0]?.blockNumber ? claimedWins[0].blockNumber.toLocaleString() : "-"} />
                  </div>
                  <div className="rounded-lg border border-sentinel/15 bg-background/50 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                        {claimedWinsCount > claimedWins.length ? `Recent Claimed Frames (${claimedWins.length} shown)` : "Claimed Frames"}
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-expanded={claimedTrayOpen}
                        onClick={() => setClaimedTrayOpen((value) => !value)}
                      >
                        {claimedTrayOpen ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
                        {claimedTrayOpen ? "Hide" : "Show"}
                      </Button>
                    </div>
                    {claimedTrayOpen && (
                      <div className="mt-3 space-y-2">
                        {claimedWins.map((win) => (
                          <div key={`${win.blockNumber}-${win.claimedTxHash ?? "claimed"}`} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-sentinel/10 bg-background/60 px-3 py-2 text-xs text-muted-foreground">
                            <div className="flex min-w-0 flex-col gap-1">
                              <span className="font-pixel text-sm text-foreground">Block {win.blockNumber.toLocaleString()}</span>
                              <span>Tx: <span className="text-foreground">{compact(win.claimedTxHash)}</span></span>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              <StatusPill label={win.reward ? `${win.reward} SENTI` : "reward"} tone="live" />
                              <span>Power: <span className="text-foreground">{numberText(win.winnerPower)}</span></span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </section>
        </div>
      </div>
    </main>
  )
}

function ReadinessRow({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="flex min-h-[4.5rem] min-w-0 items-center justify-between gap-3 rounded-lg border border-sentinel/10 bg-background/50 px-3 py-2">
      <span className="min-w-0 text-sm text-muted-foreground">{label}</span>
      <StatusPill label={ok ? "ok" : "pending"} tone={ok ? "live" : "neutral"} />
    </div>
  )
}