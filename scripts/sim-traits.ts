/**
 * One-off smoke test for the Layer A keccak-stream selector.
 *
 * Walks tokenIds 1..10_000 with the canonical seedForToken() and reports:
 *   • how many unique combos we get at attempt 0 (Layer A only)
 *   • how many tokens needed a Layer-B reroll
 *   • the maximum reroll depth observed
 *   • final unique-combo count after Layer B
 *
 * Run: pnpm tsx scripts/sim-traits.ts
 */
import { seedForToken, selectionFromSeed, comboHash } from "@/lib/traits"
import { NFT_CONTRACT_ADDRESS, ethChain } from "@/lib/chain"

const TOTAL = 10_000
const MAX_RETRIES = 32

const seen = new Set<string>()
let layerACollisions = 0
let rerolledTokens = 0
let maxAttempt = 0

for (let id = 1n; id <= BigInt(TOTAL); id++) {
  const seed = seedForToken(NFT_CONTRACT_ADDRESS, id, ethChain.id)
  let chosen = ""
  let attempt = 0
  for (; attempt < MAX_RETRIES; attempt++) {
    const sel = selectionFromSeed(seed, attempt)
    const h = comboHash(sel)
    if (attempt === 0 && seen.has(h)) layerACollisions++
    if (!seen.has(h)) { chosen = h; break }
  }
  if (attempt > 0) rerolledTokens++
  if (attempt > maxAttempt) maxAttempt = attempt
  if (chosen) seen.add(chosen)
}

console.log(`tokens simulated:        ${TOTAL}`)
console.log(`unique combos final:     ${seen.size}`)
console.log(`Layer-A collisions:      ${layerACollisions}`)
console.log(`tokens needing reroll:   ${rerolledTokens}`)
console.log(`max reroll depth used:   ${maxAttempt}`)
