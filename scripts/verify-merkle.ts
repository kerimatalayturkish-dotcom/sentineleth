/**
 * Verify the Render-hosted merkle proofs against the new root using the *exact*
 * same leaf hash + verification logic as SentinelETH.sol:
 *
 *   leaf = keccak256(bytes.concat(keccak256(abi.encode(addr))))
 *   MerkleProof.verify(proof, root, leaf)
 *
 * This catches any drift between the script that publishes proofs and the
 * contract that consumes them. We:
 *   1. Read the root from `config/merkle-root.json` (= constructor arg).
 *   2. Pull a stratified sample (first, middle, last) + a few random rows
 *      from `merkle_proofs` on Render.
 *   3. Verify each one locally with viem + @openzeppelin/merkle-tree.
 *   4. Sanity-check a known-bad address fails.
 *   5. Confirm a non-whitelisted address has no row.
 */

import fs from "fs"
import path from "path"
import { keccak256, encodeAbiParameters, getAddress, isAddress, concat, type Hex } from "viem"
import { StandardMerkleTree } from "@openzeppelin/merkle-tree"

import pool from "../lib/db"

const ROOT_FILE = path.resolve(__dirname, "../config/merkle-root.json")
const WL_FILE = path.resolve(__dirname, "../config/whitelist.json")

function leafHash(addr: `0x${string}`): Hex {
  // OZ StandardMerkleTree leaf = keccak256(bytes.concat(keccak256(abi.encode(addr))))
  const inner = keccak256(encodeAbiParameters([{ type: "address" }], [addr]))
  return keccak256(concat([inner]))
}

function verifyProof(proof: readonly `0x${string}`[], root: `0x${string}`, leaf: `0x${string}`): boolean {
  // Mirrors OpenZeppelin MerkleProof.verify (sorted-pair hashing).
  let computed: Hex = leaf
  for (const sibling of proof) {
    const [a, b] =
      BigInt(computed) < BigInt(sibling) ? [computed, sibling] : [sibling, computed]
    computed = keccak256(concat([a, b]))
  }
  return computed.toLowerCase() === root.toLowerCase()
}

async function main() {
  const { root: expectedRoot } = JSON.parse(fs.readFileSync(ROOT_FILE, "utf-8")) as {
    root: `0x${string}`
  }
  const whitelist = JSON.parse(fs.readFileSync(WL_FILE, "utf-8")) as string[]
  console.log("Local root:        ", expectedRoot)
  console.log("Local WL count:    ", whitelist.length)

  // 1. Compare DB root to file root
  const meta = await pool.query<{ root: string; leaf_count: number }>(
    "SELECT root, leaf_count FROM merkle_meta WHERE id = 1",
  )
  if (meta.rowCount === 0) throw new Error("merkle_meta.id=1 missing")
  const dbRoot = meta.rows[0].root as `0x${string}`
  const dbCount = meta.rows[0].leaf_count
  console.log("DB root:           ", dbRoot)
  console.log("DB leaf_count:     ", dbCount)
  if (dbRoot.toLowerCase() !== expectedRoot.toLowerCase()) {
    throw new Error("ROOT MISMATCH between merkle-root.json and merkle_meta")
  }
  if (dbCount !== whitelist.length) {
    throw new Error(`leaf_count ${dbCount} ≠ whitelist.json ${whitelist.length}`)
  }

  // 2. Independently rebuild root from whitelist.json with OZ library
  const tree = StandardMerkleTree.of(
    whitelist.map(a => [getAddress(a)]),
    ["address"],
  )
  console.log("OZ rebuilt root:   ", tree.root)
  if (tree.root.toLowerCase() !== expectedRoot.toLowerCase()) {
    throw new Error("OZ rebuild ≠ stored root — whitelist.json is out of sync")
  }

  // 3. Pick sample addresses
  const idxs = new Set<number>([
    0,
    Math.floor(whitelist.length / 2),
    whitelist.length - 1,
  ])
  while (idxs.size < 8) {
    idxs.add(Math.floor(Math.random() * whitelist.length))
  }
  const sample = [...idxs].sort((a, b) => a - b).map(i => whitelist[i])

  console.log("\n=== Verifying sample of", sample.length, "addresses ===")
  let ok = 0
  for (const addr of sample) {
    if (!isAddress(addr)) throw new Error(`bad address in WL: ${addr}`)
    const cs = getAddress(addr)
    // Pull proof from Render exactly as the API would
    const r = await pool.query<{ proof: string }>(
      "SELECT proof FROM merkle_proofs WHERE address = $1 LIMIT 1",
      [cs.toLowerCase()],
    )
    if (r.rowCount === 0) {
      console.log(`  ✗ ${cs}  no proof row`)
      continue
    }
    const proofRaw = r.rows[0].proof
    const proof = (typeof proofRaw === "string" ? JSON.parse(proofRaw) : proofRaw) as `0x${string}`[]
    const leaf = leafHash(cs as `0x${string}`)
    const valid = verifyProof(proof, expectedRoot, leaf)
    console.log(`  ${valid ? "✓" : "✗"} ${cs}  depth=${proof.length}  proof[0]=${proof[0]?.slice(0, 10)}…`)
    if (valid) ok++
  }
  console.log(`\nVerified ${ok} / ${sample.length} sample proofs\n`)

  // 4. Negative test: random non-WL address must NOT be in DB
  const fake = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as const
  const f = await pool.query("SELECT 1 FROM merkle_proofs WHERE address = $1", [fake])
  console.log(`Non-WL ${fake}  →  rows=${f.rowCount} (expect 0)`)
  if (f.rowCount !== 0) throw new Error("Non-WL address found in DB")

  // 5. Negative test: WL address with WRONG proof must fail verification
  const victim = sample[0]
  const wrongProof: `0x${string}`[] = [
    "0x0000000000000000000000000000000000000000000000000000000000000001",
  ]
  const wrongOk = verifyProof(wrongProof, expectedRoot, leafHash(getAddress(victim) as `0x${string}`))
  console.log(`Tampered proof verify → ${wrongOk} (expect false)`)
  if (wrongOk) throw new Error("Tampered proof passed — verification logic is broken")

  if (ok !== sample.length) {
    throw new Error(`Only ${ok}/${sample.length} proofs verified — DO NOT DEPLOY`)
  }
  console.log("\n✅ All checks passed. Safe to proceed to Phase C.")
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error("\n❌", err)
    process.exit(1)
  })
