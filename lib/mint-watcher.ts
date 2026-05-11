/**
 * Mint watcher — backfills tokenURIs after PublicMint events.
 *
 * Hardened (Phase C2) features:
 *   - Reorg safety: waits N confirmations before processing an event.
 *   - Persistent state on disk: last processed block + processed event keys
 *     (so restarts don't reprocess and don't miss events while down).
 *   - Bounded sequential processing (one event at a time, in order).
 *   - Retry with exponential backoff for transient RPC / Irys errors.
 *   - Idempotent: re-checks tokenURI on chain before uploading; treats
 *     contract `UriAlreadySet` revert as a no-op (someone else won the race).
 *   - Optional health HTTP endpoint (WATCHER_HEALTH_PORT) returning JSON
 *     stats so Render / uptime monitors can detect stalls.
 *   - Structured JSON logs (one event per line, machine-grep'able).
 *
 * Run with: `pnpm watcher` (uses node --env-file=.env.local + tsx).
 */

import { promises as fs } from "node:fs"
import { dirname } from "node:path"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import {
  createPublicClient,
  createWalletClient,
  http,
  webSocket,
  parseAbiItem,
  keccak256,
  toBytes,
  decodeErrorResult,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { ethChain, NFT_CONTRACT_ADDRESS } from "@/lib/chain"
import { SENTINEL_ABI } from "@/lib/contract"
import { getServerEnv } from "@/lib/env"
import { composeImage } from "@/lib/compose"
import {
  comboHash,
  getTraitAttributes,
  seedForToken,
  selectionFromSeed,
  type TraitSelection,
} from "@/lib/traits"
import { uploadImage, uploadMetadata } from "@/lib/irys"

// ─── Config defaults (overridable via env) ───────────────────────────────
const DEFAULT_CONFIRMATIONS = 2
const DEFAULT_POLLING_MS    = 4_000
const DEFAULT_STATE_FILE    = ".watcher-state.json"
const DEFAULT_HEALTH_PORT   = 0 // 0 = disabled
const MAX_PROCESSED_KEYS    = 5_000 // bound state-file growth
const MAX_RETRIES           = 5
const RETRY_BASE_MS         = 1_500

// Layer-B uniqueness: how many seed perturbations we'll try before
// giving up and accepting a duplicate combo. With ~360M possible combos
// and 10K mints, the probability of needing > 4 attempts on any single
// token is < 1 in 10^15, so 32 is wildly defensive.
const MAX_COMBO_RETRIES     = 32
// Cap how many combo hashes we retain on disk. 12K leaves headroom over
// MAX_SUPPLY (10K) so the cap is never hit during a normal launch.
const MAX_COMBO_HASHES      = 12_000

// Display-name padding width — `Sentinel #00001` … `#10000`.
const NAME_PAD_WIDTH        = 5

const PUBLIC_MINT_EVENT = parseAbiItem(
  "event PublicMint(address indexed to, uint256 indexed startTokenId, uint256 qty, uint256 paid)"
)

// ─── Structured logging ──────────────────────────────────────────────────
type LogLevel = "info" | "warn" | "error"
function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields })
  if (level === "error") console.error(line)
  else console.log(line)
}

// ─── Persistent state ────────────────────────────────────────────────────
interface WatcherState {
  lastProcessedBlock: string // bigint as decimal string
  processedKeys: string[]    // FIFO queue, bounded by MAX_PROCESSED_KEYS
  // Layer-B uniqueness ledger: every comboHash we've ever committed to
  // chain. New mints reroll until their combo isn't in this set.
  // Bounded at MAX_COMBO_HASHES to keep the state file small.
  usedComboHashes?: string[]
}

class StateStore {
  private cache: WatcherState
  // In-memory Set mirror of usedComboHashes for O(1) lookup.
  private usedSet: Set<string>
  private writePending: Promise<void> = Promise.resolve()

  constructor(private readonly path: string, initial: WatcherState) {
    this.cache = initial
    this.usedSet = new Set(initial.usedComboHashes ?? [])
  }

