/**
 * One-shot: pause the freshly-deployed mainnet contract from the owner key.
 * Use only if deploy-eth.ts crashed before its built-in pause step ran.
 */
import hre from "hardhat"
const { ethers } = hre

async function main() {
  const addr = process.env.SENTINEL_ADDR
  if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    throw new Error("Set SENTINEL_ADDR=<deployed address>")
  }
  const [signer] = await ethers.getSigners()
  const c = await ethers.getContractAt("SentinelETH", addr, signer)
  const owner = await c.owner()
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`signer ${signer.address} is not owner ${owner}`)
  }
  const already = await c.paused()
  console.log(`[pause] already paused: ${already}`)
  if (already) return
  console.log(`[pause] sending pause()...`)
  const tx = await c.pause()
  console.log(`[pause] tx: ${tx.hash}`)
  await tx.wait()
  const now = await c.paused()
  console.log(`[pause] paused now: ${now}`)
  if (!now) throw new Error("pause did not take effect")
}

main().catch((e) => { console.error(e); process.exit(1) })
