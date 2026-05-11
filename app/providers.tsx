"use client"

import { WagmiProvider, http, createConfig, createStorage, noopStorage } from "wagmi"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  connectorsForWallets,
  RainbowKitProvider,
  darkTheme,
} from "@rainbow-me/rainbowkit"
import { okxWallet, metaMaskWallet, walletConnectWallet } from "@rainbow-me/rainbowkit/wallets"
import "@rainbow-me/rainbowkit/styles.css"
import { ethChain } from "@/lib/chain"
import { useState } from "react"

const connectors = connectorsForWallets(
  [
    {
      groupName: "Recommended",
      wallets: [okxWallet, metaMaskWallet, walletConnectWallet],
    },
  ],
  {
    appName: "SentinelETH",
    projectId: process.env.NEXT_PUBLIC_WC_PROJECT_ID ?? "PLACEHOLDER",
  },
)

function makeConfig() {
  return createConfig({
    connectors,
    chains: [ethChain],
    transports: {
      [ethChain.id]: http(process.env.NEXT_PUBLIC_ETH_RPC_URL),
    },
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
