"use client"

import { useEffect, useState } from "react"

interface CountCycleProps {
  target: number
  pad?: number
  rampMs?: number
  holdMs?: number
}

/**
 * Counts 0 -> target over `rampMs`, holds `holdMs`, ramps back to 0,
 * then immediately ramps up again. Loops forever.
 */
export function CountCycle({ target, pad = 4, rampMs = 1500, holdMs = 3000 }: CountCycleProps) {
  const [value, setValue] = useState(0)

  useEffect(() => {
    let raf = 0
    let timeout = 0
    let cancelled = false

    const ramp = (from: number, to: number, onDone: () => void) => {
      const start = performance.now()
      const delta = to - from
      const step = (now: number) => {
        if (cancelled) return
        const t = Math.min(1, (now - start) / rampMs)
        // easeOutCubic for the up-ramp, linear feel works fine for both
        const eased = 1 - Math.pow(1 - t, 3)
        setValue(Math.round(from + delta * eased))
        if (t < 1) {
          raf = requestAnimationFrame(step)
        } else {
          setValue(to)
          onDone()
        }
      }
      raf = requestAnimationFrame(step)
    }

    const cycle = () => {
      ramp(0, target, () => {
        timeout = window.setTimeout(() => {
          ramp(target, 0, () => {
            cycle()
          })
        }, holdMs)
      })
    }

    cycle()

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      window.clearTimeout(timeout)
    }
  }, [target, rampMs, holdMs])

  return <span className="tabular-nums">{String(value).padStart(pad, "0")}</span>
}
