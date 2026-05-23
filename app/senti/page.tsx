import type { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = {
  title: "$SENTI | SentinelETH",
  description:
    "Public explainer for the SENTI mining token, its fixed supply, mining loop, and Uniswap liquidity model.",
}

const signalCards = [
  {
    label: "Hard cap",
    value: "1B",
    detail: "Fixed on-chain. SENTI cannot mint past the cap.",
  },
  {
    label: "Block reward",
    value: "5,950",
    detail: "Each rewarded round mints 5,950 SENTI, with the final round reduced if needed.",
  },
  {
    label: "Hook fee",
    value: "15%",
    detail: "Charged on the ETH side of Uniswap v4 buys and sells.",
  },
  {
    label: "Claim tax",
    value: "0%",
    detail: "Claims are not taxed. Users pay only normal gas.",
  },
]

const allocationCards = [
  {
    bucket: "Mineable",
    amount: "599.8M",
    share: "59.98%",
    description: "Distributed through rewarded mining rounds instead of a time-based drip.",
  },
  {
    bucket: "Initial LP seed",
    amount: "200K",
    share: "0.02%",
    description: "Used to create the first SENTI/ETH Uniswap v4 position.",
  },
  {
    bucket: "LP manager reserve",
    amount: "100M",
    share: "10%",
    description: "Held by SentiLiquidityManager to pair with collected ETH fees for LP growth.",
  },
  {
    bucket: "AI-agent reserve",
    amount: "300M",
    share: "30%",
    description: "Reserved for the later AI-agent mining lane. It is fixed but not active in v1.",
  },
]

const miningSteps = [
  {
    id: "01",
    title: "Enter the live mining session",
    body:
      "A wallet needs at least one SentinelETH NFT, must connect to /mine, clear the warmup, and stay present through periodic anti-bot checks.",
  },
  {
    id: "02",
    title: "Wallet power is calculated",
    body:
      "Each NFT is scored from its live metadata using the finalized trait tiers, layer weights, and synergy rules. Wallet power is the sum of all eligible NFTs held by that wallet.",
  },
  {
    id: "03",
    title: "One winner is selected per rewarded round",
    body:
      "Higher wallet power improves your odds, but every rewarded round is still its own draw. Power tilts probability. It does not guarantee a win.",
  },
  {
    id: "04",
    title: "Winner claims on-chain",
    body:
      "The winner submits the claim transaction and receives SENTI directly. There is no claim-time tax and no hidden deduction from the reward itself.",
  },
]

const guardrails = [
  {
    title: "ERC-20 stays clean",
    text:
      "SENTI itself has no transfer tax. The secondary-market fee lives in the Uniswap v4 hook instead of inside the token contract.",
  },
  {
    title: "Minter handoff is one-way",
    text:
      "Bootstrap minting exists only to seed the reserve. After that, mint authority is transferred to PatrolMiner and locked there.",
  },
  {
    title: "Reserve controls stay scoped",
    text:
      "Reserve burns are limited to manager-controlled inventory. There is no arbitrary admin burn over user wallets.",
  },
]

export default function SentiPage() {
  return (
    <main className="relative overflow-hidden bg-background text-foreground">
      <div className="absolute inset-x-0 top-0 h-[42rem] bg-[radial-gradient(circle_at_top_left,rgba(0,255,157,0.18),transparent_32%),radial-gradient(circle_at_top_right,rgba(53,201,255,0.14),transparent_26%),linear-gradient(180deg,rgba(2,8,7,0.85),rgba(3,3,5,0))]" />
      <div className="absolute left-[-6rem] top-28 h-64 w-64 rounded-full bg-sentinel/10 blur-3xl" />
      <div className="absolute right-[-4rem] top-44 h-56 w-56 rounded-full bg-cyan-400/10 blur-3xl" />

      <div className="relative mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8 lg:py-20">
        <section className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_22rem]">
          <div className="overflow-hidden rounded-[2rem] border border-white/10 bg-black/45 p-6 shadow-[0_0_80px_rgba(0,255,157,0.08)] backdrop-blur-md sm:p-8 lg:p-10">
            <div className="flex flex-wrap items-center gap-3 text-[0.68rem] uppercase tracking-[0.28em] text-sentinel/80">
              <span className="rounded-full border border-sentinel/30 px-3 py-1">SentinelETH field brief</span>
              <span className="rounded-full border border-white/10 px-3 py-1 text-white/60">Public explainer</span>
            </div>

            <div className="mt-8 grid gap-8 xl:grid-cols-[minmax(0,1fr)_14rem]">
              <div>
                <p className="font-pixel text-[0.72rem] tracking-[0.35em] text-sentinel/70">Mining token</p>
                <h1 className="mt-4 font-pixel text-5xl leading-none text-white sm:text-6xl lg:text-[6.2rem]">
                  SENTI
                </h1>
                <p className="mt-6 max-w-2xl text-sm leading-7 text-white/78 sm:text-base">
                  SENTI is the mining token for SentinelETH. Holders of SentinelETH NFTs can put
                  their wallets into the mining loop, compete with power weighted by traits, and
                  claim rewards directly on-chain. The token supply is fixed, the transfer layer
                  stays clean, and the market design routes trading fees into protocol-owned
                  liquidity growth instead of taxing claims.
                </p>

                <div className="mt-8 flex flex-wrap gap-3">
                  <Link
                    href="/mine"
                    className="inline-flex items-center justify-center rounded-full border border-sentinel bg-sentinel px-5 py-3 font-pixel text-xs tracking-[0.22em] text-black transition-all hover:shadow-[0_0_30px_rgba(0,255,157,0.35)]"
                  >
                    Open Mine
                  </Link>
                  <a
                    href="https://x.com/SentinelETH_"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center rounded-full border border-white/15 px-5 py-3 font-pixel text-xs tracking-[0.22em] text-white/70 transition-colors hover:border-sentinel/40 hover:text-sentinel"
                  >
                    Follow Updates
                  </a>
                </div>
              </div>

              <div className="rounded-[1.5rem] border border-white/10 bg-white/[0.03] p-5">
                <p className="font-pixel text-[0.68rem] tracking-[0.28em] text-white/45">Design intent</p>
                <div className="mt-5 space-y-5 text-sm leading-6 text-white/70">
                  <div>
                    <p className="font-pixel text-xs tracking-[0.22em] text-sentinel">No transfer tax</p>
                    <p className="mt-2">SENTI remains ERC-20 clean so wallets, explorers, and market tooling do not need special handling.</p>
                  </div>
                  <div>
                    <p className="font-pixel text-xs tracking-[0.22em] text-sentinel">Fixed allocations</p>
                    <p className="mt-2">The main buckets are decided up front: mining, LP seed, manager reserve, and AI-agent reserve.</p>
                  </div>
                  <div>
                    <p className="font-pixel text-xs tracking-[0.22em] text-sentinel">Fee feeds liquidity</p>
                    <p className="mt-2">Secondary-market ETH fees accumulate beside the 100M reserve and can later be paired into protocol-owned LP.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="grid gap-4">
            {signalCards.map((card) => (
              <article
                key={card.label}
                className="rounded-[1.5rem] border border-white/10 bg-black/35 p-5 backdrop-blur-md"
              >
                <p className="font-pixel text-[0.64rem] tracking-[0.24em] text-white/45">{card.label}</p>
                <p className="mt-4 font-pixel text-3xl text-sentinel">{card.value}</p>
                <p className="mt-3 text-sm leading-6 text-white/68">{card.detail}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="mt-10 grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <div className="rounded-[2rem] border border-white/10 bg-white/[0.03] p-6">
            <p className="font-pixel text-[0.68rem] tracking-[0.28em] text-sentinel/80">Locked supply</p>
            <h2 className="mt-5 font-pixel text-3xl leading-tight text-white sm:text-4xl">
              Four buckets. One cap. No floating token math.
            </h2>
            <p className="mt-5 text-sm leading-7 text-white/70">
              SENTI is capped at one billion total supply. The split below is the public frame for
              v1, with the 100M manager reserve and 300M AI-agent reserve both set aside as fixed
              allocations instead of open-ended mint authority.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {allocationCards.map((card) => (
              <article
                key={card.bucket}
                className="group rounded-[1.75rem] border border-white/10 bg-black/35 p-5 transition-all hover:-translate-y-1 hover:border-sentinel/30 hover:shadow-[0_0_32px_rgba(0,255,157,0.08)]"
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="font-pixel text-[0.7rem] tracking-[0.22em] text-white/55">{card.bucket}</p>
                  <span className="rounded-full border border-white/10 px-2 py-1 font-mono text-[0.68rem] text-white/45">
                    {card.share}
                  </span>
                </div>
                <p className="mt-6 font-pixel text-4xl text-sentinel">{card.amount}</p>
                <p className="mt-4 text-sm leading-6 text-white/68">{card.description}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="mt-10 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.92fr)]">
          <article className="rounded-[2rem] border border-white/10 bg-black/35 p-6 backdrop-blur-md sm:p-8">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-pixel text-[0.68rem] tracking-[0.28em] text-sentinel/80">Mining loop</p>
                <h2 className="mt-4 font-pixel text-3xl leading-tight text-white sm:text-4xl">
                  Power comes from the NFTs. Rewards go to the wallet.
                </h2>
              </div>
              <div className="rounded-full border border-sentinel/30 px-3 py-1 font-mono text-[0.72rem] text-sentinel/80">
                100,807 rewarded rounds max
              </div>
            </div>

            <div className="mt-8 grid gap-5">
              {miningSteps.map((step) => (
                <div
                  key={step.id}
                  className="grid gap-3 rounded-[1.5rem] border border-white/10 bg-white/[0.02] p-4 sm:grid-cols-[4.5rem_minmax(0,1fr)] sm:p-5"
                >
                  <div className="font-pixel text-2xl text-sentinel">{step.id}</div>
                  <div>
                    <h3 className="font-pixel text-lg text-white">{step.title}</h3>
                    <p className="mt-3 text-sm leading-7 text-white/70">{step.body}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-8 rounded-[1.5rem] border border-sentinel/20 bg-sentinel/10 p-5">
              <p className="font-pixel text-[0.68rem] tracking-[0.26em] text-sentinel">Reward logic</p>
              <p className="mt-3 text-sm leading-7 text-white/78">
                A rewarded round mints 5,950 SENTI to the winner. If a round is missed, skipped, or
                never successfully claimed, that unminted amount does not disappear. It stays inside
                the mineable allocation for later rewarded rounds until the locked mining bucket is
                exhausted.
              </p>
            </div>
          </article>

          <div className="grid gap-6">
            <article className="rounded-[2rem] border border-white/10 bg-black/35 p-6 backdrop-blur-md sm:p-8">
              <p className="font-pixel text-[0.68rem] tracking-[0.28em] text-sentinel/80">Trading and liquidity</p>
              <h2 className="mt-4 font-pixel text-3xl leading-tight text-white sm:text-4xl">
                The market fee lives on the ETH side, not inside the token.
              </h2>
              <div className="mt-8 space-y-5 text-sm leading-7 text-white/70">
                <p>
                  On a buy, 15% of the user&apos;s ETH input is diverted before the swap and the
                  remaining 85% executes the purchase.
                </p>
                <p>
                  On a sell, the swap computes the gross ETH output first, then 15% of that ETH is
                  diverted and the user receives the remaining 85%.
                </p>
                <p>
                  That ETH is routed to SentiLiquidityManager, the same address that holds the
                  pre-minted 100M reserve. Collected ETH can later be paired with reserve SENTI to
                  deepen protocol-owned liquidity.
                </p>
                <p>
                  The v1 trading surface is the official Uniswap app. SENTI does not rely on a
                  permanent custom in-site swap page.
                </p>
              </div>
            </article>

            <article className="rounded-[2rem] border border-white/10 bg-[linear-gradient(135deg,rgba(0,255,157,0.1),rgba(255,255,255,0.03))] p-6 sm:p-8">
              <p className="font-pixel text-[0.68rem] tracking-[0.28em] text-white/60">What users pay</p>
              <div className="mt-6 grid gap-4 sm:grid-cols-2">
                <div className="rounded-[1.25rem] border border-white/10 bg-black/35 p-4">
                  <p className="font-pixel text-xs tracking-[0.22em] text-sentinel">Mining claim</p>
                  <p className="mt-3 text-sm leading-6 text-white/70">Gas only. No extra SENTI tax. No extra ETH tax on the claim path.</p>
                </div>
                <div className="rounded-[1.25rem] border border-white/10 bg-black/35 p-4">
                  <p className="font-pixel text-xs tracking-[0.22em] text-sentinel">Secondary trade</p>
                  <p className="mt-3 text-sm leading-6 text-white/70">15% on the ETH side of the trade, routed to liquidity growth through the manager.</p>
                </div>
              </div>
            </article>
          </div>
        </section>

        <section className="mt-10 grid gap-4 lg:grid-cols-3">
          {guardrails.map((item) => (
            <article
              key={item.title}
              className="rounded-[1.75rem] border border-white/10 bg-black/35 p-6 backdrop-blur-md"
            >
              <p className="font-pixel text-sm tracking-[0.22em] text-sentinel">{item.title}</p>
              <p className="mt-4 text-sm leading-7 text-white/70">{item.text}</p>
            </article>
          ))}
        </section>

        <section className="mt-10 rounded-[2rem] border border-white/10 bg-white/[0.03] p-6 sm:p-8 lg:p-10">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
            <div>
              <p className="font-pixel text-[0.68rem] tracking-[0.28em] text-sentinel/80">Bottom line</p>
              <h2 className="mt-4 font-pixel text-3xl leading-tight text-white sm:text-4xl">
                SENTI is a fixed-supply mining token with protocol-owned liquidity growth built into
                the market path.
              </h2>
            </div>

            <div className="space-y-4 text-sm leading-7 text-white/72">
              <p>
                The core public promises are simple: a hard cap, a visible allocation split, a clean
                ERC-20 transfer layer, NFT-powered mining, no claim tax, and a market fee that is
                routed into the manager instead of hidden in the token contract itself.
              </p>
              <p>
                This page is the public summary. If parts feel too dense after your read-through, we
                can trim the wording without changing the underlying mechanics.
              </p>
            </div>
          </div>
        </section>
      </div>
    </main>
  )
}