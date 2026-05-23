/**
 * One-shot: call setContractURI() on mainnet from the owner key.
 * Reads the collection metadata URL from collection-mainnet.json
 * (produced by SentinelETH/scripts/upload-collection-meta.ts).
 *
 * Usage:
 *   SENTINEL_ADDR=<addr> COLLECTION_JSON=<path> npx hardhat run \
 *     scripts/post-deploy-set-contract-uri.ts --network mainnet
 */
import hre from "hardhat"
import fs from "fs"
const { ethers } = hre

async function main() {
  const addr = process.env.SENTINEL_ADDR
  if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    throw new Error("Set SENTINEL_ADDR=<deployed address>")
  }
  const collJsonPath = process.env.COLLECTION_JSON
    || "C:\\Users\\yasha\\vsCode\\SentinelETH\\collection-mainnet.json"
  if (!fs.existsSync(collJsonPath)) {
    throw new Error(`Missing ${collJsonPath} — run upload-collection-meta.ts first`)
  }
  const rec = JSON.parse(fs.readFileSync(collJsonPath, "utf8"))
  const url = rec.collectionMetadataUrl
  if (!url || !/^https:\/\//.test(url)) {
    throw new Error(`Invalid collectionMetadataUrl in ${collJsonPath}: ${url}`)
  }

  const [signer] = await ethers.getSigners()
  const c = await ethers.getContractAt("SentinelETH", addr, signer)
  const owner = await c.owner()
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`signer ${signer.address} is not owner ${owner}`)
  }
  const cur = await c.contractURI()
  console.log(`[contractURI] current: ${cur || "<empty>"}`)
  console.log(`[contractURI] new:     ${url}`)
  if (cur === url) { console.log("[contractURI] unchanged, skipping"); return }
  const tx = await c.setContractURI(url)
  console.log(`[contractURI] tx: ${tx.hash}`)
  await tx.wait()
  const verify = await c.contractURI()
  console.log(`[contractURI] on-chain now: ${verify}`)
  if (verify !== url) throw new Error("readback mismatch")
}

main().catch((e) => { console.error(e); process.exit(1) })
