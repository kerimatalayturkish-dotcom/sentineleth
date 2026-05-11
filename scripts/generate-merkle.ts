/**
 * Regenerate the Merkle tree for the current whitelist and publish it:
 *   1. Read `config/whitelist.json`
 *   2. Build an OpenZeppelin StandardMerkleTree (double-hashed leaves,
 *      matches `keccak256(bytes.concat(keccak256(abi.encode(sender))))`
 *      in SentinelETH.sol)
 *   3. Write the root to `config/merkle-root.json` (hardhat scripts still
 *      read this file to call `setMerkleRoot`)
 *   4. Atomically upsert every (address, proof) pair into the
 *      `merkle_proofs` table via `lib/merkle.ts`
 *
 * Run:  pnpm generate-merkle
 *       (requires DATABASE_URL + whitelist.json)
 */

import { StandardMerkleTree } from "@openzeppelin/merkle-tree"
import fs from "fs"
import path from "path"
import { getAddress } from "viem"

import { replaceMerkleTree } from "../lib/merkle"

async function main() {
  const whitelistPath = path.resolve(__dirname, "../config/whitelist.json")
  const raw: string[] = JSON.parse(fs.readFileSync(whitelistPath, "utf-8"))

  if (raw.length === 0) throw new Error("Whitelist is empty")

  // Normalize + deduplicate (checksum form so the tree is stable under case changes)
  const seen = new Set<string>()
  const addresses: string[] = []
  for (const a of raw) {
    const checksum = getAddress(a.trim())
    if (!seen.has(checksum)) {
      seen.add(checksum)
      addresses.push(checksum)
    }
  }

  // OZ StandardMerkleTree: leaf = keccak256(bytes.concat(keccak256(abi.encode(address))))
  const tree = StandardMerkleTree.of(
    addresses.map(a => [a]),
    ["address"],
  )

  const root = tree.root as `0x${string}`
  console.log("Merkle root:", root)
  console.log("Leaves:", addresses.length)

  // 1) Write root to config/merkle-root.json (consumed by contracts/scripts/set-merkle-root.ts)
  const rootPath = path.resolve(__dirname, "../config/merkle-root.json")
  fs.writeFileSync(rootPath, JSON.stringify({ root }, null, 2) + "\n")
  console.log("Root written to:", rootPath)

  // 2) Collect per-address proofs
  const proofs: Record<string, `0x${string}`[]> = {}
  for (const [i, value] of tree.entries()) {
    const addr = (value[0] as string).toLowerCase()
    proofs[addr] = tree.getProof(i) as `0x${string}`[]
  }

  // 3) Atomically replace the Postgres table
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL not set ??? cannot publish proofs to Postgres")
  }
  await replaceMerkleTree(root, proofs)
  console.log(`Wrote ${Object.keys(proofs).length} proofs to merkle_proofs table`)
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err)
    process.exit(1)
  })