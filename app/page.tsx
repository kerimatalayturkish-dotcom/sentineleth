"use client"

import Link from "next/link"
import { useEffect, useState, type FocusEvent } from "react"
import { motion } from "framer-motion"
import { CircuitCubesBackground } from "@/components/CircuitCubesBackground"
import { CountCycle } from "@/components/CountCycle"
import { MintPhaseStatus } from "@/components/MintPhaseStatus"

type FeatureKind = "brain" | "chain" | "eye"
type FeatureReveal = "hover" | "always"

type FeatureBodySegment =
  | {
      type: "text"
      value: string
    }
  | {
      type: "link"
      value: string
      href: string
    }

type FeatureItem = {
  title: string
  body: FeatureBodySegment[]
  kind: FeatureKind
  reveal: FeatureReveal
  cta?: {
    href: string
    label: string
  }
}

type FlowStepItem = {
  step: string
  title: string
  description: string
  href: string
  ctaLabel: string
}

const HERO_SUBTITLE = "FIRST AGENTIC COLLECTION ON ETHEREUM"

const FEATURES: FeatureItem[] = [
  {
    title: "Innovative Minting Experience",
    body: [
      {
        type: "text",
        value:
          "Mint directly through Claude AI using our MCP server - a first-of-its-kind agentic minting flow where your AI assistant handles the on-chain transaction for you.",
      },
    ],
    kind: "brain",
    reveal: "hover",
    cta: {
      href: "/how-to-mint",
      label: "HOW TO MINT ->",
    },
  },
  {
    title: "Forever On Chain",
    body: [
      {
        type: "text",
        value: "Your agent lives forever on ",
      },
      {
        type: "link",
        value: "ETHEREUM",
        href: "https://ethereum.org",
      },
      {
        type: "text",
        value: " and ",
      },
      {
        type: "link",
        value: "IRYS",
        href: "https://docs.irys.xyz/foundations/introduction",
      },
      {
        type: "text",
        value:
          ". Token logic is secured by Ethereum, while artwork and metadata stay permanently stored on Irys - no pinning, no broken links, no rug-pulled assets.",
      },
    ],
    kind: "chain",
    reveal: "hover",
  },
  {
    title: "Metadata Is the Soul",
    body: [
      {
        type: "text",
        value:
          "Your metadata is a core part of your NFT - every Sentinel carries a unique trait set, deterministic seed, and on-chain provenance that shape how your agent thinks, looks, and behaves.",
      },
    ],
    kind: "eye",
    reveal: "hover",
  },
]

const FLOW_STEPS: FlowStepItem[] = [
  {
    step: "01",
    title: "Mint",
    description: "Mint using the How to Mint instructions and follow the guided steps to complete the claim flow.",
    href: "/how-to-mint",
    ctaLabel: "HOW TO MINT",
  },
  {
    step: "02",
    title: "Verify",
    description: "Once minted, open My Holdings to inspect your NFT, its metadata, and the full on-chain identity you just created.",
    href: "/my-holdings",
    ctaLabel: "MY HOLDINGS",
  },
  {
    step: "03",
    title: "Mine",
    description: "Then move to the Mine page, start the session, and put your Sentinel into the mining loop.",
    href: "/mine",
    ctaLabel: "ENTER MINE",
  },
]

function getBodyLength(segments: FeatureBodySegment[]) {
  return segments.reduce((total, segment) => total + segment.value.length, 0)
}

function getVisibleBodySegments(segments: FeatureBodySegment[], visibleCount?: number) {
  let remaining = visibleCount ?? Number.POSITIVE_INFINITY
  const visibleSegments: Array<{ segment: FeatureBodySegment; content: string }> = []

  for (const segment of segments) {
    if (remaining <= 0) break

    const visibleChars = Math.min(segment.value.length, remaining)
    if (visibleChars > 0) {
      visibleSegments.push({
        segment,
        content: segment.value.slice(0, visibleChars),
      })
      remaining -= visibleChars
    }
  }

  return visibleSegments
}

