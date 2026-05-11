import { http } from "viem"

/**
 * Returns the RPC URL for SERVER-SIDE viem clients (Ethereum mainnet / Sepolia).
 *
 * Order of preference:
 *   1. MINT_RPC_URL (private hot-path endpoint, e.g. Alchemy)
 *   2. SEPOLIA_RPC_URL / MAINNET_RPC_URL (server-only)
 *   3. NEXT_PUBLIC_ETH_RPC_URL (public, embedded in HTML)
 *
 * Public RPCs rate-limit aggressively under load. Use a private endpoint in
 * MINT_RPC_URL for the relayer/MCP hot path.
 */
export function getServerRpcUrl(): string {
  const url =
    process.env.MINT_RPC_URL ||
    process.env.SEPOLIA_RPC_URL ||
    process.env.MAINNET_RPC_URL ||
    process.env.NEXT_PUBLIC_ETH_RPC_URL
  if (!url) {
    throw new Error(
      "No server RPC URL configured (MINT_RPC_URL / SEPOLIA_RPC_URL / MAINNET_RPC_URL / NEXT_PUBLIC_ETH_RPC_URL)",
    )
  }
  return url
}

/**
 * viem http transport for server-side clients with retry+backoff on
 * transient errors (rate limits, network blips).
 */
export function serverHttp() {
  return http(getServerRpcUrl(), {
    retryCount: 4,
    retryDelay: 150,
    timeout: 30_000,
  })
}