  static async load(path: string): Promise<StateStore> {
    try {
      const raw = await fs.readFile(path, "utf8")
      const parsed = JSON.parse(raw) as WatcherState
      return new StateStore(path, {
        lastProcessedBlock: parsed.lastProcessedBlock ?? "0",
        processedKeys: Array.isArray(parsed.processedKeys) ? parsed.processedKeys.slice(-MAX_PROCESSED_KEYS) : [],
        usedComboHashes: Array.isArray(parsed.usedComboHashes) ? parsed.usedComboHashes.slice(-MAX_COMBO_HASHES) : [],
      })
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException
      if (e.code !== "ENOENT") {
        log("warn", "state file unreadable, starting fresh", { path, error: e.message })
      }
      return new StateStore(path, { lastProcessedBlock: "0", processedKeys: [], usedComboHashes: [] })
    }
  }

  hasProcessed(key: string): boolean {
    return this.cache.processedKeys.includes(key)
  }

  markProcessed(key: string): void {
    if (this.cache.processedKeys.includes(key)) return
    this.cache.processedKeys.push(key)
    if (this.cache.processedKeys.length > MAX_PROCESSED_KEYS) {
      this.cache.processedKeys.splice(0, this.cache.processedKeys.length - MAX_PROCESSED_KEYS)
    }
  }

  /** Layer-B: has this exact trait combo already been committed? */
  isComboUsed(hash: string): boolean {
    return this.usedSet.has(hash)
  }

  /** Layer-B: record a combo hash. Idempotent. */
  markComboUsed(hash: string): void {
    if (this.usedSet.has(hash)) return
    this.usedSet.add(hash)
    const arr = this.cache.usedComboHashes ?? (this.cache.usedComboHashes = [])
    arr.push(hash)
    if (arr.length > MAX_COMBO_HASHES) {
      arr.splice(0, arr.length - MAX_COMBO_HASHES)
    }
  }

  comboCount(): number {
    return this.usedSet.size
  }

  getLastProcessedBlock(): bigint {
    return BigInt(this.cache.lastProcessedBlock || "0")
  }

  setLastProcessedBlock(b: bigint): void {
    if (b > this.getLastProcessedBlock()) this.cache.lastProcessedBlock = b.toString()
  }

  /** Atomic-ish write: serialize, write to .tmp, rename. */
  async flush(): Promise<void> {
    // Chain to avoid concurrent writes corrupting the file.
    this.writePending = this.writePending.then(async () => {
      await fs.mkdir(dirname(this.path), { recursive: true }).catch(() => {})
      const tmp = `${this.path}.tmp`
      await fs.writeFile(tmp, JSON.stringify(this.cache), "utf8")
      await fs.rename(tmp, this.path)
    })
    return this.writePending
  }
}

// ─── Health endpoint ─────────────────────────────────────────────────────
interface Stats {
  startedAt: string
  lastEventAt: string | null
  lastSuccessAt: string | null
  lastErrorAt: string | null
  lastErrorMessage: string | null
  eventsSeen: number
  eventsProcessed: number
  eventsSkipped: number
  eventsFailed: number
  inFlight: number
  lastProcessedBlock: string
}

function startHealthServer(port: number, stats: Stats): void {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/healthz" || req.url === "/") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true, ...stats }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  server.listen(port, () => log("info", "health server listening", { port }))
}

// ─── Retry helper ────────────────────────────────────────────────────────
async function withRetry<T>(label: string, fn: () => Promise<T>, retries = MAX_RETRIES): Promise<T> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const delay = RETRY_BASE_MS * 2 ** (attempt - 1)
      log("warn", "retry", { label, attempt, delayMs: delay, error: errMsg(err) })
      await sleep(delay)
    }
  }
  throw lastErr
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Detect the contract's UriAlreadySet revert from a viem error chain. */
function isUriAlreadySetRevert(err: unknown): boolean {
  const msg = errMsg(err)
  if (msg.includes("UriAlreadySet")) return true
  // Try to decode raw revert data if present.
  // viem ContractFunctionRevertedError exposes `data`.
  const data = (err as { data?: { errorName?: string } } | undefined)?.data
  if (data?.errorName === "UriAlreadySet") return true
  return false
}

// ─── Watcher entry point ─────────────────────────────────────────────────
export interface WatcherOptions {
  fromBlock?: bigint
  pollingInterval?: number
  confirmations?: number
  stateFile?: string
  healthPort?: number
}

