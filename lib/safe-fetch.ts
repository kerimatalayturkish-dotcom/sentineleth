/**
 * SSRF-safe fetcher for NFT tokenURI metadata.
 *
 * Defense in depth: although our server is the only authorised minter and
 * therefore controls every tokenURI it writes on-chain, we still validate
 * any URL we follow before the fetch. If the contract owner key is ever
 * compromised, or a future code path lets an external party pick a URI,
 * this prevents the server from probing internal hosts (file://, http://,
 * private RFC1918 ranges via DNS rebinding-resistant hosts) or from
 * hanging on a slow endpoint.
 *
 * Allowlist matches the CSP `connect-src` Irys gateways + Arweave.
 *
 * Hosts can be tightened per environment by setting `IRYS_GATEWAY_ALLOWLIST`
 * and `IRYS_GATEWAY_SUFFIX_ALLOWLIST` (comma-separated). Mainnet deploys
 * should drop `devnet.irys.xyz` to shrink the SSRF target surface.
 */

const DEFAULT_HOSTS = [
  "gateway.irys.xyz",
  "devnet.irys.xyz",
  "uploader.irys.xyz",
  "arweave.net",
] as const

const DEFAULT_HOST_SUFFIXES = [
  ".datasprite-cdn.com",
] as const

function parseList(env: string | undefined, fallback: readonly string[]): string[] {
  if (!env) return [...fallback]
  return env
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

const ALLOWED_HOSTS = new Set<string>(
  parseList(process.env.IRYS_GATEWAY_ALLOWLIST, DEFAULT_HOSTS),
)

// Suffix allowlist for hosts where Irys gateways 307-redirect for the
// actual blob payload. Only HTTPS subdomains are accepted.
const ALLOWED_HOST_SUFFIXES: readonly string[] = parseList(
  process.env.IRYS_GATEWAY_SUFFIX_ALLOWLIST,
  DEFAULT_HOST_SUFFIXES,
)

function hostIsAllowed(host: string): boolean {
  const h = host.toLowerCase()
  if (ALLOWED_HOSTS.has(h)) return true
  return ALLOWED_HOST_SUFFIXES.some((suffix) => h.endsWith(suffix))
}

const FETCH_TIMEOUT_MS = 5_000
const MAX_BYTES = 256 * 1024 // 256 KiB cap; metadata JSON is ~1 KiB in practice

export type TokenMetadata = {
  name?: string
  description?: string
  image?: string
  attributes?: Array<{ trait_type: string; value: string }>
  [k: string]: unknown
}

function isAllowedUrl(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.length === 0 || uri.length > 2048) return false
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return false
  }
  if (parsed.protocol !== "https:") return false
  return hostIsAllowed(parsed.hostname)
}

/**
 * Fetch + JSON-parse a tokenURI. Returns `null` on any failure (bad URL,
 * disallowed host, non-2xx, timeout, body too large, invalid JSON).
 * Never throws.
 */
export async function safeFetchTokenMetadata(
  uri: unknown,
  opts: { revalidate?: number } = {},
): Promise<TokenMetadata | null> {
  if (!isAllowedUrl(uri)) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const res = await fetch(uri, {
      signal: controller.signal,
      // Cache as the caller asks (defaults to 1h to match prior behaviour).
      next: { revalidate: opts.revalidate ?? 3600 },
      // Follow redirects, but defensively re-validate the final URL host
      // below. Irys gateways routinely 302-redirect between gateway.irys.xyz
      // and uploader.irys.xyz, so refusing redirects breaks metadata loads.
      redirect: "follow",
      headers: { Accept: "application/json" },
    })
    if (!res.ok) return null

    // Defense-in-depth: confirm the URL we ended up at is still allowlisted
    // (in case the redirect chain pointed off-allowlist).
    if (!isAllowedUrl(res.url)) return null

    // Cap response body size.
    const contentLength = Number(res.headers.get("content-length") || "0")
    if (contentLength && contentLength > MAX_BYTES) return null

    const text = await res.text()
    if (text.length > MAX_BYTES) return null

    try {
      return JSON.parse(text) as TokenMetadata
    } catch {
      return null
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
