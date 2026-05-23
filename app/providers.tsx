"use client"

import { WagmiProvider, http, createConfig, createStorage, noopStorage } from "wagmi"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  connectorsForWallets,
  RainbowKitProvider,
  darkTheme,
} from "@rainbow-me/rainbowkit"
import { injectedWallet, okxWallet, metaMaskWallet, walletConnectWallet } from "@rainbow-me/rainbowkit/wallets"
import "@rainbow-me/rainbowkit/styles.css"
import { ethChain } from "@/lib/chain"
import { miningChain, miningPublicConfig } from "@/lib/mining-config"
import { useState } from "react"

const APP_NAME = "SentinelETH"
const INJECTED_ONLY_PROJECT_ID = "injected-only"

function getWalletConnectProjectId() {
  const projectId = process.env.NEXT_PUBLIC_WC_PROJECT_ID?.trim()
  if (!projectId || projectId.toUpperCase() === "PLACEHOLDER") {
    return null
  }
  return projectId
}

function makeConnectors() {
  const projectId = getWalletConnectProjectId()

  if (!projectId) {
    return connectorsForWallets(
      [
        {
          groupName: "Browser Wallet",
          wallets: [injectedWallet],
        },
      ],
      {
        appName: APP_NAME,
        projectId: INJECTED_ONLY_PROJECT_ID,
      },
    )
  }

  return connectorsForWallets(
    [
      {
        groupName: "Recommended",
        wallets: [okxWallet, metaMaskWallet, walletConnectWallet],
      },
    ],
    {
      appName: APP_NAME,
      projectId,
    },
  )
}

function makeConfig() {
  const connectors = makeConnectors()
  const prefersMiningChain = miningPublicConfig.deployment === "testnet"
  const primaryChain = prefersMiningChain ? miningChain : ethChain
  const secondaryChain = primaryChain.id === miningChain.id ? ethChain : miningChain
  const chains = primaryChain.id === secondaryChain.id
    ? [primaryChain] as const
    : [primaryChain, secondaryChain] as const
  const transports = {
    [ethChain.id]: http(process.env.NEXT_PUBLIC_ETH_RPC_URL),
    [miningChain.id]: http(process.env.NEXT_PUBLIC_MINING_RPC_URL),
  }

  return createConfig({
    connectors,
    chains,
    transports,
    ssr: true,
    storage: createStorage({
      storage: typeof window !== "undefined" ? window.localStorage : noopStorage,
    }),
  })
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [config] = useState(() => makeConfig())
  const [queryClient] = useState(() => new QueryClient())

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={darkTheme({
            accentColor: "#ff2d2d",
            accentColorForeground: "#ffffff",
            borderRadius: "small",
            fontStack: "system",
            overlayBlur: "small",
          })}
          modalSize="compact"
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