export async function runMintWatcher(opts: WatcherOptions = {}): Promise<void> {
  const env = getServerEnv()
  const rawKey = env.serverPrivateKey
  const watcherKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as `0x${string}`
  const watcherAccount = privateKeyToAccount(watcherKey)

  const wsUrl   = process.env.NEXT_PUBLIC_ETH_WS_URL
  const httpUrl = process.env.MINT_RPC_URL || process.env.NEXT_PUBLIC_ETH_RPC_URL
  if (!httpUrl) throw new Error("watcher: missing MINT_RPC_URL or NEXT_PUBLIC_ETH_RPC_URL")
  if (!NFT_CONTRACT_ADDRESS) throw new Error("watcher: missing NEXT_PUBLIC_NFT_CONTRACT_ADDRESS")

  const confirmations  = opts.confirmations  ?? Number(process.env.WATCHER_CONFIRMATIONS ?? DEFAULT_CONFIRMATIONS)
  const pollingMs      = opts.pollingInterval ?? Number(process.env.WATCHER_POLLING_MS ?? DEFAULT_POLLING_MS)
  const stateFile      = opts.stateFile      ?? process.env.WATCHER_STATE_FILE ?? DEFAULT_STATE_FILE
  const healthPort     = opts.healthPort     ?? Number(process.env.WATCHER_HEALTH_PORT ?? DEFAULT_HEALTH_PORT)

  // We deliberately use HTTP polling (not WS) for the live event subscription.
  // Some public WS providers (notably publicnode) expire `eth_newFilter`
  // sessions between polls, causing viem's watchEvent to spin in an error
  // loop and miss real events. HTTP `eth_getLogs` polling every `pollingMs`
  // is slower but rock-solid. WS env stays available for other consumers.
  void wsUrl
  const transport    = http(httpUrl)
  const publicClient = createPublicClient({ chain: ethChain, transport })
  const walletClient = createWalletClient({ chain: ethChain, transport: http(httpUrl), account: watcherAccount })

  // Preflight: confirm we are the configured `minter` (only address allowed
  // to call setTokenURIs in the Ownable-based contract).
  const onChainMinter = (await publicClient.readContract({
    address: NFT_CONTRACT_ADDRESS,
    abi: SENTINEL_ABI,
    functionName: "minter",
  })) as Address
  if (onChainMinter.toLowerCase() !== watcherAccount.address.toLowerCase()) {
    throw new Error(
      `watcher: SERVER_PRIVATE_KEY (${watcherAccount.address}) is NOT the configured minter on ${NFT_CONTRACT_ADDRESS}. ` +
        `Current minter is ${onChainMinter}. From the owner key, call setMinter(${watcherAccount.address}) first.`
    )
  }

  const state = await StateStore.load(stateFile)
  const startBlock = opts.fromBlock ?? (state.getLastProcessedBlock() > 0n ? state.getLastProcessedBlock() + 1n : undefined)

  const stats: Stats = {
    startedAt: new Date().toISOString(),
    lastEventAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastErrorMessage: null,
    eventsSeen: 0,
    eventsProcessed: 0,
    eventsSkipped: 0,
    eventsFailed: 0,
    inFlight: 0,
    lastProcessedBlock: state.getLastProcessedBlock().toString(),
  }

  if (healthPort > 0) startHealthServer(healthPort, stats)

  log("info", "watcher start", {
    contract: NFT_CONTRACT_ADDRESS,
    chain: ethChain.name,
    chainId: ethChain.id,
    watcher: watcherAccount.address,
    transport: "http-polling",
    confirmations,
    pollingMs,
    stateFile,
    healthPort: healthPort > 0 ? healthPort : "disabled",
    fromBlock: startBlock?.toString() ?? "latest",
  })

  // Sequential queue keyed by tx+startTokenId; we process in arrival order.
  const queue: Array<{
    key: string
    to: Address
    startTokenId: bigint
    qty: number
    txHash: Hex | null
    blockNumber: bigint
  }> = []
  let draining = false

  async function drain(): Promise<void> {
    if (draining) return
    draining = true
    try {
      while (queue.length > 0) {
        const item = queue[0]
        // Reorg safety: only process events whose block is `confirmations` deep.
        const head = await withRetry("getBlockNumber", () => publicClient.getBlockNumber())
        const depth = head - item.blockNumber
        if (depth < BigInt(confirmations)) {
          log("info", "waiting for confirmations", {
            startTokenId: item.startTokenId.toString(),
            block: item.blockNumber.toString(),
            head: head.toString(),
            need: confirmations,
            haveDepth: depth.toString(),
          })
          await sleep(pollingMs)
          continue
        }

        stats.inFlight = 1
        try {
          await handleMint({
            publicClient,
            walletClient,
            state,
            to: item.to,
            startTokenId: item.startTokenId,
            qty: item.qty,
            txHash: item.txHash,
            blockNumber: item.blockNumber,
            onSkip: () => { stats.eventsSkipped++ },
          })
          stats.eventsProcessed++
          stats.lastSuccessAt = new Date().toISOString()
        } catch (err) {
          stats.eventsFailed++
          stats.lastErrorAt = new Date().toISOString()
          stats.lastErrorMessage = errMsg(err)
          log("error", "handle FAILED", {
            startTokenId: item.startTokenId.toString(),
            tx: item.txHash,
            error: errMsg(err),
          })
        } finally {
          stats.inFlight = 0
        }

        // Mark processed regardless of outcome — failures are logged + alertable
        // via /healthz; we don't want a poison event to block the whole queue.
        state.markProcessed(item.key)
        state.setLastProcessedBlock(item.blockNumber)
        stats.lastProcessedBlock = state.getLastProcessedBlock().toString()
        await state.flush()
        queue.shift()
      }
    } finally {
      draining = false
    }
  }

  // Helper: enqueue a log if not already processed.
  function enqueueLog(lg: { args: { startTokenId?: bigint; qty?: bigint; to?: Address }; transactionHash: Hex | null; blockNumber: bigint | null }, source: string): void {
    const { startTokenId, qty, to } = lg.args
    if (startTokenId === undefined || qty === undefined || to === undefined) return
    const key = `${lg.transactionHash}:${startTokenId.toString()}`
    stats.eventsSeen++
    stats.lastEventAt = new Date().toISOString()
    if (state.hasProcessed(key)) {
      stats.eventsSkipped++
      return
    }
    if (queue.some((q) => q.key === key)) return
    queue.push({
      key,
      to,
      startTokenId,
      qty: Number(qty),
      txHash: lg.transactionHash,
      blockNumber: lg.blockNumber ?? 0n,
    })
    log("info", "event enqueued", {
      source,
      to,
      startTokenId: startTokenId.toString(),
      qty: qty.toString(),
      tx: lg.transactionHash,
      block: lg.blockNumber?.toString(),
      queueDepth: queue.length,
    })
  }

  // ── Startup catch-up ──────────────────────────────────────────────────
  // Even if the live subscription is healthy, the *first* poll only sees
  // logs from `fromBlock` forward — but providers vary in how far back they
  // honour `fromBlock` on a subscription. To guarantee we replay every event
  // missed during downtime, do an explicit `getLogs` from the persisted
  // `startBlock` up to the current head before installing the subscription.
  if (startBlock !== undefined) {
    try {
      const head = await withRetry("getBlockNumber/catchup", () => publicClient.getBlockNumber())
      if (head >= startBlock) {
        const chunkSize = 9_000n // stay well under typical 10k getLogs caps
        let cursor = startBlock
        let totalLogs = 0
        while (cursor <= head) {
          const toBlock = cursor + chunkSize - 1n > head ? head : cursor + chunkSize - 1n
          const chunkLogs = await withRetry("getLogs/catchup", () =>
            publicClient.getLogs({
              address: NFT_CONTRACT_ADDRESS,
              event: PUBLIC_MINT_EVENT,
              fromBlock: cursor,
              toBlock,
            })
          )
          for (const lg of chunkLogs) enqueueLog(lg as never, "catchup")
          totalLogs += chunkLogs.length
          cursor = toBlock + 1n
        }
        log("info", "catchup complete", {
          fromBlock: startBlock.toString(),
          toBlock: head.toString(),
          logsFound: totalLogs,
          enqueued: queue.length,
        })
        if (queue.length > 0) void drain()
      }
    } catch (err) {
      // Don't crash the watcher if catch-up fails — the live subscription
      // will still pick up new events; we just may miss old ones, which the
      // operator can replay manually by deleting state.
      log("error", "catchup FAILED", { error: errMsg(err) })
    }
  }

  // ── Live polling loop ─────────────────────────────────────────────────
  // We deliberately do NOT use viem's `watchEvent` here. Many public RPC
  // endpoints (publicnode in particular, on both HTTP and WS) reject the
  // `eth_newFilter` / `eth_getFilterChanges` polling viem uses internally,
  // so events go undelivered. Our own `getLogs(fromBlock, toBlock)` poll
  // is slightly chattier but works on every standard EL RPC.
  let lastPolledBlock = startBlock !== undefined
    ? (queue.length > 0 ? queue[queue.length - 1].blockNumber : startBlock - 1n)
    : await withRetry("getBlockNumber/init", () => publicClient.getBlockNumber())
  let stopped = false
  void (async () => {
    while (!stopped) {
      try {
        const head = await withRetry("getBlockNumber/poll", () => publicClient.getBlockNumber())
        if (head > lastPolledBlock) {
          const fromBlock = lastPolledBlock + 1n
          const chunkSize = 9_000n
          let cursor = fromBlock
          while (cursor <= head) {
            const toBlock = cursor + chunkSize - 1n > head ? head : cursor + chunkSize - 1n
            const logs = await withRetry("getLogs/poll", () =>
              publicClient.getLogs({
                address: NFT_CONTRACT_ADDRESS,
                event: PUBLIC_MINT_EVENT,
                fromBlock: cursor,
                toBlock,
              })
            )
            for (const lg of logs) enqueueLog(lg as never, "live")
            cursor = toBlock + 1n
          }
          lastPolledBlock = head
          if (queue.length > 0) void drain()
        }
      } catch (err) {
        stats.lastErrorAt = new Date().toISOString()
        stats.lastErrorMessage = errMsg(err)
        log("error", "poll FAILED (will retry)", { error: errMsg(err) })
      }
      await sleep(pollingMs)
    }
  })()
  function unwatch(): void { stopped = true }

  process.on("SIGINT",  () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))
  function shutdown(sig: string): void {
    log("info", "shutdown", { signal: sig })
    unwatch()
    void state.flush().finally(() => process.exit(0))
  }

  // Periodic drain loop in case events aren't flowing but we still have queue
  // items waiting on confirmations.
  setInterval(() => { void drain() }, pollingMs).unref()

  await new Promise(() => {}) // run forever
}

