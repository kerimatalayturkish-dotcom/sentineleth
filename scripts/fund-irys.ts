/**
 * Fund the Irys devnet/mainnet account from SERVER_PRIVATE_KEY (a.k.a. IRYS key).
 *
 * Usage: npx tsx --env-file=.env.local scripts/fund-irys.ts <amount>
 *   amount is in the node's base token (e.g. "0.005" ETH on Sepolia devnet).
 */
import { fundIrys, getIrysStatus } from "../lib/irys"

async function main() {
  const amount = process.argv[2] ?? "0.005"
  const before = await getIrysStatus()
  console.log(`[fund] before: ${before.loadedBalance} ${before.token} (${before.network})`)
  console.log(`[fund] funding ${amount} ${before.token}...`)
  const r = await fundIrys(amount)
  console.log(`[fund] tx: ${r.txHash}`)
  const after = await getIrysStatus()
  console.log(`[fund] after:  ${after.loadedBalance} ${after.token}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
