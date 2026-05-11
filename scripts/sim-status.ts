import { createPublicClient, http, formatEther } from "viem"
import { sepolia } from "viem/chains"
import { SENTINEL_ABI } from "../lib/contract"

const ADDR = (process.env.NEXT_PUBLIC_NFT_CONTRACT_ADDRESS ||
  "0x92Cee4F4C93B5d0D281b962Fc3C80CbA1630cd7A") as `0x${string}`

async function main() {
  const c = createPublicClient({
    chain: sepolia,
    transport: http(process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com"),
  })
  const [supply, status, treasury, owner, minter, balance] = await Promise.all([
    c.readContract({ address: ADDR, abi: SENTINEL_ABI, functionName: "totalSupply" }),
    c.readContract({ address: ADDR, abi: SENTINEL_ABI, functionName: "status" }),
    c.readContract({ address: ADDR, abi: SENTINEL_ABI, functionName: "treasury" }),
    c.readContract({ address: ADDR, abi: SENTINEL_ABI, functionName: "owner" }),
    c.readContract({ address: ADDR, abi: SENTINEL_ABI, functionName: "minter" }),
    c.getBalance({ address: ADDR }),
  ])
  const [
    totalSupply,
    publicMinted,
    airdropMinted,
    publicRemaining,
    airdropRemaining,
    mintPrice,
    publicClosed,
    airdropClosed,
    paused,
  ] = status as readonly [bigint, bigint, bigint, bigint, bigint, bigint, boolean, boolean, boolean]

  let token1: { owner: string; uri: string } | null = null
  let token2: { owner: string; uri: string } | null = null
  if (totalSupply >= 1n) {
    try {
      const [o, u] = await Promise.all([
        c.readContract({ address: ADDR, abi: SENTINEL_ABI, functionName: "ownerOf", args: [1n] }),
        c.readContract({ address: ADDR, abi: SENTINEL_ABI, functionName: "tokenURI", args: [1n] }),
      ])
      token1 = { owner: o as string, uri: u as string }
    } catch {}
  }
  if (totalSupply >= 2n) {
    try {
      const [o, u] = await Promise.all([
        c.readContract({ address: ADDR, abi: SENTINEL_ABI, functionName: "ownerOf", args: [2n] }),
        c.readContract({ address: ADDR, abi: SENTINEL_ABI, functionName: "tokenURI", args: [2n] }),
      ])
      token2 = { owner: o as string, uri: u as string }
    } catch {}
  }

  console.log(JSON.stringify({
    contract: ADDR,
    totalSupply: totalSupply.toString(),
    publicMinted: publicMinted.toString(),
    airdropMinted: airdropMinted.toString(),
    publicRemaining: publicRemaining.toString(),
    airdropRemaining: airdropRemaining.toString(),
    mintPriceEth: formatEther(mintPrice),
    paused, publicClosed, airdropClosed,
    treasury,
    owner,
    minter,
    contractBalanceEth: formatEther(balance),
    erc721aTotalSupply: supply.toString(),
    token1,
    token2,
  }, null, 2))
}
main().catch((e) => { console.error(e); process.exit(1) })
