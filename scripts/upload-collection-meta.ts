/**
 * One-shot: upload SentinelETH collection logo + banner + collection JSON
 * to Irys mainnet. Output URLs are what we feed into setContractURI() on
 * the deployed contract.
 *
 * Usage:
 *   pnpm exec tsx scripts/upload-collection-meta.ts
 */
import path from "path"
import fs from "fs"
import { config } from "dotenv"

config({ path: path.join(process.cwd(), ".env.local") })

const COLLECTION_DIR = path.join(process.cwd(), "public", "collection")
const LOGO_PATH = path.join(COLLECTION_DIR, "logo.jpg")
const BANNER_PATH = path.join(COLLECTION_DIR, "banner.jpg")

const COLLECTION_META = {
  name: "SentinelETH",
  description:
    "First agentic NFT collection on Ethereum. Mint via Claude AI through MCP. " +
    "Each Sentinel is a unique on-chain agent with deterministic traits, " +
    "lives forever on Ethereum + Irys.",
  // image and banner_image_url are filled in below after upload.
  external_link: "https://sentineleth.xyz",
  twitter_username: "SentinelTempo",
}

async function main() {
  const { Uploader } = await import("@irys/upload")
  const { Ethereum } = await import("@irys/upload-ethereum")

  const key = process.env.IRYS_PRIVATE_KEY
  const rpcUrl = process.env.IRYS_RPC_URL
  const network = process.env.IRYS_NETWORK || "devnet"

  if (!key || !rpcUrl) throw new Error("Missing IRYS_PRIVATE_KEY or IRYS_RPC_URL")
  if (network !== "mainnet") {
    throw new Error(
      `Refusing to upload collection metadata to ${network}. Set IRYS_NETWORK=mainnet first.`,
    )
  }

  for (const p of [LOGO_PATH, BANNER_PATH]) {
    if (!fs.existsSync(p)) throw new Error(`Missing file: ${p}`)
  }

  console.log(`[collection] using Irys mainnet via ${rpcUrl}`)
  const irys = await Uploader(Ethereum).withWallet(key).withRpc(rpcUrl)

  // Show balance up-front so the operator sees runway.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ir = irys as any
  const bal = await ir.getLoadedBalance()
  const human = ir.utils?.fromAtomic ? ir.utils.fromAtomic(bal).toString() : String(bal)
  console.log(`[collection] loaded balance: ${human} ETH`)

  // 1) Logo
  const logoBytes = fs.readFileSync(LOGO_PATH)
  console.log(`[collection] uploading logo (${logoBytes.length} bytes)...`)
  const logoReceipt = await irys.upload(logoBytes, {
    tags: [
      { name: "Content-Type", value: "image/jpeg" },
      { name: "App-Name", value: "SentinelETH" },
      { name: "Type", value: "collection-logo" },
    ],
  })
  const logoUrl = `https://gateway.irys.xyz/${logoReceipt.id}`
  console.log(`[collection] logo:   ${logoUrl}`)

  // 2) Banner
  const bannerBytes = fs.readFileSync(BANNER_PATH)
  console.log(`[collection] uploading banner (${bannerBytes.length} bytes)...`)
  const bannerReceipt = await irys.upload(bannerBytes, {
    tags: [
      { name: "Content-Type", value: "image/jpeg" },
      { name: "App-Name", value: "SentinelETH" },
      { name: "Type", value: "collection-banner" },
    ],
  })
  const bannerUrl = `https://gateway.irys.xyz/${bannerReceipt.id}`
  console.log(`[collection] banner: ${bannerUrl}`)

  // 3) Collection JSON
  const meta = {
    ...COLLECTION_META,
    image: logoUrl,
    banner_image_url: bannerUrl,
  }
  const metaJson = JSON.stringify(meta, null, 2)
  console.log(`[collection] uploading collection JSON (${metaJson.length} bytes)...`)
  console.log(metaJson)
  const metaReceipt = await irys.upload(metaJson, {
    tags: [
      { name: "Content-Type", value: "application/json" },
      { name: "App-Name", value: "SentinelETH" },
      { name: "Type", value: "collection-metadata" },
    ],
  })
  const metaUrl = `https://gateway.irys.xyz/${metaReceipt.id}`
  console.log(`\n========== RESULTS ==========`)
  console.log(`logo:       ${logoUrl}`)
  console.log(`banner:     ${bannerUrl}`)
  console.log(`collection: ${metaUrl}`)
  console.log(`\nNext step: call setContractURI("${metaUrl}") on the mainnet contract from the owner key.`)
  console.log(`Save these URLs — they are permanent.`)

  // Persist to a JSON file so we don't lose them.
  const out = {
    network: "mainnet",
    uploadedAt: new Date().toISOString(),
    logoUrl,
    bannerUrl,
    collectionMetadataUrl: metaUrl,
    metadata: meta,
  }
  const outPath = path.join(process.cwd(), "collection-mainnet.json")
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2))
  console.log(`\nSaved record to: ${outPath}`)
}

main().catch((e) => {
  console.error("[collection] failed:", e)
  process.exit(1)
})
