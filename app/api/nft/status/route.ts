import { NextRequest, NextResponse } from "next/server"
import { createPublicClient } from "viem"
import { ethChain, NFT_CONTRACT_ADDRESS, MINT_PRICE_DISPLAY, MINT_PRICE_CURRENCY, MAX_PER_WALLET, PUBLIC_CAP, AIRDROP_CAP, MAX_SUPPLY } from "@/lib/chain"
import { SENTINEL_ABI } from "@/lib/contract"
import { checkRateLimit, getClientIp, rateLimitResponse } from "@/lib/rate-limit"
import { serverHttp } from "@/lib/server-rpc"

const publicClient = createPublicClient({
  chain: ethChain,
  transport: serverHttp(),
})

/**
 * Public mint status endpoint.
 *
 * Reads SentinelETH `status()` (single multi-return view) plus the static
 * limits we ship alongside it. Designed to be safe for the homepage
 * supply counter and for the MCP server's `get_mint_status` tool.
 */
export async function GET(request: NextRequest) {
  const ip = getClientIp(request)
  const rl = checkRateLimit(`status:${ip}`, 30, 60_000)
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs)

  try {
    const [result, airdropRoot] = await Promise.all([
      publicClient.readContract({
        address: NFT_CONTRACT_ADDRESS,
        abi: SENTINEL_ABI,
        functionName: "status",
      }) as Promise<readonly [bigint, bigint, bigint, bigint, bigint, bigint, boolean, boolean, boolean]>,
      publicClient.readContract({
        address: NFT_CONTRACT_ADDRESS,
        abi: SENTINEL_ABI,
        functionName: "airdropRoot",
      }) as Promise<`0x${string}`>,
    ])

    const [
      totalSupply,
      publicMinted,
      airdropMinted,
      publicRemaining,
      airdropRemaining,
      mintPriceWei,
      publicClosed,
      airdropClosed,
      paused,
    ] = result
    // Airdrop is gated by an off-chain merkle root the owner posts via
    // setAirdropRoot. Until that's set, claimAirdrop() reverts with
    // AirdropRootNotSet — so we must NOT advertise airdrop_claim yet, even
    // if public is closed and airdrop cap is non-zero.
    const airdropRootSet =
      airdropRoot !== "0x0000000000000000000000000000000000000000000000000000000000000000"

    const totalSupplyN = Number(totalSupply)
    const publicMintedN = Number(publicMinted)
    const publicRemainingN = Number(publicRemaining)
    const airdropMintedN = Number(airdropMinted)
    const airdropRemainingN = Number(airdropRemaining)

    // ── Derived phase ─────────────────────────────────────────────────────
    // Single source of truth for "what can the user do right now?". Frontend
    // and MCP both consume this so they never disagree.
    //
    // Order matters: paused dominates everything; then check public; then
    // airdrop. `public_sold_out` is the brief window between public hitting
    // its cap (or being closed) and the airdrop merkle root being set.
    type Phase =
      | "paused"
      | "public_mint"
      | "public_sold_out"
      | "airdrop_claim"
      | "airdrop_closed"
      | "all_closed"

    let phase: Phase
    let canMintPublic = false
    let reasonIfNotMintable: string | null = null

    if (paused) {
      phase = "paused"
      reasonIfNotMintable = "Minting is paused by the admin."
    } else if (!publicClosed && publicRemainingN > 0) {
      phase = "public_mint"
      canMintPublic = true
    } else if (publicClosed && airdropClosed) {
      phase = "all_closed"
      reasonIfNotMintable = "Both public mint and airdrop are permanently closed."
    } else if (!airdropClosed && airdropRemainingN > 0 && airdropRootSet) {
      // Public is exhausted/closed; airdrop is the active path.
      phase = "airdrop_claim"
      reasonIfNotMintable = "Public mint is sold out. Airdrop claim is open for eligible wallets."
    } else if (publicClosed || publicRemainingN === 0) {
      phase = "public_sold_out"
      reasonIfNotMintable = airdropRemainingN > 0 && !airdropRootSet
        ? "Public mint is sold out. Airdrop claim opens once the allowlist is published."
        : "Public mint is sold out. Airdrop claim has not opened yet."
    } else {
      phase = "all_closed"
      reasonIfNotMintable = "Minting is currently unavailable."
    }

    // Friendly label for UI badges.
    const phaseLabel = (
      {
        paused: "Paused",
        public_mint: "Public Mint",
        public_sold_out: "Public Sold Out",
        airdrop_claim: "Airdrop Claim",
        airdrop_closed: "Airdrop Closed",
        all_closed: "Closed",
      } as const
    )[phase]

    // Scarcity flag — used by MCP to nudge users when supply is low.
    // Threshold is intentionally generous (100) so Claude can prompt early
    // even if the user is still chatting, not yet broadcasting.
    const lowSupplyThreshold = 100
    const lowSupplyWarning =
      phase === "public_mint" && publicRemainingN > 0 && publicRemainingN <= lowSupplyThreshold
        ? `Only ${publicRemainingN} public mint${publicRemainingN === 1 ? "" : "s"} remaining — submit your transaction soon to avoid sending ETH after the cap is hit.`
        : null

    return NextResponse.json({
      // ── Phase (new, derived) ────────────────────────────────────────────
      phase,
      phaseLabel,
      canMintPublic,
      reasonIfNotMintable,
      lowSupplyThreshold,
      lowSupplyWarning,

      // ── Raw on-chain state ──────────────────────────────────────────────
      totalSupply: totalSupplyN,
      maxSupply: MAX_SUPPLY,
      publicMinted: publicMintedN,
      publicRemaining: publicRemainingN,
      airdropMinted: airdropMintedN,
      airdropRemaining: airdropRemainingN,
      mintPrice: MINT_PRICE_DISPLAY,
      mintPriceWei: mintPriceWei.toString(),
      currency: MINT_PRICE_CURRENCY,
      paused,
      publicClosed,
      airdropClosed,
      airdropRootSet,
      limits: {
        maxPerWallet: MAX_PER_WALLET,
        publicCap: PUBLIC_CAP,
        airdropCap: AIRDROP_CAP,
      },
      contract: NFT_CONTRACT_ADDRESS,
      chainId: ethChain.id,
    }, {
      // Edge-cache aggressively: the homepage MintPhaseStatus polls every
      // 30s per visitor, so 10s shared-cache + SWR keeps origin RPC load
      // flat regardless of concurrent users while still letting a phase
      // flip propagate within ~10s.
      headers: {
        "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30",
      },
    })
  } catch (err) {
    console.error("status fetch failed:", err)
    return NextResponse.json({ error: "Failed to fetch status" }, { status: 500 })
  }
}