interface HandleArgs {
  publicClient: PublicClient
  walletClient: WalletClient
  state: StateStore
  to: Address
  startTokenId: bigint
  qty: number
  txHash: Hex | null
  blockNumber: bigint
  onSkip: () => void
}

async function handleMint(args: HandleArgs): Promise<void> {
  const { publicClient, walletClient, state, startTokenId, qty, txHash, onSkip } = args
  log("info", "handle start", { startTokenId: startTokenId.toString(), qty, tx: txHash })

  // Pre-check: if first token already has a URI, skip the whole batch.
  try {
    const existing = (await withRetry("readTokenURI", () =>
      publicClient.readContract({
        address: NFT_CONTRACT_ADDRESS,
        abi: SENTINEL_ABI,
        functionName: "tokenURI",
        args: [startTokenId],
      })
    )) as string
    if (existing && existing.length > 0) {
      log("info", "skip — URI already set", { startTokenId: startTokenId.toString() })
      onSkip()
      return
    }
  } catch (err) {
    // If tokenURI reverts (nonexistent), event was for a token that no
    // longer exists (reorg or burn). Treat as skip.
    log("warn", "tokenURI read reverted, skipping", {
      startTokenId: startTokenId.toString(),
      error: errMsg(err),
    })
    onSkip()
    return
  }

  // ── Layer A + B: derive deterministic + UNIQUE traits per token ──
  // Pre-compute every selection in this batch (and tentatively mark
  // their combo hashes used) BEFORE uploading. That way a later token in
  // the same batch sees the previous token's combo as taken and can't
  // collide with it. If anything fails after this point the marks get
  // persisted anyway by the outer drain() loop — acceptable because a
  // re-run with the same seed produces the same combo and the tokenURI
  // guard above turns the second attempt into a no-op.
  const compositions: Array<{ tokenId: bigint; selection: TraitSelection; comboHashHex: string; attempt: number }> = []
  for (let i = 0; i < qty; i++) {
    const tokenId = startTokenId + BigInt(i)
    const seed = seedForToken(NFT_CONTRACT_ADDRESS, tokenId, ethChain.id)
    let selection: TraitSelection | null = null
    let chosenAttempt = 0
    let chosenHash = ""
    for (let attempt = 0; attempt < MAX_COMBO_RETRIES; attempt++) {
      const sel = selectionFromSeed(seed, attempt)
      const hash = comboHash(sel)
      if (!state.isComboUsed(hash)) {
        selection = sel
        chosenAttempt = attempt
        chosenHash = hash
        break
      }
      log("info", "combo collision, rerolling", {
        tokenId: tokenId.toString(),
        attempt,
        comboHash: hash,
      })
    }
    if (!selection) {
      // Statistically impossible at our combo space (~360M) for a 10K
      // collection. If it ever happens, fall back to the last-tried
      // selection and log loudly. Better duplicate art than no art.
      const sel = selectionFromSeed(seed, MAX_COMBO_RETRIES - 1)
      selection = sel
      chosenAttempt = MAX_COMBO_RETRIES - 1
      chosenHash = comboHash(sel)
      log("error", "combo retries exhausted, accepting duplicate", {
        tokenId: tokenId.toString(),
        attempts: MAX_COMBO_RETRIES,
        comboHash: chosenHash,
      })
    }
    state.markComboUsed(chosenHash)
    compositions.push({ tokenId, selection, comboHashHex: chosenHash, attempt: chosenAttempt })
  }

  // Compose + upload using the chosen selections.
  const uris: string[] = []
  for (const { tokenId, selection, attempt, comboHashHex } of compositions) {
    const png = await withRetry(`compose#${tokenId}`, () => composeImage(selection))
    const img = await withRetry(`uploadImage#${tokenId}`, () => uploadImage(png))
    // Display name: zero-padded so the collection sorts lexicographically
    // (`#00001` < `#00002` < … < `#10000`).
    const paddedId = tokenId.toString().padStart(NAME_PAD_WIDTH, "0")
    const meta = await withRetry(`uploadMeta#${tokenId}`, () =>
      uploadMetadata({
        name: `SentinelETH #${paddedId}`,
        description:
          "SentinelETH — a 10,000-piece on-chain ERC-721A collection. Minted via Claude.ai through the SentinelETH MCP.",
        image: img.url,
        external_url: process.env.NEXT_PUBLIC_APP_URL || "https://sentineleth.xyz",
        attributes: getTraitAttributes(selection),
      })
    )
    uris.push(meta.url)
    log("info", "uri composed", {
      tokenId: tokenId.toString(),
      uri: meta.url,
      comboHash: comboHashHex,
      seedAttempt: attempt,
    })
  }

  // Write back. Treat UriAlreadySet as success (race won by another caller).
  try {
    const hash = await withRetry("setTokenURIs", () =>
      walletClient.writeContract({
        address: NFT_CONTRACT_ADDRESS,
        abi: SENTINEL_ABI,
        functionName: "setTokenURIs",
        args: [startTokenId, uris],
        chain: ethChain,
        account: walletClient.account!,
      })
    )
    log("info", "setTokenURIs sent", { startTokenId: startTokenId.toString(), tx: hash })
    const receipt = await withRetry("waitTx", () => publicClient.waitForTransactionReceipt({ hash }))
    log("info", "setTokenURIs confirmed", {
      startTokenId: startTokenId.toString(),
      tx: hash,
      block: receipt.blockNumber.toString(),
      status: receipt.status,
    })
    if (receipt.status !== "success") {
      throw new Error(`tx reverted: ${hash}`)
    }
  } catch (err) {
    if (isUriAlreadySetRevert(err)) {
      log("info", "setTokenURIs no-op (UriAlreadySet)", { startTokenId: startTokenId.toString() })
      onSkip()
      return
    }
    throw err
  }
}

// Suppress unused-import warning for decodeErrorResult in some viem versions.
void decodeErrorResult
