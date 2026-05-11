"use client"

import { useAccount, useBalance } from "wagmi"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import { formatUnits } from "viem"
import { ethChain } from "@/lib/chain"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export function WalletConnect() {
  const { address, isConnected, chain } = useAccount()

  const { data: balance } = useBalance({
    address,
    chainId: ethChain.id,
    query: { enabled: !!address },
  })

  const isWrongChain = isConnected && chain?.id !== ethChain.id

  const formattedBalance = balance
    ? `${Number(formatUnits(balance.value, balance.decimals)).toFixed(4)} ${balance.symbol}`
    : "..."

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Connect Wallet</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <ConnectButton showBalance={false} />
        {isConnected && !isWrongChain && (
          <p className="text-sm text-muted-foreground">
            Balance:{" "}
            <span className="font-medium text-foreground">{formattedBalance}</span>
          </p>
        )}
      </CardContent>
    </Card>
  )
}
