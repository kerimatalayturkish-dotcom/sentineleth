"use client"

import { useState, useEffect, useCallback } from "react"

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

function TxLink({ hash }: { hash: string }) {
  return (
    <a
      href={`${EXPLORER}/tx/${hash}`}
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
      <span className="text-zinc-500">{label}</span>
      <span className={`text-zinc-200 ${mono ? "font-mono" : ""}`}>{value}</span>
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
  const [loginError, setLoginError] = useState("")
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

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoginError("")
    const res = await fetch("/api/admin/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    })
    if (res.ok) {
      setAuthed(true)
      setPassword("")
      fetchStatus()
    } else {
      const data = await res.json()
      setLoginError(data.error || "Login failed")
    }
  }

  async function handleLogout() {
    await fetch("/api/admin/auth", { method: "DELETE" })
    setAuthed(false)
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

  if (!authed) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <form onSubmit={handleLogin} className="bg-zinc-900 p-8 rounded-lg border border-zinc-700 w-80 space-y-4">
          <h1 className="text-white text-lg font-bold text-center">Admin Monitor</h1>
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
          {loginError && <p className="text-red-400 text-xs">{loginError}</p>}
          <button type="submit" className="w-full py-2 bg-blue-600 hover:bg-blue-500 text-white rounded text-sm font-medium">
            Login
          </button>
        </form>
      </div>
    )
  }

  const s = status
  const c = s?.contract
  const sup = s?.supply

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
                <h2 className="text-sm font-bold text-zinc-400 uppercase">Contract Actions</h2>
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
              <h2 className="text-sm font-bold text-zinc-400 uppercase">Contract</h2>
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
