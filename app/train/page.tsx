"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useAccount } from "wagmi"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import { TRAIN_SKILL_MD } from "@/lib/train-skill"
import { CircuitBackground } from "@/components/CircuitBackground"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { fetchJson } from "@/lib/fetch-json"

interface TocEntry {
  id: string
  title: string
}

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/**
 * Lightweight markdown renderer — just the subset our skill doc uses:
 * h1/h2/h3, fenced code blocks, inline code, links, lists, blockquotes,
 * tables, paragraphs, horizontal rules.
 */
function renderMarkdown(md: string): { nodes: React.ReactNode[]; toc: TocEntry[] } {
  const lines = md.split("\n")
  const out: React.ReactNode[] = []
  const toc: TocEntry[] = []
  let i = 0
  let key = 0

  const renderInline = (text: string): React.ReactNode[] => {
    const parts: React.ReactNode[] = []
    let rest = text
    let k = 0
    // pattern: links [txt](url) or `code`
    const re = /\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*/
    while (rest.length) {
      const m = rest.match(re)
      if (!m) {
        parts.push(rest)
        break
      }
      if (m.index! > 0) parts.push(rest.slice(0, m.index))
      if (m[1]) {
        parts.push(
          <a
            key={`il-${k++}`}
            href={m[2]}
            target={m[2].startsWith("http") ? "_blank" : undefined}
            rel="noopener noreferrer"
            className="text-sentinel hover:underline break-all"
          >
            {m[1]}
          </a>,
        )
      } else if (m[3]) {
        parts.push(
          <code key={`ic-${k++}`} className="bg-muted/50 text-sentinel px-1 py-0.5 rounded text-[10px] break-all">
            {m[3]}
          </code>,
        )
      } else if (m[4]) {
        parts.push(
          <strong key={`ib-${k++}`} className="text-foreground font-semibold">
            {m[4]}
          </strong>,
        )
      }
      rest = rest.slice(m.index! + m[0].length)
    }
    return parts
  }

  while (i < lines.length) {
    const line = lines[i]

    // fenced code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim()
      const buf: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith("```")) {
        buf.push(lines[i])
        i++
      }
      i++ // skip closing fence
      const code = buf.join("\n")
      out.push(
        <CodeBlock key={key++} code={code} lang={lang} />,
      )
      continue
    }

    // headings
    const h = line.match(/^(#{1,3})\s+(.*)$/)
    if (h) {
      const level = h[1].length
      const title = h[2]
      const id = slugify(title)
      if (level === 2) toc.push({ id, title })
      const className =
        level === 1
          ? "font-pixel text-sentinel text-base sm:text-lg mt-2 mb-4 tracking-wider"
          : level === 2
          ? "font-pixel text-sentinel text-[11px] sm:text-xs mt-10 mb-3 tracking-wider scroll-mt-20"
          : "font-pixel text-foreground text-[10px] mt-6 mb-2 tracking-wider"
      const Tag = (level === 1 ? "h1" : level === 2 ? "h2" : "h3") as keyof React.JSX.IntrinsicElements
      out.push(
        <Tag key={key++} id={id} className={className}>
          {title}
        </Tag>,
      )
      i++
      continue
    }

    // horizontal rule
    if (line.trim() === "---") {
      out.push(<hr key={key++} className="my-8 border-sentinel/20" />)
      i++
      continue
    }

    // blockquote
    if (line.startsWith("> ")) {
      const buf: string[] = []
      while (i < lines.length && lines[i].startsWith("> ")) {
        buf.push(lines[i].slice(2))
        i++
      }
      out.push(
        <blockquote
          key={key++}
          className="border-l-2 border-sentinel/40 pl-4 my-4 text-[11px] text-muted-foreground italic break-words"
        >
          {renderInline(buf.join(" "))}
        </blockquote>,
      )
      continue
    }

    // unordered list
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ""))
        i++
      }
      out.push(
        <ul key={key++} className="list-disc list-outside ml-5 my-3 space-y-1 text-[11px] text-muted-foreground leading-relaxed break-words">
          {items.map((it, n) => (
            <li key={n}>{renderInline(it)}</li>
          ))}
        </ul>,
      )
      continue
    }

    // ordered list
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ""))
        i++
      }
      out.push(
        <ol key={key++} className="list-decimal list-outside ml-5 my-3 space-y-1 text-[11px] text-muted-foreground leading-relaxed break-words">
          {items.map((it, n) => (
            <li key={n}>{renderInline(it)}</li>
          ))}
        </ol>,
      )
      continue
    }

    // table
    if (line.startsWith("|") && lines[i + 1]?.startsWith("|")) {
      const buf: string[] = []
      while (i < lines.length && lines[i].startsWith("|")) {
        buf.push(lines[i])
        i++
      }
      const rows = buf.map((r) =>
        r
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim()),
      )
      const header = rows[0]
      const body = rows.slice(2) // skip the separator row
      out.push(
        <div key={key++} className="my-4 overflow-x-auto">
          <table className="w-full text-[10px] border border-sentinel/20">
            <thead>
              <tr className="bg-sentinel/5">
                {header.map((h, n) => (
                  <th key={n} className="text-left px-3 py-2 border-b border-sentinel/20 text-sentinel">
                    {renderInline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, n) => (
                <tr key={n} className="border-b border-sentinel/10">
                  {row.map((c, m) => (
                    <td key={m} className="px-3 py-2 text-muted-foreground align-top">
                      {renderInline(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }

    // blank line
    if (line.trim() === "") {
      i++
      continue
    }

    // paragraph (collect until blank)
    const buf: string[] = [line]
    i++
    while (i < lines.length && lines[i].trim() !== "" && !/^[-*#>]|^\d+\.\s|^```|^\|/.test(lines[i])) {
      buf.push(lines[i])
      i++
    }
    out.push(
      <p key={key++} className="text-[11px] text-muted-foreground leading-relaxed my-3 break-words">
        {renderInline(buf.join(" "))}
      </p>,
    )
  }

  return { nodes: out, toc }
}

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false)
  const onCopy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div className="relative my-4 group">
      <pre className="bg-black/60 border border-sentinel/20 rounded-md p-4 overflow-x-auto text-[10px] text-foreground leading-relaxed">
        <code>{code}</code>
      </pre>
      <button
        onClick={onCopy}
        className="absolute top-2 right-2 text-[8px] font-pixel px-2 py-1 rounded bg-black/80 border border-sentinel/30 text-sentinel hover:bg-sentinel/10 transition-colors"
        aria-label="Copy code"
      >
        {copied ? "COPIED" : "COPY"}
        {lang && !copied ? <span className="ml-2 text-muted-foreground">{lang}</span> : null}
      </button>
    </div>
  )
}

export default function TrainPage() {
  const { address, isConnected } = useAccount()
  const [holdingCount, setHoldingCount] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!address) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset on disconnect
      setHoldingCount(null)
      return
    }
    setLoading(true)
    setError("")
    fetchJson<{ count?: number }>(`/api/nft/my-holdings?address=${address}`)
      .then((data) => setHoldingCount(data.count ?? 0))
      .catch((err) => setError(err instanceof Error ? err.message : "Lookup failed"))
      .finally(() => setLoading(false))
  }, [address])

  // Gate 1 — wallet not connected
  if (!isConnected) {
    return (
      <>
        <CircuitBackground />
        <main className="relative z-10 container mx-auto max-w-2xl px-4 py-20">
          <Card className="sentinel-card border-sentinel/20 bg-card/60 backdrop-blur-sm">
            <CardContent className="py-12 flex flex-col items-center gap-5 text-center">
              <h1 className="font-pixel text-sentinel text-sm sm:text-base tracking-wider animate-text-glow">
                TRAIN YOUR AGENT
              </h1>
              <p className="text-[10px] text-muted-foreground max-w-md">
                This skill is reserved for Sentinel holders. Connect a wallet that holds at least one
                SentinelETH NFT to unlock the training material.
              </p>
              <ConnectButton />
            </CardContent>
          </Card>
        </main>
      </>
    )
  }

  // Gate 2 — checking holdings
  if (loading || holdingCount === null) {
    return (
      <>
        <CircuitBackground />
        <main className="relative z-10 container mx-auto max-w-2xl px-4 py-20">
          <Card className="sentinel-card border-sentinel/20 bg-card/60 backdrop-blur-sm">
            <CardContent className="py-12 text-center">
              <p className="text-[10px] text-muted-foreground">Verifying Sentinel ownership…</p>
            </CardContent>
          </Card>
        </main>
      </>
    )
  }

  // Gate 3 — error during lookup
  if (error) {
    return (
      <>
        <CircuitBackground />
        <main className="relative z-10 container mx-auto max-w-2xl px-4 py-20">
          <Card className="sentinel-card border-destructive/30 bg-destructive/5">
            <CardContent className="py-8 text-center">
              <p className="text-[10px] text-destructive">{error}</p>
            </CardContent>
          </Card>
        </main>
      </>
    )
  }

  // Gate 4 — connected but no Sentinel
  if (holdingCount === 0) {
    return (
      <>
        <CircuitBackground />
        <main className="relative z-10 container mx-auto max-w-2xl px-4 py-20">
          <Card className="sentinel-card border-sentinel/20 bg-card/60 backdrop-blur-sm">
            <CardContent className="py-12 flex flex-col items-center gap-5 text-center">
              <h1 className="font-pixel text-sentinel text-sm sm:text-base tracking-wider animate-text-glow">
                NO SENTINEL DETECTED
              </h1>
              <p className="text-[10px] text-muted-foreground max-w-md">
                Wallet {address?.slice(0, 6)}…{address?.slice(-4)} holds no SentinelETH NFTs.
                Acquire a Sentinel to unlock the training skill.
              </p>
              <Link
                href="/collection"
                className="border-trace inline-block"
              >
                <Button size="lg" className="bg-black text-sentinel hover:bg-sentinel/10 hover:text-sentinel border-0 text-[9px] px-6 py-6">
                  View Collection
                </Button>
              </Link>
            </CardContent>
          </Card>
        </main>
      </>
    )
  }

  // Holder — render the skill
  return <TrainContent />
}

function TrainContent() {
  const { nodes, toc } = useMemo(() => renderMarkdown(TRAIN_SKILL_MD), [])
  const [copiedAll, setCopiedAll] = useState(false)
  const [activeId, setActiveId] = useState<string>("")

  const onCopyAll = () => {
    navigator.clipboard.writeText(TRAIN_SKILL_MD).then(() => {
      setCopiedAll(true)
      setTimeout(() => setCopiedAll(false), 2000)
    })
  }

  // scrollspy for TOC
  useEffect(() => {
    const headings = toc
      .map((t) => document.getElementById(t.id))
      .filter((el): el is HTMLElement => !!el)
    if (!headings.length) return
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        if (visible) setActiveId(visible.target.id)
      },
      { rootMargin: "-80px 0px -70% 0px" },
    )
    headings.forEach((h) => obs.observe(h))
    return () => obs.disconnect()
  }, [toc])

  return (
    <>
      <CircuitBackground />
      <main className="relative z-10 container mx-auto max-w-6xl px-4 py-8 sm:py-12">
        {/* Action bar */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-8">
          <div>
            <h1 className="font-pixel text-sentinel text-sm sm:text-base tracking-wider animate-text-glow">
              TRAIN YOUR AGENT
            </h1>
            <p className="text-[10px] text-muted-foreground mt-1">
              Hand this skill to your agent. It contains everything needed to build a Sentinel-style operative.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <a
              href="/api/skill/train"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[9px] font-pixel px-3 py-2 rounded border border-sentinel/30 text-sentinel hover:bg-sentinel/10 transition"
            >
              RAW .MD
            </a>
            <Button
              onClick={onCopyAll}
              size="sm"
              className="bg-sentinel text-black hover:bg-sentinel/90 text-[9px] font-pixel"
            >
              {copiedAll ? "COPIED ✓" : "COPY ENTIRE SKILL"}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[200px_1fr] gap-8">
          {/* TOC */}
          <aside className="hidden lg:block">
            <nav className="sticky top-20 space-y-1 text-[10px]">
              <div className="font-pixel text-sentinel/60 text-[8px] tracking-wider mb-2">
                CONTENTS
              </div>
              {toc.map((t) => (
                <a
                  key={t.id}
                  href={`#${t.id}`}
                  className={`block px-2 py-1 rounded transition-colors ${
                    activeId === t.id
                      ? "text-sentinel bg-sentinel/10"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t.title}
                </a>
              ))}
            </nav>
          </aside>

          {/* Body */}
          <article className="min-w-0 overflow-hidden">{nodes}</article>
        </div>
      </main>
    </>
  )
}
