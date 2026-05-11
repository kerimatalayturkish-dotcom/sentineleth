interface RateEntry {
  count: number
  resetAt: number
}

const store = new Map<string, RateEntry>()

let callCount = 0
function cleanup() {
  callCount++
  if (callCount % 100 === 0) {
    const now = Date.now()
    for (const [key, entry] of store) {
      if (now > entry.resetAt) store.delete(key)
    }
  }
}

export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): { allowed: boolean; remaining: number; retryAfterMs: number } {
  cleanup()
  const now = Date.now()
  const entry = store.get(key)

  if (!entry || now > entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs })
    return { allowed: true, remaining: limit - 1, retryAfterMs: 0 }
  }

  if (entry.count >= limit) {
    return { allowed: false, remaining: 0, retryAfterMs: entry.resetAt - now }
  }

  entry.count++
  return { allowed: true, remaining: limit - entry.count, retryAfterMs: 0 }
}

/**
 * Extract the real client IP from a request.
 *
 * Priority order (most trustworthy first):
 *   1. `Render-Proxy-Forwarded-For`  — set by Render's edge, cannot be spoofed by client
 *   2. `CF-Connecting-IP`             — set by Cloudflare if we're behind it
 *   3. Last hop of `X-Forwarded-For`  — the last proxy in the chain appended this;
 *                                       we deliberately DO NOT trust the first hop
 *                                       (it's client-controlled and spoofable).
 *   4. `X-Real-IP`                    — generic fallback
 *
 * Returns "unknown" if none match.
 */
export function getClientIp(req: Request): string {
  // 1. Render's edge header — most trustworthy in our production deploy
  const renderFwd = req.headers.get("render-proxy-forwarded-for")
  if (renderFwd) return renderFwd.split(",")[0]!.trim()

  // 2. Cloudflare
  const cf = req.headers.get("cf-connecting-ip")
  if (cf) return cf.trim()

  // 3. Last hop of X-Forwarded-For. The client controls the first value,
  //    but each intermediate proxy APPENDS its own, so the LAST entry is
  //    the closest trusted proxy IP. This is the opposite of the naive
  //    "split(',')[0]" pattern.
  const xff = req.headers.get("x-forwarded-for")
  if (xff) {
    const parts = xff.split(",").map(s => s.trim()).filter(Boolean)
    if (parts.length > 0) return parts[parts.length - 1]!
  }

  // 4. Generic
  const xri = req.headers.get("x-real-ip")
  if (xri) return xri.trim()

  return "unknown"
}

export function rateLimitResponse(retryAfterMs: number) {
  return new Response(
    JSON.stringify({ error: "Too many requests. Please try again later." }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(Math.ceil(retryAfterMs / 1000)),
      },
    }
  )
}
