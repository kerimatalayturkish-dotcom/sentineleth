/**
 * Combine all CSVs in `White lists/` into `config/whitelist.json`.
 * - Extracts every 0x...40-hex address (any column / any row)
 * - Normalises to EIP-55 checksum
 * - Deduplicates
 * - Writes JSON sorted alphabetically (stable ordering for diffs)
 *
 * Run:  npx tsx scripts/build-whitelist.ts
 */

import fs from "fs"
import path from "path"
import { getAddress, isAddress } from "viem"

const ROOT = path.resolve(__dirname, "..")
const CSV_DIR = path.join(ROOT, "White lists")
const OUT = path.join(ROOT, "config", "whitelist.json")

const ADDR_RE = /0x[0-9a-fA-F]{40}/g

function main() {
  const files = fs
    .readdirSync(CSV_DIR)
    .filter(f => f.toLowerCase().endsWith(".csv"))
    .sort()

  const seen = new Set<string>()
  const perFile: Record<string, number> = {}

  for (const f of files) {
    const text = fs.readFileSync(path.join(CSV_DIR, f), "utf-8")
    const matches = text.match(ADDR_RE) ?? []
    let kept = 0
    for (const m of matches) {
      if (!isAddress(m)) continue
      const cs = getAddress(m)
      if (!seen.has(cs)) {
        seen.add(cs)
        kept++
      }
    }
    perFile[f] = matches.length
    console.log(
      `  ${f.padEnd(35)} raw=${String(matches.length).padStart(4)}  new=${kept}`,
    )
  }

  const addresses = [...seen].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))

  fs.writeFileSync(OUT, JSON.stringify(addresses, null, 2) + "\n")
  console.log(`\nWrote ${addresses.length} unique checksum addresses to ${path.relative(ROOT, OUT)}`)
}

main()