function BodySegments({
  segments,
  visibleCount,
}: {
  segments: FeatureBodySegment[]
  visibleCount?: number
}) {
  const visibleSegments = getVisibleBodySegments(segments, visibleCount)

  return (
    <>
      {visibleSegments.map(({ segment, content }, index) => {
        if (segment.type === "link") {
          return (
            <a
              key={`${segment.href}-${index}`}
              href={segment.href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sentinel transition-opacity hover:opacity-80"
            >
              {content}
            </a>
          )
        }

        return <span key={`${segment.type}-${index}`}>{content}</span>
      })}
    </>
  )
}

function useSupportsHover() {
  const [supportsHover, setSupportsHover] = useState<boolean | null>(null)

  useEffect(() => {
    const mediaQuery = window.matchMedia("(hover: hover) and (pointer: fine)")
    const updateHoverSupport = () => setSupportsHover(mediaQuery.matches)

    updateHoverSupport()
    mediaQuery.addEventListener?.("change", updateHoverSupport)

    return () => {
      mediaQuery.removeEventListener?.("change", updateHoverSupport)
    }
  }, [])

  return supportsHover
}

function TypeCycle({
  text,
  typeStepMs = 55,
  holdMs = 1600,
  deleteStepMs = 24,
}: {
  text: string
  typeStepMs?: number
  holdMs?: number
  deleteStepMs?: number
}) {
  const [visibleCount, setVisibleCount] = useState(0)
  const [isDeleting, setIsDeleting] = useState(false)

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      if (!isDeleting && visibleCount < text.length) {
        setVisibleCount((current) => current + 1)
        return
      }

      if (!isDeleting && visibleCount === text.length) {
        setIsDeleting(true)
        return
      }

      if (isDeleting && visibleCount > 0) {
        setVisibleCount((current) => current - 1)
        return
      }

      setIsDeleting(false)
    }, !isDeleting && visibleCount === text.length ? holdMs : isDeleting ? deleteStepMs : typeStepMs)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [deleteStepMs, holdMs, isDeleting, text.length, typeStepMs, visibleCount])

  return (
    <>
      {text.slice(0, visibleCount)}
      <span
        className={`ml-1 inline-block h-[0.9em] w-px align-[-0.12em] ${isDeleting || visibleCount < text.length ? "animate-pulse bg-current opacity-100" : "bg-current opacity-80"}`}
      />
    </>
  )
}

