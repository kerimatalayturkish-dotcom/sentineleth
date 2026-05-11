import { SignJWT, jwtVerify } from "jose"
import { createHash, timingSafeEqual } from "crypto"
import { cookies } from "next/headers"
import { getOptionalServerEnv } from "@/lib/env"
import { checkRateLimit, getClientIp, rateLimitResponse } from "@/lib/rate-limit"

export const ADMIN_COOKIE = "admin_session"
const JWT_ALG = "HS256"
const JWT_ISS = "sentineleth-admin"
const JWT_TTL = "8h"

function getSecret(): Uint8Array {
  const env = getOptionalServerEnv()
  if (!env.jwtSecret) {
    throw new Error("JWT_SECRET not configured")
  }
  if (env.jwtSecret.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 characters")
  }
  return new TextEncoder().encode(env.jwtSecret)
}

/**
 * Constant-time string compare by hashing both sides to fixed-length digests
 * first. Avoids leaking length or prefix information about the configured
 * username via request timing.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest()
  const hb = createHash("sha256").update(b).digest()
  return timingSafeEqual(ha, hb)
}

/**
 * Constant-time compare of the submitted password against the configured
 * ADMIN_PASSWORD env var. Both sides are sha256-hashed first so the
 * comparison length is fixed and timingSafeEqual works regardless of input
 * length, and so the configured password length isn't leaked via timing.
 */
export function verifyAdminPassword(
  submitted: string,
  configured: string,
): boolean {
  if (typeof submitted !== "string" || typeof configured !== "string") return false
  return constantTimeEqual(submitted, configured)
}

/** Sign a short-lived admin session JWT. */
export async function signAdminJwt(subject: string): Promise<string> {
  return new SignJWT({ sub: subject })
    .setProtectedHeader({ alg: JWT_ALG })
    .setIssuer(JWT_ISS)
    .setIssuedAt()
    .setExpirationTime(JWT_TTL)
    .sign(getSecret())
}

/**
 * Verify an admin JWT. Resolves to the subject on success, or null if the
 * token is missing/expired/tampered/wrong issuer/alg.
 */
export async function verifyAdminJwt(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      issuer: JWT_ISS,
      algorithms: [JWT_ALG],
    })
    return typeof payload.sub === "string" ? payload.sub : null
  } catch {
    return null
  }
}

/**
 * Read the admin session cookie and verify the JWT inside it.
 * Returns the subject (admin username) if authed, else null.
 * Call from any admin-only route handler.
 */
export async function requireAdmin(): Promise<string | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(ADMIN_COOKIE)?.value
  if (!token) return null
  return verifyAdminJwt(token)
}

/**
 * Authenticate + rate-limit an admin write request in one step.
 *
 * Returns either:
 *   - { admin: <subject> } on success — proceed with the action
 *   - a Response with status 401/429 — return it directly from the handler
 *
 * Rate limit defaults: 30 admin write actions per minute per session+IP.
 * Each on-chain action costs gas, so this is meaningful even for an
 * authenticated user (e.g. if their session cookie were stolen and the
 * attacker tried to spam `closeMint` / `withdraw` etc.).
 *
 * The bucket key combines the JWT subject AND the client IP so a single
 * stolen cookie used from a new IP gets its own (independent) bucket
 * rather than draining the legitimate operator's allowance.
 */
export async function requireAdminWithRateLimit(
  request: Request,
  opts: { limit?: number; windowMs?: number; bucket?: string } = {},
): Promise<{ admin: string } | Response> {
  const subject = await requireAdmin()
  if (!subject) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })
  }

  const limit = opts.limit ?? 30
  const windowMs = opts.windowMs ?? 60_000
  const bucket = opts.bucket ?? "admin-action"
  const ip = getClientIp(request)
  const rl = checkRateLimit(`${bucket}:${subject}:${ip}`, limit, windowMs)
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs)

  return { admin: subject }
}
