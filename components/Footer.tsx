import { explorerAddress } from "@/lib/chain"

export function Footer() {
  const contract = process.env.NEXT_PUBLIC_NFT_CONTRACT_ADDRESS
  return (
    <footer className="border-t border-sentinel/10 py-6 mt-12">
      <div className="container mx-auto max-w-6xl px-4 flex flex-col sm:flex-row items-center justify-between gap-4 text-[7px] text-muted-foreground">
        <span className="font-pixel text-[6px] tracking-wider text-sentinel/60">
          SENTINEL_ETH
        </span>
        <div className="flex items-center gap-4">
          <a
            href="https://x.com"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-sentinel transition-colors"
          >
            𝕏
          </a>
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
