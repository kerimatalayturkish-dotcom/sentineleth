/**
 * Test script: uploads a small PNG and metadata JSON to Irys devnet.
 *
 * Usage:  npx tsx scripts/test-irys-upload.ts
 *
 * Requires .env.local to have IRYS_PRIVATE_KEY, IRYS_RPC_URL, IRYS_NETWORK.
 */
import path from "path"
import { config } from "dotenv"

// Load .env.local so process.env is populated outside Next.js
config({ path: path.join(process.cwd(), ".env.local") })

async function main() {
  // Dynamic import after env is loaded
  const { Uploader } = await import("@irys/upload")
  const { Ethereum } = await import("@irys/upload-ethereum")

  const key = process.env.IRYS_PRIVATE_KEY
  const rpcUrl = process.env.IRYS_RPC_URL
  const network = process.env.IRYS_NETWORK || "devnet"

  if (!key || !rpcUrl) {
    throw new Error("Missing IRYS_PRIVATE_KEY or IRYS_RPC_URL in .env.local")
  }

  console.log(`Connecting to Irys (${network}) via RPC ${rpcUrl}...`)

  let irys
  if (network === "devnet") {
    irys = await Uploader(Ethereum).withWallet(key).withRpc(rpcUrl).devnet()
  } else {
    irys = await Uploader(Ethereum).withWallet(key)
  }

  // 1) Upload a tiny test string as "image"
  const testPayload = Buffer.from("Hello from SentinelETH test upload!")

  console.log("Uploading test data...")
  const imgReceipt = await irys.upload(testPayload, {
    tags: [
      { name: "Content-Type", value: "text/plain" },
      { name: "App-Name", value: "SentinelETH-test" },
    ],
  })
  const imageUrl = `https://gateway.irys.xyz/${imgReceipt.id}`
  console.log(`  Image URL: ${imageUrl}`)

  // 2) Upload metadata JSON
  const metadata = {
    name: "SentinelETH #0 (test)",
    description: "Test upload for SentinelETH pipeline",
    image: imageUrl,
    attributes: [
      { trait_type: "Background", value: "Blue" },
      { trait_type: "Body", value: "Base" },
    ],
  }

  console.log("Uploading metadata...")
  const metaReceipt = await irys.upload(JSON.stringify(metadata), {
    tags: [
      { name: "Content-Type", value: "application/json" },
      { name: "App-Name", value: "SentinelETH-test" },
    ],
  })
  const metadataUrl = `https://gateway.irys.xyz/${metaReceipt.id}`
  console.log(`  Metadata URL: ${metadataUrl}`)

  console.log("\nDone! Both uploads succeeded.")
  console.log(`Verify image:    ${imageUrl}`)
  console.log(`Verify metadata: ${metadataUrl}`)
}

main().catch((err) => {
  console.error("Upload test failed:", err)
  process.exit(1)
})
