/**
 * Entry point for the mint watcher.
 *
 * Run from the repo root with:
 *   npm run watcher
 *
 * Which expands to:
 *   node --env-file=.env.local --import tsx scripts/run-watcher.ts
 *
 * Optional CLI:
 *   --from-block N   start watching from block N (default: latest)
 */
import { runMintWatcher } from "../lib/mint-watcher"

function parseArgs(): { fromBlock?: bigint } {
  const out: { fromBlock?: bigint } = {}
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from-block") {
      const v = argv[++i]
      if (v) out.fromBlock = BigInt(v)
    }
  }
  return out
}

runMintWatcher(parseArgs()).catch((err) => {
  console.error("[watcher] fatal:", err)
  process.exit(1)
})
