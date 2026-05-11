import { NextResponse } from "next/server"
import { createPublicClient, formatEther } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { requireAdmin } from "@/lib/auth"
import { getOptionalServerEnv } from "@/lib/env"
import {
  ethChain,
  NFT_CONTRACT_ADDRESS,
  MINT_PRICE_DISPLAY,
  MINT_PRICE_CURRENCY,
  MAX_PER_WALLET,
  PUBLIC_CAP,
  AIRDROP_CAP,
  MAX_SUPPLY,
} from "@/lib/chain"
import { SENTINEL_ABI } from "@/lib/contract"
import { serverHttp } from "@/lib/server-rpc"

const publicClient = createPublicClient({
  chain: ethChain,
  transport: serverHttp(),
})

export async function GET() {
  const admin = await requireAdmin()
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const env = getOptionalServerEnv()
    const serverAddress = env.serverPrivateKey
      ? privateKeyToAccount(env.serverPrivateKey).address
      : null
    const ownerSigner = env.ownerPrivateKey
      ? privateKeyToAccount(env.ownerPrivateKey).address
      : null

    const [
      statusResult,
      treasury,
      airdropRoot,
      onChainMinter,
      onChainOwner,
    ] = await Promise.all([
      publicClient.readContract({ address: NFT_CONTRACT_ADDRESS, abi: SENTINEL_ABI, functionName: "status" }),
      publicClient.readContract({ address: NFT_CONTRACT_ADDRESS, abi: SENTINEL_ABI, functionName: "treasury" }),
      publicClient.readContract({ address: NFT_CONTRACT_ADDRESS, abi: SENTINEL_ABI, functionName: "airdropRoot" }),
      publicClient.readContract({ address: NFT_CONTRACT_ADDRESS, abi: SENTINEL_ABI, functionName: "minter" }),
      publicClient.readContract({ address: NFT_CONTRACT_ADDRESS, abi: SENTINEL_ABI, functionName: "owner" }),
    ])

    const serverHasUriSetter = serverAddress !== null
      && (onChainMinter as string).toLowerCase() === serverAddress.toLowerCase()
    const ownerHasAdmin = ownerSigner !== null
      && (onChainOwner as string).toLowerCase() === ownerSigner.toLowerCase()

    const [
      totalSupply,
      publicMinted,
      airdropMinted,
      publicRemaining,
      airdropRemaining,
      mintPriceWei,
      publicClosed,
      paused,
    ] = statusResult as readonly [bigint, bigint, bigint, bigint, bigint, bigint, boolean, boolean]
    // Ownable contract has no airdropClosed flag; derive it from cap exhaustion.
    const airdropClosed = airdropRemaining === 0n

    // Native ETH balances (best-effort).
    const [treasuryEth, serverEth, contractEth] = await Promise.all([
      publicClient.getBalance({ address: treasury as `0x${string}` }).catch(() => null),
      serverAddress
        ? publicClient.getBalance({ address: serverAddress }).catch(() => null)
        : Promise.resolve(null),
      publicClient.getBalance({ address: NFT_CONTRACT_ADDRESS }).catch(() => null),
    ])

    return NextResponse.json({
      contract: {
        address: NFT_CONTRACT_ADDRESS,
        treasury,
        watcher: serverAddress,
        watcherHasUriSetterRole: Boolean(serverHasUriSetter),
        ownerSigner,
        ownerHasAdminRole: Boolean(ownerHasAdmin),
        ownerConfigured: ownerSigner !== null,
        airdropRoot,
        airdropRootSet: airdropRoot !== "0x0000000000000000000000000000000000000000000000000000000000000000",
        publicClosed,
        airdropClosed,
        paused,
      },
      constants: {
        maxSupply: MAX_SUPPLY,
        publicCap: PUBLIC_CAP,
        airdropCap: AIRDROP_CAP,
        mintPrice: MINT_PRICE_DISPLAY,
        mintPriceWei: mintPriceWei.toString(),
        currency: MINT_PRICE_CURRENCY,
        maxPerWallet: MAX_PER_WALLET,
      },
      supply: {
        total: Number(totalSupply),
        max: MAX_SUPPLY,
        publicMinted: Number(publicMinted),
        publicCap: PUBLIC_CAP,
        publicRemaining: Number(publicRemaining),
        airdropMinted: Number(airdropMinted),
        airdropCap: AIRDROP_CAP,
        airdropRemaining: Number(airdropRemaining),
        remaining: MAX_SUPPLY - Number(totalSupply),
      },
      balances: {
        treasuryEth: treasuryEth !== null ? formatEther(treasuryEth) : null,
        serverEth: serverEth !== null ? formatEther(serverEth) : null,
        contractEth: contractEth !== null ? formatEther(contractEth) : null,
      },
      timing: {
        now: Math.floor(Date.now() / 1000),
      },
    })
  } catch (err) {
    console.error("Admin status failed:", err)
    return NextResponse.json(
      { error: "Failed to fetch contract status" },
      { status: 500 },
    )
  }
}
