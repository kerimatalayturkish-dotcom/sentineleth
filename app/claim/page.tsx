import Link from "next/link"

export const metadata = {
  title: "Airdrop Claim — SentinelETH",
  description:
    "Claim your SentinelETH airdrop. Open after the public mint sells out.",
}

export default function ClaimPage() {
  return (
    <main className="container mx-auto max-w-3xl p-4 sm:p-6">
      <header className="mb-8">
        <h1 className="font-pixel text-base sm:text-lg text-sentinel animate-text-glow">
          AIRDROP CLAIM
        </h1>
        <p className="mt-2 text-[10px] text-muted-foreground">
          {"// 1,707 Sentinels reserved for eligible TEMPO holders."}
        </p>
      </header>

      <section className="space-y-6 text-[11px] sm:text-xs leading-relaxed text-muted-foreground">
        <div className="border border-sentinel/20 rounded-md p-4 bg-card/40">
          <p className="text-sentinel font-bold mb-2">Coming soon</p>
          <p>
            The airdrop claim opens once the public mint reaches its cap
            (8,293 / 10,000). Eligible wallets (verified on TEMPO) will be
            able to connect here, prove ownership via Merkle proof, and mint
            their reserved Sentinel directly to the same address.
          </p>
        </div>

        <div>
          <p className="text-foreground mb-2">What to expect when it opens:</p>
          <ul className="list-disc list-inside space-y-1">
            <li>Connect the same wallet you hold your TEMPO NFT in.</li>
            <li>The site checks your eligibility against the on-chain Merkle root.</li>
            <li>If eligible, click <span className="text-sentinel">Claim</span> &mdash; you pay only gas, no mint price.</li>
            <li>
              Your Sentinel arrives in the same wallet and shows up under{" "}
              <Link href="/my-holdings" className="text-sentinel underline">
                My Holdings
              </Link>
              .
            </li>
          </ul>
        </div>

        <div>
          <p className="text-foreground mb-2">In the meantime:</p>
          <ul className="list-disc list-inside space-y-1">
            <li>
              Public mint is still active &mdash; see the{" "}
              <Link href="/" className="text-sentinel underline">
                home page
              </Link>{" "}
              for current phase and supply.
            </li>
            <li>
              Browse what&apos;s been minted on the{" "}
              <Link href="/collection" className="text-sentinel underline">
                Collection
              </Link>{" "}
              page.
            </li>
          </ul>
        </div>
      </section>
    </main>
  )
}
