import traitsConfig from "@/config/traits.json"
import { encodePacked, keccak256, toBytes, type Address, type Hex } from "viem"

export interface TraitOption {
  id: string
  name: string
  file: string
}
export interface TraitLayer {
  id: string
  name: string
  order: number
  required: boolean
  options: TraitOption[]
}
export interface TraitsConfig {
  layers: TraitLayer[]
}

export type TraitSelection = Record<string, string>

const CFG = traitsConfig as TraitsConfig

/** Layers in render order (base → top). */
export function getLayers(): TraitLayer[] {
  return [...CFG.layers].sort((a, b) => a.order - b.order)
}

/** Resolve a layer.option to its file path under public/layers/. */
export function getLayerFile(layerId: string, optionId: string): string | null {
  const layer = CFG.layers.find((l) => l.id === layerId)
  if (!layer) return null
  const option = layer.options.find((o) => o.id === optionId)
  return option ? option.file : null
}

/** Validate a selection against the catalog. Returns errors array (empty = valid). */
export function validateSelection(selection: TraitSelection): string[] {
  const errors: string[] = []
  for (const layer of CFG.layers) {
    const optionId = selection[layer.id]
    if (layer.required && !optionId) {
      errors.push(`required layer "${layer.id}" missing`)
      continue
    }
    if (optionId && !layer.options.some((o) => o.id === optionId)) {
      errors.push(`unknown option "${optionId}" for layer "${layer.id}"`)
    }
  }
  return errors
}

/** OpenSea-style attributes array for a selection. */
export function getTraitAttributes(selection: TraitSelection) {
  return CFG.layers
    .filter((layer) => selection[layer.id])
    .map((layer) => {
      const option = layer.options.find((o) => o.id === selection[layer.id])
      return { trait_type: layer.name, value: option?.name ?? selection[layer.id] }
    })
}

// ────────────────────────────────────────────────────────────────────────
// Layer A — deterministic per-token seed
// ────────────────────────────────────────────────────────────────────────

/**
 * Threshold (out of 256) above which an OPTIONAL layer is rendered.
 *
 * Old `mulberry32`-based selector used `rng() < 0.7` (≈70% present rate).
 * `0.7 * 256 ≈ 179`, so any random byte < 179 means present. Preserves the
 * visual frequency distribution of the existing collection.
 */
const OPTIONAL_LAYER_PRESENT_THRESHOLD = 179

/**
 * Canonical per-token seed used by the watcher to derive art.
 *
 *   seed = keccak256( contract || tokenId || chainId )
 *
 * Properties:
 *   • Fully deterministic — same (contract, tokenId, chainId) always
 *     produces the same seed, so a watcher restart / backfill regenerates
 *     identical art.
 *   • Reproducible off-chain — anyone with the contract address and the
 *     trait catalog can verify a token's traits given its tokenId. This is
 *     the on-chain provenance story for the collection.
 *   • Domain-separated by chainId — the same tokenId on testnet vs mainnet
 *     yields different art (no cross-chain look-alikes).
 *   • Full 256 bits of entropy (vs the 32-bit FNV+mulberry32 we had before),
 *     making collisions in the seed itself astronomically improbable.
 */
export function seedForToken(
  contract: Address,
  tokenId: bigint,
  chainId: number,
): Hex {
  return keccak256(
    encodePacked(
      ["address", "uint256", "uint256"],
      [contract, tokenId, BigInt(chainId)],
    ),
  )
}

/**
 * Derive a TraitSelection from a 32-byte seed.
 *
 * Stream design: we treat the seed as a byte source. Each layer consumes
 *   • 1 byte to decide presence (optional layers only),
 *   • 4 bytes to pick the option index (uint32 mod options.length).
 * If we run out of bytes (worst case ≈ 33 bytes for 7 layers), we extend
 * the stream by re-hashing: `next = keccak256(seed || counter)`.
 *
 * `attempt` is the Layer-B re-roll nonce. Attempt 0 uses the seed as-is;
 * attempt N>0 uses `keccak256(seed || attempt)` instead. This gives Layer
 * B up to 2^32 distinct re-roll seeds per token while keeping each
 * (seed, attempt) pair fully deterministic and reproducible.
 */
