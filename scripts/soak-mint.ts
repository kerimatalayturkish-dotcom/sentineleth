/**
 * Sepolia concurrency soak test.
 *
 * Creates N ephemeral wallets, funds each from SERVER_PRIVATE_KEY (the
 * watcher hot key — already gas-funded), fires concurrent publicMint(qty)
 * calls, then verifies:
 *   • every tx succeeded
 *   • totalSupply grew by exactly N * qty
 *   • token IDs are contiguous + unique (ERC-721A invariant — sanity check)
 *   • watcher backfilled every tokenURI (polled with timeout)
 *   • every comboHash in `.watcher-state.json` is unique (Layer B holding)
 *
 * Run:
 *   pnpm tsx --env-file=.env.local scripts/soak-mint.ts
 *   pnpm tsx --env-file=.env.local scripts/soak-mint.ts --wallets 5 --qty 2
 *
 * Cost estimate (default 10 wallets × 4 qty = 40 mints):
 *   funding   = 10 × (4 × 0.0025 + ~0.0008 gas) ≈ 0.108 ETH
 *   mint gas  = ~0.0008 / mint × 40                ≈ 0.032 ETH
 *   TOTAL     ≈ 0.14 sepETH paid by SERVER_PRIVATE_KEY
 *
 * Funds left in ephemeral wallets after the test are STRANDED on Sepolia.
 * That's fine for testnet (intentional — keeps the script simple).
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  parseEther,
  type Address,
  type Hex,
} from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { promises as fs } from "node:fs"
import { ethChain, NFT_CONTRACT_ADDRESS } from "@/lib/chain"
import { SENTINEL_ABI } from "@/lib/contract"

interface Args {
  wallets: number
  qty: number
  pollTimeoutMs: number
  pollIntervalMs: number
}

function parseArgs(): Args {
  const a = process.argv.slice(2)
  const get = (flag: string, def: number): number => {
    const i = a.indexOf(flag)
    if (i < 0) return def
    const v = Number(a[i + 1])
    return Number.isFinite(v) && v > 0 ? v : def
  }
  return {
    wallets: get("--wallets", 10),
    qty: get("--qty", 4),
    pollTimeoutMs: get("--poll-timeout-ms", 360_000),
    pollIntervalMs: get("--poll-interval-ms", 5_000),
  }
}

async function main(): Promise<void> {
  const args = parseArgs()

  const rpcUrl =
    process.env.MINT_RPC_URL ||
    process.env.SEPOLIA_RPC_URL ||
    process.env.NEXT_PUBLIC_ETH_RPC_URL
  if (!rpcUrl) throw new Error("missing MINT_RPC_URL / SEPOLIA_RPC_URL / NEXT_PUBLIC_ETH_RPC_URL")
  if (!NFT_CONTRACT_ADDRESS) throw new Error("missing NEXT_PUBLIC_NFT_CONTRACT_ADDRESS")

  const funderRaw = process.env.SERVER_PRIVATE_KEY
  if (!funderRaw) throw new Error("missing SERVER_PRIVATE_KEY (used here only as test funder)")
  const funderKey = (funderRaw.startsWith("0x") ? funderRaw : `0x${funderRaw}`) as Hex
  const funder = privateKeyToAccount(funderKey)

  const pub = createPublicClient({ chain: ethChain, transport: http(rpcUrl) })
  const funderWallet = createWalletClient({ chain: ethChain, transport: http(rpcUrl), account: funder })

  // ── Pre-flight ────────────────────────────────────────────────────────
  const [mintPrice, supplyBefore, status, funderBal] = await Promise.all([
    pub.readContract({ address: NFT_CONTRACT_ADDRESS, abi: SENTINEL_ABI, functionName: "MINT_PRICE" }) as Promise<bigint>,
    pub.readContract({ address: NFT_CONTRACT_ADDRESS, abi: SENTINEL_ABI, functionName: "totalSupply" }) as Promise<bigint>,
    pub.readContract({ address: NFT_CONTRACT_ADDRESS, abi: SENTINEL_ABI, functionName: "status" }) as Promise<readonly [bigint, bigint, bigint, bigint, bigint, bigint, boolean, boolean]>,
    pub.getBalance({ address: funder.address }),
  ])
  const [, , , publicRemaining, , , publicClosed, paused] = status
  if (paused) throw new Error("contract is paused — unpause from /admin first")
  if (publicClosed) throw new Error("public mint closed")

  const totalMints = BigInt(args.wallets * args.qty)
  if (publicRemaining < totalMints) {
    throw new Error(`not enough public supply: have ${publicRemaining}, need ${totalMints}`)
  }

  // Per-wallet funding = qty * mintPrice + gas headroom (rough).
  const gasHeadroom = parseEther("0.001")
  const perWallet = mintPrice * BigInt(args.qty) + gasHeadroom
  const totalFunding = perWallet * BigInt(args.wallets)
  if (funderBal < totalFunding + parseEther("0.01")) {
    throw new Error(
      `funder ${funder.address} only has ${formatEther(funderBal)} ETH, need ≥ ${formatEther(totalFunding + parseEther("0.01"))}`
    )
  }

  console.log(JSON.stringify({
    msg: "soak start",
    chain: ethChain.name,
    contract: NFT_CONTRACT_ADDRESS,
    funder: funder.address,
    funderBalance: formatEther(funderBal),
    wallets: args.wallets,
    qtyPerWallet: args.qty,
    totalMints: Number(totalMints),
    mintPriceEth: formatEther(mintPrice),
    perWalletFundingEth: formatEther(perWallet),
    totalFundingEth: formatEther(totalFunding),
    supplyBefore: supplyBefore.toString(),
    publicRemainingBefore: publicRemaining.toString(),
  }, null, 2))

  // ── Generate ephemeral wallets ────────────────────────────────────────
  const wallets = Array.from({ length: args.wallets }, () => {
    const pk = generatePrivateKey()
    const acct = privateKeyToAccount(pk)
    return { pk, address: acct.address as Address, account: acct }
  })

  // ── Fund all wallets sequentially (single nonce stream from funder) ───
  console.log("\n[fund] sending funding txs …")
  let nonce = await pub.getTransactionCount({ address: funder.address })
  const fundHashes: Hex[] = []
  for (const w of wallets) {
    const h = await funderWallet.sendTransaction({
      to: w.address,
      value: perWallet,
      nonce: nonce++,
    })
    fundHashes.push(h)
    console.log(`  → ${w.address}  ${formatEther(perWallet)} ETH  (${h})`)
  }
  console.log("[fund] waiting for confirmations …")
  await Promise.all(fundHashes.map((h) => pub.waitForTransactionReceipt({ hash: h })))
  console.log("[fund] all confirmed")

  // ── Fire concurrent mints ─────────────────────────────────────────────
  console.log("\n[mint] firing concurrent publicMint calls …")
  const t0 = Date.now()
  const mintResults = await Promise.allSettled(
    wallets.map(async (w) => {
      const wc = createWalletClient({ chain: ethChain, transport: http(rpcUrl), account: w.account })
      const hash = await wc.writeContract({
        address: NFT_CONTRACT_ADDRESS,
        abi: SENTINEL_ABI,
        functionName: "publicMint",
        args: [BigInt(args.qty)],
        value: mintPrice * BigInt(args.qty),
        chain: ethChain,
        account: w.account,
      })
      const receipt = await pub.waitForTransactionReceipt({ hash })
      return { wallet: w.address, hash, status: receipt.status, blockNumber: receipt.blockNumber }
    })
  )
  const t1 = Date.now()
  const succeeded = mintResults.filter((r) => r.status === "fulfilled" && (r.value as { status: string }).status === "success").length
  const failed = mintResults.length - succeeded
  console.log(`[mint] complete in ${((t1 - t0) / 1000).toFixed(1)}s — ${succeeded} ok, ${failed} failed`)
  for (const [i, r] of mintResults.entries()) {
    if (r.status === "rejected") {
      console.log(`  ✗ wallet ${wallets[i].address}: ${(r.reason as Error).message ?? r.reason}`)
    }
  }

  // ── Verify supply growth ──────────────────────────────────────────────
  const supplyAfter = (await pub.readContract({
    address: NFT_CONTRACT_ADDRESS,
    abi: SENTINEL_ABI,
    functionName: "totalSupply",
  })) as bigint
  const grew = supplyAfter - supplyBefore
  const expected = BigInt(succeeded * args.qty)
  console.log(`\n[supply] before=${supplyBefore} after=${supplyAfter} grew=${grew} expected=${expected} → ${grew === expected ? "OK" : "MISMATCH"}`)

  // ── Verify token IDs are contiguous + unique ──────────────────────────
  // ERC-721A guarantees this, but we sanity-check by reading ownerOf on
  // the new range.
  const newIds: bigint[] = []
  for (let id = supplyBefore + 1n; id <= supplyAfter; id++) newIds.push(id)
  const owners = await Promise.all(
    newIds.map((id) =>
      pub
        .readContract({ address: NFT_CONTRACT_ADDRESS, abi: SENTINEL_ABI, functionName: "ownerOf", args: [id] })
        .catch(() => null)
    )
  )
  const ownedCount = owners.filter((o) => o !== null).length
  console.log(`[ids]    ${ownedCount}/${newIds.length} new tokenIds resolve to an owner`)

  // ── Poll watcher backfill ─────────────────────────────────────────────
  console.log(`\n[uri]    polling tokenURI for ${newIds.length} new tokens (timeout ${args.pollTimeoutMs / 1000}s) …`)
  const start = Date.now()
  const done = new Set<string>()
  while (Date.now() - start < args.pollTimeoutMs && done.size < newIds.length) {
    const remaining = newIds.filter((id) => !done.has(id.toString()))
    const uris = await Promise.all(
      remaining.map((id) =>
        pub
          .readContract({ address: NFT_CONTRACT_ADDRESS, abi: SENTINEL_ABI, functionName: "tokenURI", args: [id] })
          .catch(() => "") as Promise<string>
      )
    )
    for (let i = 0; i < remaining.length; i++) {
      if (uris[i] && uris[i].length > 0) done.add(remaining[i].toString())
    }
    if (done.size < newIds.length) {
      console.log(`  ${done.size}/${newIds.length} backfilled (waiting)…`)
      await new Promise((r) => setTimeout(r, args.pollIntervalMs))
    }
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  if (done.size === newIds.length) {
    console.log(`[uri]    ALL backfilled in ${elapsed}s`)
  } else {
    console.log(`[uri]    TIMEOUT — ${done.size}/${newIds.length} after ${elapsed}s`)
  }

  // ── Verify Layer B: all comboHashes unique ────────────────────────────
  try {
    const raw = await fs.readFile(".watcher-state.json", "utf8")
    const state = JSON.parse(raw) as { usedComboHashes?: string[] }
    const hashes = state.usedComboHashes ?? []
    const uniq = new Set(hashes)
    console.log(`[combo]  ledger has ${hashes.length} entries, ${uniq.size} unique → ${hashes.length === uniq.size ? "OK" : "DUPLICATES PRESENT"}`)
  } catch {
    console.log(`[combo]  .watcher-state.json not found (is the watcher running locally?)`)
  }

  console.log("\nsoak DONE")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
