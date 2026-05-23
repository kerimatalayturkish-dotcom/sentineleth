import Link from "next/link"
import { FileText, X as XIcon } from "lucide-react"
import { explorerAddress } from "@/lib/chain"

export function Footer() {
  const contract = process.env.NEXT_PUBLIC_NFT_CONTRACT_ADDRESS
  return (
    <footer className="border-t border-sentinel/10 py-6 mt-12">
      <div className="container mx-auto max-w-6xl px-4 flex flex-col items-start gap-4 text-[7px] text-muted-foreground sm:flex-row sm:items-end sm:justify-between">
        <div className="flex items-center gap-2">
          <a
            href="https://x.com/SentinelETH_"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="SentinelETH on X"
            title="SentinelETH on X"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-sentinel/20 bg-white/[0.02] text-muted-foreground transition-all hover:border-sentinel hover:text-sentinel hover:shadow-[0_0_20px_rgba(0,255,157,0.18)]"
          >
            <XIcon className="h-3.5 w-3.5" />
          </a>
          <Link
            href="/senti"
            aria-label="Open the SENTI explainer"
            title="Open the SENTI explainer"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-sentinel/20 bg-white/[0.02] text-muted-foreground transition-all hover:border-sentinel hover:text-sentinel hover:shadow-[0_0_20px_rgba(0,255,157,0.18)]"
          >
            <FileText className="h-3.5 w-3.5" />
          </Link>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <span className="font-pixel text-[6px] tracking-wider text-sentinel/60">
            SENTINEL_ETH
          </span>
          {contract && (
            <a
              href={explorerAddress(contract)}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-sentinel transition-colors"
            >
              Etherscan
            </a>
          )}
          <a
            href="https://ethereum.org"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-sentinel transition-colors"
          >
            Ethereum
          </a>
        </div>
      </div>
    </footer>
  )
}