export function selectionFromSeed(seed: Hex, attempt = 0): TraitSelection {
  const baseSeed = attempt === 0
    ? seed
    : keccak256(encodePacked(["bytes32", "uint32"], [seed, attempt]))

  const stream = byteStream(baseSeed)
  const sel: TraitSelection = {}
  for (const layer of getLayers()) {
    if (!layer.required) {
      const presenceByte = stream.next()
      if (presenceByte >= OPTIONAL_LAYER_PRESENT_THRESHOLD) continue
    }
    if (layer.options.length === 0) continue
    const u32 = stream.nextUint32()
    sel[layer.id] = layer.options[u32 % layer.options.length].id
  }
  return sel
}

/**
 * Canonical hash of a trait selection — used as the Layer-B uniqueness key.
 *
 * Format: `layerId:optionId|layerId:optionId|...` sorted by layer.order.
 * Absent (optional) layers are omitted. The string is keccak256'd to a
 * fixed-size hex digest so it's cheap to store + compare.
 *
 * Two tokens with the same set of (layer, option) pairs (regardless of
 * insertion order) produce the same comboHash → that's how Layer B detects
 * a duplicate "look".
 */
export function comboHash(selection: TraitSelection): Hex {
  const parts = getLayers()
    .filter((l) => selection[l.id])
    .map((l) => `${l.id}:${selection[l.id]}`)
  return keccak256(toBytes(parts.join("|")))
}

// ────────────────────────────────────────────────────────────────────────
// Internal byte-stream helper
// ────────────────────────────────────────────────────────────────────────

/**
 * Lazy 256-bit-per-chunk byte source seeded from a 32-byte hex value.
 * Extends by `keccak256(seed || counter)` whenever the current chunk is
 * exhausted. Used by `selectionFromSeed` to draw bytes deterministically.
 */
function byteStream(seedHex: Hex): {
  next(): number
  nextUint32(): number
} {
  let chunk = hexToBytes(seedHex)
  let offset = 0
  let counter = 0

  function ensure(n: number): void {
    if (offset + n <= chunk.length) return
    counter += 1
    chunk = hexToBytes(
      keccak256(encodePacked(["bytes32", "uint32"], [seedHex, counter])),
    )
    offset = 0
  }

  return {
    next(): number {
      ensure(1)
      return chunk[offset++]
    },
    nextUint32(): number {
      ensure(4)
      const v =
        (chunk[offset] << 24) |
        (chunk[offset + 1] << 16) |
        (chunk[offset + 2] << 8) |
        chunk[offset + 3]
      offset += 4
      return v >>> 0
    },
  }
}

function hexToBytes(hex: Hex): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.substr(i * 2, 2), 16)
  }
  return out
}

// ────────────────────────────────────────────────────────────────────────
// Legacy string-seed selector (kept for back-compat with old call sites)
// ────────────────────────────────────────────────────────────────────────

/**
 * @deprecated Use `seedForToken()` + `selectionFromSeed()` instead. The
 * legacy 32-bit FNV+mulberry32 path has weaker collision resistance and is
 * kept only so old scripts (e.g. one-off backfill utilities) keep building.
 */
export function deterministicSelection(seed: string): TraitSelection {
  const rng = mulberry32(hashSeed(seed))
  const sel: TraitSelection = {}
  for (const layer of getLayers()) {
    if (layer.required || rng() < 0.7) {
      const idx = Math.floor(rng() * layer.options.length)
      sel[layer.id] = layer.options[idx].id
    }
  }
  return sel
}

function hashSeed(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
function mulberry32(a: number) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
