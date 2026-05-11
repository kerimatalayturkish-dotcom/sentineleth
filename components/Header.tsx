"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import { useAccount } from "wagmi"

const baseNavLinks = [
  { href: "/", label: "Home" },
  { href: "/collection", label: "Collection" },
  { href: "/how-to-mint", label: "How to Mint" },
]

export function Header() {
  const pathname = usePathname()
  const { isConnected } = useAccount()
  const [open, setOpen] = useState(false)

  const navLinks = isConnected
    ? [...baseNavLinks, { href: "/my-holdings", label: "My Holdings" }]
    : baseNavLinks

  // Close drawer on route change
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional sync with route
    setOpen(false)
  }, [pathname])

  // Lock background scroll while drawer is open
  useEffect(() => {
    if (open) {
      const prev = document.body.style.overflow
      document.body.style.overflow = "hidden"
      return () => {
        document.body.style.overflow = prev
      }
    }
  }, [open])

  return (
    <header className="sticky top-0 z-50 border-b border-sentinel/20 bg-background/80 backdrop-blur-md">
      <div className="container mx-auto max-w-6xl relative flex items-center justify-between h-14 px-4 gap-2">
        {/* Hamburger (mobile only) */}
        <button
          type="button"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="sm:hidden flex flex-col justify-center items-center w-9 h-9 rounded-md border border-sentinel/20 hover:border-sentinel/40 hover:bg-sentinel/10 transition-colors"
        >
          <span
            className={`block h-px w-4 bg-sentinel transition-transform duration-200 ${
              open ? "translate-y-[3px] rotate-45" : ""
            }`}
          />
          <span
            className={`block h-px w-4 bg-sentinel my-[3px] transition-opacity duration-200 ${
              open ? "opacity-0" : "opacity-100"
            }`}
          />
          <span
            className={`block h-px w-4 bg-sentinel transition-transform duration-200 ${
              open ? "-translate-y-[5px] -rotate-45" : ""
            }`}
          />
        </button>

        {/* Logo */}
        <Link href="/" className="flex items-center gap-2">
          <span className="font-pixel text-sentinel text-[9px] tracking-wider animate-text-glow">
            SENTINEL
          </span>
        </Link>

        {/* Desktop nav (absolutely centered) */}
        <nav className="hidden sm:flex items-center gap-1 absolute left-1/2 -translate-x-1/2">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`px-3 py-1.5 text-[9px] rounded-md transition-colors ${
                pathname === link.href
                  ? "text-sentinel bg-sentinel/10"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              }`}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        {/* Wallet */}
        <div className="origin-right">
          <ConnectButton.Custom>
            {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
              const ready = mounted
              const connected = ready && account && chain
              return (
                <div
                  {...(!ready && {
                    "aria-hidden": true,
                    style: { opacity: 0, pointerEvents: "none", userSelect: "none" },
                  })}
                >
                  {(() => {
                    if (!connected) {
                      return (
                        <button
                          type="button"
                          onClick={openConnectModal}
                          className="font-pixel text-[8px] tracking-wider px-3 py-2 rounded-md border border-sentinel/40 bg-sentinel/10 text-sentinel hover:bg-sentinel hover:text-black transition-colors"
                        >
                          CONNECT
                        </button>
                      )
                    }
                    if (chain.unsupported) {
                      return (
                        <button
                          type="button"
                          onClick={openChainModal}
                          className="font-pixel text-[8px] tracking-wider px-3 py-2 rounded-md border border-red-500/60 bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
                        >
                          WRONG NET
                        </button>
                      )
                    }
                    return (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={openChainModal}
                          aria-label="Switch network"
                          className="hidden sm:flex items-center gap-1 font-pixel text-[8px] tracking-wider px-2 py-2 rounded-md border border-sentinel/30 bg-background/60 text-sentinel hover:bg-sentinel/10 transition-colors"
                        >
                          <span className="inline-block w-1.5 h-1.5 rounded-full bg-sentinel animate-pulse" />
                          {chain.name?.toUpperCase() ?? "ETHEREUM"}
                        </button>
                        <button
                          type="button"
                          onClick={openAccountModal}
                          className="font-pixel text-[8px] tracking-wider px-3 py-2 rounded-md border border-sentinel/40 bg-sentinel/10 text-sentinel hover:bg-sentinel hover:text-black transition-colors"
                        >
                          {account.displayName}
                        </button>
                      </div>
                    )
                  })()}
                </div>
              )
            }}
          </ConnectButton.Custom>
        </div>
      </div>

      {/* Mobile drawer + backdrop */}
      <div
        className={`sm:hidden fixed inset-0 top-14 z-40 transition-opacity duration-200 ${
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
      >
        <div
          className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
        <nav
          className={`relative bg-background/95 border-b border-sentinel/20 px-4 py-4 flex flex-col gap-1 transition-transform duration-200 ease-out ${
            open ? "translate-y-0" : "-translate-y-2"
          }`}
        >
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`px-4 py-3 rounded-md text-[11px] font-pixel tracking-wider transition-colors ${
                pathname === link.href
                  ? "text-sentinel bg-sentinel/10 border border-sentinel/30"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted border border-transparent"
              }`}
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  )
}
