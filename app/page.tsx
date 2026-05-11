"use client"

import Link from "next/link"
import { motion } from "framer-motion"
import { CircuitBackground } from "@/components/CircuitBackground"
import { Card, CardContent } from "@/components/ui/card"
import { CountCycle } from "@/components/CountCycle"
import { MintPhaseStatus } from "@/components/MintPhaseStatus"

const codeSnippets = [
  { code: "exec(agent_001);", x: "5%", y: "18%", delay: 0 },
  { code: "verify_chain_block();", x: "3%", y: "28%", delay: 0.4 },
  { code: "return agent_status();", x: "78%", y: "22%", delay: 0.8 },
  { code: "mint(sentinel, traits);", x: "80%", y: "72%", delay: 1.2 },
  { code: "// network_context", x: "6%", y: "75%", delay: 1.6 },
]

export default function Home() {
  const features: {
    title: string
    desc: React.ReactNode
    icon: string
    extra?: React.ReactNode
  }[] = [
    {
      title: "Innovative Minting Experience",
      desc: "Mint directly through Claude AI using our MCP server — a first-of-its-kind agentic minting flow where your AI assistant handles the on-chain transaction for you.",
      icon: "\uD83E\uDDE0",
      extra: (
        <Link
          href="/how-to-mint"
          className="inline-block mt-4 text-[10px] sm:text-[11px] font-pixel tracking-wider text-sentinel hover:underline"
        >
          HOW TO MINT \u2192
        </Link>
      ),
    },
    {
      title: "Forever On Chain",
      desc: (
        <>
          Your agent lives forever on{" "}
          <a
            href="https://ethereum.org"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sentinel hover:underline"
          >
            ETHEREUM
          </a>{" "}
          and{" "}
          <a
            href="https://docs.irys.xyz/foundations/introduction"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sentinel hover:underline"
          >
            IRYS
          </a>
          . Token logic is secured by Ethereum, while artwork and metadata are
          permanently stored on Irys — no IPFS pinning, no broken links, no
          rug-pulled assets.
        </>
      ),
      icon: "\u267E\uFE0F",
    },
    {
      title: "Metadata Is the Soul",
      desc: (
        <>
          Your metadata is a core part of your NFT — every Sentinel carries a
          unique trait set, deterministic seed, and on-chain provenance that
          shape how your agent thinks, looks, and behaves.
        </>
      ),
      icon: "\uD83D\uDC41\uFE0F",
    },
  ]

  return (
    <>
      <CircuitBackground />

      <main className="relative z-10">
        {/* Hero */}
        <section className="container mx-auto max-w-6xl px-4 pt-12 sm:pt-20 pb-12 sm:pb-16 text-center">
          {/* Floating code snippets */}
          {codeSnippets.map((s, i) => (
            <motion.div
              key={i}
              className="absolute hidden lg:block text-[8px] text-sentinel/20 select-none pointer-events-none"
              style={{ left: s.x, top: s.y }}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: [0, -6, 0] }}
              transition={{
                opacity: { delay: s.delay, duration: 0.8 },
                y: { delay: s.delay, duration: 4, repeat: Infinity, ease: "easeInOut" },
              }}
            >
              {s.code}
            </motion.div>
          ))}

          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8 }}
          >
            <h1 className="font-pixel text-2xl sm:text-3xl text-sentinel animate-text-glow leading-tight">
              SENTINEL
            </h1>
            <p className="font-pixel text-[7px] sm:text-[9px] text-muted-foreground mt-3 tracking-widest">
              FIRST AGENTIC COLLECTION ON ETHEREUM
            </p>
            <p className="font-pixel text-[7px] sm:text-[9px] text-white mt-2 tracking-widest">
              TOTAL SUPPLY = <span className="text-sentinel"><CountCycle target={10000} /></span>
            </p>
          </motion.div>

          {/* Phase-aware CTA: badge, progress, scarcity warning, mint/claim button. */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.6, duration: 0.6 }}
          >
            <MintPhaseStatus />
          </motion.div>
        </section>

        {/* Features */}
        <section className="container mx-auto max-w-6xl px-4 pb-20">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {features.map((f, i) => (
              <motion.div
                key={f.title}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.8 + i * 0.15, duration: 0.5 }}
              >
                <Card className="sentinel-card border-sentinel/10 bg-card/60 backdrop-blur-sm h-full">
                  <CardContent className="pt-7 px-6 pb-6 sm:pt-8 sm:px-7 sm:pb-7">
                    <span className="text-3xl sm:text-4xl">{f.icon}</span>
                    <h3 className="text-xs sm:text-sm font-bold mt-4 text-foreground leading-snug break-words">
                      {f.title}
                    </h3>
                    <p className="text-[11px] sm:text-xs text-muted-foreground mt-3 leading-relaxed break-words">
                      {f.desc}
                    </p>
                    {f.extra}
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        </section>
      </main>
    </>
  )
}
