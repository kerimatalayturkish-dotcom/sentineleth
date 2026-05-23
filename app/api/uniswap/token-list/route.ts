import type { NextRequest } from "next/server"
import { miningPublicConfig } from "@/lib/mining-config"

const TOKEN_LIST_TIMESTAMP = "2026-05-21T00:00:00.000Z"
const TOKEN_LIST_VERSION = {
  major: 1,
  minor: 0,
  patch: 0,
}

function responseHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "public, max-age=300, s-maxage=300",
  }
}

function absoluteUrl(request: NextRequest, path: string) {
  return new URL(path, request.url).toString()
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: responseHeaders(),
  })
}

export function GET(request: NextRequest) {
  const sentiToken = miningPublicConfig.miningChain.contracts.sentiToken

  if (!sentiToken) {
    return Response.json(
      { error: "NEXT_PUBLIC_SENTI_TOKEN_ADDRESS not set" },
      {
        status: 503,
        headers: responseHeaders(),
      },
    )
  }

  const chainName = miningPublicConfig.miningChain.name
  const chainId = miningPublicConfig.miningChain.chainId
  const logoUri = absoluteUrl(request, "/sentineleth.jpg")
  const tags = ["gaming", "mining"]
  const tokenListTags: Record<string, { name: string; description: string }> = {
    gaming: {
      name: "Gaming",
      description: "SentinelETH ecosystem tokens",
    },
    mining: {
      name: "Mining",
      description: "SentinelETH mining and reward tokens",
    },
  }

  if (chainId === 11155111) {
    tags.push("testnet")
    tokenListTags.testnet = {
      name: "Testnet",
      description: "SentinelETH testnet assets",
    }
  }

  return Response.json(
    {
      name: `SentinelETH ${chainName} Token List`,
      timestamp: TOKEN_LIST_TIMESTAMP,
      version: TOKEN_LIST_VERSION,
      logoURI: logoUri,
      keywords: ["sentineleth", "senti", "mining", chainName.toLowerCase()],
      tags: tokenListTags,
      tokens: [
        {
          chainId,
          address: sentiToken,
          name: "Sentinel Mining Token",
          symbol: "SENTI",
          decimals: 18,
          logoURI: logoUri,
          tags,
        },
      ],
    },
    {
      headers: responseHeaders(),
    },
  )
}