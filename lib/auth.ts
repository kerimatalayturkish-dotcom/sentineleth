import argon2 from "argon2"
import { SignJWT, jwtVerify } from "jose"
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto"
import { cookies } from "next/headers"
import { getOptionalServerEnv } from "@/lib/env"
import { checkRateLimit, getClientIp, rateLimitResponse } from "@/lib/rate-limit"

export const ADMIN_COOKIE = "admin_session"
export const ADMIN_PENDING_2FA_COOKIE = "admin_pending_2fa"
const JWT_ALG = "HS256"
const JWT_ISS = "sentineleth-admin"
const JWT_PENDING_2FA_ISS = "sentineleth-admin-pending-2fa"
const JWT_TTL = "8h"
const JWT_PENDING_2FA_TTL = "5m"
const TOTP_PERIOD_SECONDS = 30
const TOTP_WINDOW = 1
const TOTP_DIGITS = 6
const TOTP_BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

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
 * Verify the submitted password against either ADMIN_PASSWORD_HASH (preferred)
 * or the legacy plaintext ADMIN_PASSWORD fallback.
 */
export async function verifyAdminPassword(
  submitted: string,
  configured: { hash?: string; plaintext?: string },
): Promise<boolean> {
  if (typeof submitted !== "string") return false

  if (configured.hash) {
    try {
      return await argon2.verify(configured.hash, submitted)
    } catch {
      return false
    }
  }

  if (typeof configured.plaintext !== "string") return false
  return constantTimeEqual(submitted, configured.plaintext)
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

/** Sign the short-lived cookie used between password and TOTP verification. */
export async function signPendingAdminTotpJwt(subject: string): Promise<string> {
  return new SignJWT({ sub: subject, step: "totp" })
    .setProtectedHeader({ alg: JWT_ALG })
    .setIssuer(JWT_PENDING_2FA_ISS)
    .setIssuedAt()
    .setExpirationTime(JWT_PENDING_2FA_TTL)
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

/** Verify the short-lived password-approved TOTP challenge cookie. */
export async function verifyPendingAdminTotpJwt(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      issuer: JWT_PENDING_2FA_ISS,
      algorithms: [JWT_ALG],
    })
    if (payload.step !== "totp") return null
    return typeof payload.sub === "string" ? payload.sub : null
  } catch {
    return null
  }
}

function normalizeTotpSecret(secret: string): string {
  return secret.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/g, "")
}

function decodeBase32(secret: string): Buffer {
  const normalized = normalizeTotpSecret(secret)
  if (!normalized) {
    throw new Error("TOTP secret is empty")
  }

  let value = 0
  let bits = 0
  const bytes: number[] = []

  for (const char of normalized) {
    const index = TOTP_BASE32_ALPHABET.indexOf(char)
    if (index === -1) {
      throw new Error(`Invalid base32 TOTP character: ${char}`)
    }

    value = (value << 5) | index
    bits += 5

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }

  return Buffer.from(bytes)
}

function encodeBase32(bytes: Uint8Array): string {
  let value = 0
  let bits = 0
  let encoded = ""

  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8

    while (bits >= 5) {
      encoded += TOTP_BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f]
      bits -= 5
    }
  }

  if (bits > 0) {
    encoded += TOTP_BASE32_ALPHABET[(value << (5 - bits)) & 0x1f]
  }

  return encoded
}

function hotp(secret: Buffer, counter: bigint): string {
  const counterBytes = Buffer.alloc(8)
  counterBytes.writeBigUInt64BE(counter)

  const digest = createHmac("sha1", secret).update(counterBytes).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const code = (
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  ) % (10 ** TOTP_DIGITS)

  return code.toString().padStart(TOTP_DIGITS, "0")
}

function normalizeTotpCode(code: string): string {
  return code.replace(/\D/g, "").slice(0, TOTP_DIGITS)
}

/**
 * Verify a 6-digit RFC 6238 TOTP code against the configured admin secret.
 * Accepts +/- 1 time step to tolerate small device clock skew.
 */
export function verifyAdminTotp(code: string, secret: string, now = Date.now()): boolean {
  const normalizedCode = normalizeTotpCode(code)
  if (normalizedCode.length !== TOTP_DIGITS) return false

  const secretBytes = decodeBase32(secret)
  const currentStep = BigInt(Math.floor(now / 1000 / TOTP_PERIOD_SECONDS))

  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset += 1) {
    const candidate = hotp(secretBytes, currentStep + BigInt(offset))
    if (constantTimeEqual(normalizedCode, candidate)) {
      return true
    }
  }

  return false
}

export function generateAdminTotpSecret(byteLength = 20): string {
  return encodeBase32(randomBytes(byteLength))
}

export function buildAdminTotpProvisioningUri({
  secret,
  issuer,
  accountName,
}: {
  secret: string
  issuer: string
  accountName: string
}): string {
  const normalizedSecret = normalizeTotpSecret(secret)
  const label = `${issuer}:${accountName}`
  const params = new URLSearchParams({
    secret: normalizedSecret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  })

  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`
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