function TypingBody({ segments, active }: { segments: FeatureBodySegment[]; active: boolean }) {
  const [visibleCount, setVisibleCount] = useState(0)
  const totalLength = getBodyLength(segments)

  useEffect(() => {
    if (!active) {
      return
    }

    let nextCount = 0

    const intervalId = window.setInterval(() => {
      nextCount = Math.min(nextCount + 2, totalLength)
      setVisibleCount(nextCount)

      if (nextCount >= totalLength) {
        window.clearInterval(intervalId)
      }
    }, 18)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [active, totalLength])

  const showCaret = active && visibleCount < totalLength

  return (
    <p className="min-h-[8.5rem] whitespace-pre-wrap text-[11px] leading-relaxed text-[#a6cfc7] sm:min-h-[7.5rem] sm:text-xs">
      <BodySegments segments={segments} visibleCount={active ? visibleCount : 0} />
      <span
        className={`ml-0.5 inline-block h-[0.95em] w-px align-[-0.12em] ${showCaret ? "animate-pulse bg-[#c8fdff] opacity-100" : "bg-transparent opacity-0"}`}
      />
    </p>
  )
}

function BrainGlyph({ active }: { active: boolean }) {
  return (
    <svg
      viewBox="0 0 160 160"
      className={`h-36 w-36 sm:h-40 sm:w-40 ${active ? "opacity-100 drop-shadow-[0_0_22px_rgba(120,245,240,0.3)]" : "opacity-85 drop-shadow-[0_0_12px_rgba(70,180,170,0.18)]"}`}
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="brainGradient" x1="20" y1="20" x2="140" y2="140" gradientUnits="userSpaceOnUse">
          <stop stopColor="#d7ffff" />
          <stop offset="0.52" stopColor="#79e9df" />
          <stop offset="1" stopColor="#2d8f7e" />
        </linearGradient>
      </defs>
      <g stroke="url(#brainGradient)" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M80 30v98" opacity="0.7" />
        <path d="M78 30c-8-9-26-10-37 0C29 39 26 57 32 69c-10 9-12 25-4 37 8 13 24 18 38 13 8 11 24 13 34 5" />
        <path d="M82 30c8-9 26-10 37 0 12 9 15 27 9 39 10 9 12 25 4 37-8 13-24 18-38 13-8 11-24 13-34 5" />
        <path d="M58 50H40" />
        <path d="M53 74H28" />
        <path d="M58 98H36" />
        <path d="M102 50h18" />
        <path d="M107 74h25" />
        <path d="M102 98h22" />
        <path d="M63 55l10 10" />
        <path d="M97 55 87 65" />
        <path d="M62 103l10-11" />
        <path d="M98 103 88 92" />
      </g>
      <g fill="#d7ffff">
        <circle cx="40" cy="50" r="4.2" />
        <circle cx="28" cy="74" r="4.2" />
        <circle cx="36" cy="98" r="4.2" />
        <circle cx="120" cy="50" r="4.2" />
        <circle cx="132" cy="74" r="4.2" />
        <circle cx="124" cy="98" r="4.2" />
        <circle cx="80" cy="78" r="4.6" />
      </g>
    </svg>
  )
}

function BlockchainGlyph({ active }: { active: boolean }) {
  return (
    <svg
      viewBox="0 0 160 160"
      className={`h-36 w-36 sm:h-40 sm:w-40 ${active ? "opacity-100 drop-shadow-[0_0_22px_rgba(120,245,240,0.28)]" : "opacity-85 drop-shadow-[0_0_12px_rgba(70,180,170,0.18)]"}`}
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="chainGradient" x1="18" y1="28" x2="142" y2="126" gradientUnits="userSpaceOnUse">
          <stop stopColor="#d7ffff" />
          <stop offset="0.52" stopColor="#7ef6ee" />
          <stop offset="1" stopColor="#287e73" />
        </linearGradient>
      </defs>
      <g stroke="url(#chainGradient)" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
        <rect x="22" y="62" width="34" height="34" rx="5" />
        <rect x="63" y="27" width="34" height="34" rx="5" />
        <rect x="104" y="62" width="34" height="34" rx="5" />
        <path d="M56 79h14" />
        <path d="M90 79h14" />
        <path d="M80 61v14" />
        <path d="M80 83v14" />
        <path d="M39 70h10" />
        <path d="M39 88h10" />
        <path d="M112 70h10" />
        <path d="M112 88h10" />
        <path d="M72 36h16" />
        <path d="M72 52h16" />
      </g>
      <g fill="#d7ffff">
        <circle cx="56" cy="79" r="3.8" />
        <circle cx="80" cy="61" r="3.8" />
        <circle cx="104" cy="79" r="3.8" />
        <circle cx="80" cy="97" r="3.8" />
      </g>
    </svg>
  )
}

function EyeGlyph({ active }: { active: boolean }) {
  return (
    <svg
      viewBox="0 0 160 160"
      className={`h-36 w-36 sm:h-40 sm:w-40 ${active ? "opacity-100 drop-shadow-[0_0_22px_rgba(120,245,240,0.26)]" : "opacity-90 drop-shadow-[0_0_14px_rgba(70,180,170,0.2)]"}`}
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="eyeGradient" x1="16" y1="32" x2="144" y2="128" gradientUnits="userSpaceOnUse">
          <stop stopColor="#d7ffff" />
          <stop offset="0.5" stopColor="#8bf7ef" />
          <stop offset="1" stopColor="#23756b" />
        </linearGradient>
      </defs>
      <g stroke="url(#eyeGradient)" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 80 40 57l22-11h36l22 11 22 23-22 23-22 11H62L40 103 18 80Z" />
        <circle cx="80" cy="80" r="23" />
        <circle cx="80" cy="80" r="8" fill="#bffcff" />
        <path d="M80 34v14" />
        <path d="M80 112v14" />
        <path d="M45 59 34 48" />
        <path d="M115 59l11-11" />
        <path d="M45 101 34 112" />
        <path d="M115 101l11 11" />
        <path d="M57 80h46" opacity="0.75" />
      </g>
      <g fill="#d7ffff">
        <circle cx="34" cy="48" r="3.6" />
        <circle cx="126" cy="48" r="3.6" />
        <circle cx="34" cy="112" r="3.6" />
        <circle cx="126" cy="112" r="3.6" />
      </g>
    </svg>
  )
}

function FeatureGlyph({ kind, active }: { kind: FeatureKind; active: boolean }) {
  if (kind === "brain") {
    return <BrainGlyph active={active} />
  }

  if (kind === "chain") {
    return <BlockchainGlyph active={active} />
  }

  return <EyeGlyph active={active} />
}

function FeaturePanel({ feature }: { feature: FeatureItem }) {
  const supportsHover = useSupportsHover()
  const [isHovered, setIsHovered] = useState(false)

  const isActive = feature.reveal === "always" || supportsHover === false || isHovered

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setIsHovered(false)
    }
  }

  return (
    <div
      className="group flex h-full min-h-[25rem] flex-col items-center px-3 py-6 text-center outline-none sm:min-h-[23.5rem]"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onFocus={() => setIsHovered(true)}
      onBlur={handleBlur}
      tabIndex={feature.reveal === "hover" ? 0 : undefined}
    >
      <div className={`relative flex h-40 w-full items-center justify-center transition duration-300 ${isActive ? "scale-[1.02] opacity-100" : "opacity-90"}`}>
        <FeatureGlyph kind={feature.kind} active={isActive} />
      </div>
      <div className={`mt-2 h-px w-24 bg-gradient-to-r from-transparent ${isActive ? "via-[#8bf7ef]/80" : "via-[#235750]/60"} to-transparent transition-colors duration-300`} />
      <h3 className="mt-4 max-w-[18rem] text-xs font-bold leading-snug text-[#ecfffb] sm:text-sm">
        {feature.title}
      </h3>
      <div className="mt-4 flex w-full max-w-[22rem] flex-1 flex-col items-center justify-start">
        {feature.reveal === "hover" ? (
          <TypingBody key={isActive ? "active" : "inactive"} segments={feature.body} active={isActive} />
        ) : (
          <p className="min-h-[8.5rem] whitespace-pre-wrap text-[11px] leading-relaxed text-[#a6cfc7] sm:min-h-[7.5rem] sm:text-xs">
            <BodySegments segments={feature.body} />
          </p>
        )}

        <div className="mt-4 flex h-7 items-center justify-center sm:h-8">
          {feature.cta ? (
            <Link
              href={feature.cta.href}
              className={`inline-block text-[10px] font-pixel tracking-[0.25em] text-sentinel transition-opacity hover:opacity-80 sm:text-[11px] ${isActive ? "opacity-100" : "pointer-events-none opacity-0"}`}
            >
              {feature.cta.label}
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function FlowStepCard({ step }: { step: FlowStepItem }) {
  return (
    <div className="relative h-full rounded-[1.4rem] border border-[#6cecdf]/18 bg-[linear-gradient(180deg,rgba(8,27,24,0.92),rgba(2,10,9,0.76))] px-5 py-6 shadow-[0_0_28px_rgba(16,86,78,0.14)] backdrop-blur-sm">
      <div className="flex items-center justify-between gap-4">
        <span className="font-pixel text-[10px] tracking-[0.34em] text-sentinel/80">
          {step.step}
        </span>
        <div className="h-px flex-1 bg-gradient-to-r from-[#8bf7ef]/70 via-[#65c9bd]/25 to-transparent" />
      </div>
      <h3 className="mt-4 font-pixel text-base text-[#ecfffb] sm:text-lg">
        {step.title}
      </h3>
      <p className="mt-3 min-h-[4.8rem] text-xs leading-relaxed text-[#a6cfc7] sm:text-[13px]">
        {step.description}
      </p>
      <Link
        href={step.href}
        className="mt-5 inline-flex items-center gap-2 font-pixel text-[10px] tracking-[0.24em] text-sentinel transition-opacity hover:opacity-80 sm:text-[11px]"
      >
        {step.ctaLabel}
        <span aria-hidden="true">-&gt;</span>
      </Link>
    </div>
  )
}

export default function Home() {
  return (
    <>
      <CircuitCubesBackground />

      <main className="relative z-10">
        {/* Hero */}
        <section className="container mx-auto max-w-6xl px-4 pt-12 sm:pt-20 pb-12 sm:pb-16 text-center">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8 }}
          >
            <h1 className="font-pixel text-4xl sm:text-6xl text-sentinel animate-text-glow leading-tight">
              SENTINEL
            </h1>
            <p className="mx-auto mt-3 min-h-[2.4rem] max-w-[24rem] font-pixel text-[10px] text-muted-foreground tracking-widest sm:min-h-[1.5rem] sm:max-w-none sm:text-[14px]">
              <TypeCycle text={HERO_SUBTITLE} />
            </p>
            <p className="mt-2 font-pixel text-[10px] text-white tracking-widest sm:text-[14px]">
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
          <div className="space-y-12">
            <div className="relative overflow-hidden rounded-[1.8rem] border border-[#6cecdf]/10 bg-[radial-gradient(circle_at_top,rgba(78,255,159,0.08),transparent_58%),linear-gradient(180deg,rgba(6,18,17,0.92),rgba(3,9,9,0.7))] px-4 py-8 sm:px-6">
              <div className="text-center">
                <h2 className="font-pixel text-xl text-[#ecfffb] sm:text-2xl">The Flow</h2>
              </div>

              <div className="relative mt-8">
                <div className="pointer-events-none absolute left-[16.66%] right-[16.66%] top-5 hidden h-px bg-gradient-to-r from-transparent via-[#8bf7ef]/65 to-transparent md:block" />
                <div className="grid grid-cols-1 gap-4 md:grid-cols-3 md:gap-5">
                  {FLOW_STEPS.map((step, index) => (
                    <motion.div
                      key={step.title}
                      className="relative h-full"
                      initial={{ opacity: 0, y: 18 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.72 + index * 0.1, duration: 0.45 }}
                    >
                      <div className="pointer-events-none absolute left-1/2 top-5 hidden size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#c8fdff] shadow-[0_0_14px_rgba(139,247,239,0.9)] md:block" />
                      <FlowStepCard step={step} />
                    </motion.div>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-10 md:grid-cols-3 md:gap-8">
              {FEATURES.map((feature, index) => (
                <motion.div
                  key={feature.title}
                  className="h-full"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.8 + index * 0.15, duration: 0.5 }}
                >
                  <FeaturePanel feature={feature} />
                </motion.div>
              ))}
            </div>
          </div>
        </section>
      </main>
    </>
  )
}
