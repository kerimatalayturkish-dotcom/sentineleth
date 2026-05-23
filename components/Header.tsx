"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import { useAccount } from "wagmi"
import { miningChain } from "@/lib/mining-config"

const baseNavLinks = [
  { href: "/", label: "Home" },
  { href: "/collection", label: "Collection" },
  { href: "/mine", label: "Mine" },
  { href: "/how-to-mint", label: "How to Mint" },
]

export function Header() {
  const pathname = usePathname()
  const { isConnected } = useAccount()
  const [open, setOpen] = useState(false)
  const requiresMiningChain = pathname === "/mine" || pathname.startsWith("/admin")

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
    <header className="sticky top-0 z-50 glass-panel border-x-0 border-t-0 rounded-none bg-background/80">
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
          <span className="font-pixel text-sentinel text-[20px] tracking-widest animate-text-glow font-bold">
            SENTINEL
          </span>
        </Link>

        {/* Desktop nav (absolutely centered) */}
        <nav className="hidden md:flex items-center gap-6 absolute left-1/2 -translate-x-1/2">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`whitespace-nowrap rounded-none border px-4 py-2 text-[14px] font-pixel uppercase tracking-widest transition-all duration-300 ${
                pathname === link.href
                  ? "border-sentinel text-sentinel bg-sentinel/10 shadow-[0_0_18px_rgba(0,255,157,0.18)]"
                  : "border-sentinel text-muted-foreground hover:text-sentinel hover:bg-sentinel/5 hover:shadow-[0_0_18px_rgba(0,255,157,0.18)]"
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
              const wrongMiningChain = Boolean(connected && requiresMiningChain && chain.id !== miningChain.id)
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
                          className="btn-cyber px-4 py-2"
                        >
                          CONNECT
                        </button>
                      )
                    }
                    if (chain.unsupported || wrongMiningChain) {
                      return (
                        <button
                          type="button"
                          onClick={openChainModal}
                          className="btn-cyber px-4 py-2 !border-red-500 !text-red-400 hover:!bg-red-500 hover:!text-black"
                        >
                          {wrongMiningChain ? `SWITCH ${miningChain.name.toUpperCase()}` : "WRONG NET"}
                        </button>
                      )
                    }
                    return (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={openChainModal}
                          aria-label="Switch network"
                          className="hidden sm:flex items-center gap-2 px-3 py-2 border border-sentinel/30 bg-background/60 text-sentinel hover:bg-sentinel/10 transition-colors font-pixel text-[9px] tracking-wider rounded-md"
                        >
                          <span className="inline-block w-1.5 h-1.5 rounded-full bg-sentinel animate-pulse" />
                          {chain.name?.toUpperCase() ?? "ETHEREUM"}
                        </button>
                        <button
                          type="button"
                          onClick={openAccountModal}
                          className="btn-cyber px-4 py-2"
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
              className={`whitespace-nowrap rounded-none border px-4 py-4 text-[16px] font-pixel uppercase tracking-widest transition-all duration-300 ${
                pathname === link.href
                  ? "border-sentinel text-sentinel bg-sentinel/10 shadow-[0_0_18px_rgba(0,255,157,0.18)]"
                  : "border-sentinel text-muted-foreground hover:text-sentinel hover:bg-sentinel/5 hover:shadow-[0_0_18px_rgba(0,255,157,0.18)]"
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
