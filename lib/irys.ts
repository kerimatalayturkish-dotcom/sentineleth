import { getServerEnv } from "@/lib/env"

const GATEWAY = {
  devnet: "https://devnet.irys.xyz",
  mainnet: "https://gateway.irys.xyz",
} as const

// ─── Lazy singleton ─────────────────────────────────────────────
// Building the uploader requires two dynamic imports + key decode;
// we memoise it so every upload reuses the same instance.
let _uploader: Promise<unknown> | null = null
let _network: 'devnet' | 'mainnet' | null = null

async function getIrysUploader() {
  if (_uploader) return _uploader

  _uploader = (async () => {
    const { Uploader } = await import("@irys/upload")
    const { Ethereum } = await import("@irys/upload-ethereum")

    const env = getServerEnv()
    _network = env.irysNetwork

    if (env.irysNetwork === "devnet") {
      return Uploader(Ethereum)
        .withWallet(env.irysPrivateKey)
        .withRpc(env.irysRpcUrl)
        .devnet()
    }

    // Mainnet: also pass the configured RPC so we don't depend on the
    // SDK's cloudflare-eth.com default (which has been returning errors).
    return Uploader(Ethereum)
      .withWallet(env.irysPrivateKey)
      .withRpc(env.irysRpcUrl)
  })()

  return _uploader
}

function gatewayUrl(id: string): string {
  const net = _network ?? (getServerEnv().irysNetwork)
  const base = net === "devnet" ? GATEWAY.devnet : GATEWAY.mainnet
  return `${base}/${id}`
}

// ─── Funding helpers (admin-only) ───────────────────────────────
// Irys uploads draw from a pre-funded balance attached to the uploader's
// wallet. These helpers expose the current balance and a top-up call so
// the admin dashboard doesn't need to drop into a script.

export async function getIrysStatus(): Promise<{
  address: string
  network: "devnet" | "mainnet"
  token: string
  loadedBalanceAtomic: string
  loadedBalance: string
}> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const irys = (await getIrysUploader()) as any
  const balance = await irys.getLoadedBalance()
  const atomic = balance?.toString?.() ?? String(balance)
  const human = irys.utils?.fromAtomic
    ? irys.utils.fromAtomic(balance).toString()
    : atomic
  return {
    address: irys.address,
    network: _network ?? getServerEnv().irysNetwork,
    token: irys.token ?? "ethereum",
    loadedBalanceAtomic: atomic,
    loadedBalance: human,
  }
}

export async function fundIrys(amount: string): Promise<{
  txHash: string
  amountAtomic: string
}> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const irys = (await getIrysUploader()) as any
  if (!irys.utils?.toAtomic) {
    throw new Error("Irys SDK missing utils.toAtomic — cannot fund")
  }
  const atomic = irys.utils.toAtomic(amount)
  const receipt = await irys.fund(atomic)
  return {
    txHash: String(receipt?.id ?? receipt?.tx ?? ""),
    amountAtomic: atomic.toString(),
  }
}

// Estimate the cost to upload `bytes` bytes against the current Irys node.
// Used by the admin dashboard so the operator can see how much runway the
// current loaded balance buys before a re-fund is needed. Returns both atomic
// and human-readable strings.
export async function getIrysPrice(bytes: number): Promise<{
  bytes: number
  priceAtomic: string
  price: string
}> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const irys = (await getIrysUploader()) as any
  const priceAtomic = await irys.getPrice(bytes)
  const human = irys.utils?.fromAtomic
    ? irys.utils.fromAtomic(priceAtomic).toString()
    : priceAtomic.toString()
  return {
    bytes,
    priceAtomic: priceAtomic.toString(),
    price: human,
  }
}

// ─── Uploads (used by the mint watcher) ───────
// Returns the gateway URL the contract should store as `tokenURI`.

const APP_NAME = "SentinelETH"

export async function uploadImage(png: Buffer): Promise<{ id: string; url: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const irys = (await getIrysUploader()) as any
  const receipt = await irys.upload(png, {
    tags: [
      { name: "Content-Type", value: "image/png" },
      { name: "App-Name", value: APP_NAME },
      { name: "Type", value: "image" },
    ],
  })
  const id = String(receipt?.id ?? "")
  if (!id) throw new Error("uploadImage: irys returned no id")
  return { id, url: gatewayUrl(id) }
}

export async function uploadMetadata(meta: Record<string, unknown>): Promise<{ id: string; url: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const irys = (await getIrysUploader()) as any
  const receipt = await irys.upload(JSON.stringify(meta), {
    tags: [
      { name: "Content-Type", value: "application/json" },
      { name: "App-Name", value: APP_NAME },
      { name: "Type", value: "metadata" },
    ],
  })
  const id = String(receipt?.id ?? "")
  if (!id) throw new Error("uploadMetadata: irys returned no id")
  return { id, url: gatewayUrl(id) }
}

