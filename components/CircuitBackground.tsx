"use client"

import { useEffect, useRef } from "react"

interface TraceSegment {
  x1: number
  y1: number
  x2: number
  y2: number
  width: number
  brightness: number
}

interface JunctionNode {
  x: number
  y: number
  radius: number
  ringRadius: number
  hasRing: boolean
}

interface DataPulse {
  segmentIndex: number
  progress: number
  speed: number
  size: number
  brightness: number
  trail: number
}

export function CircuitBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    let animationId: number
    let traces: TraceSegment[] = []
    let junctions: JunctionNode[] = []
    let pulses: DataPulse[] = []

    function resize() {
      canvas!.width = window.innerWidth
      canvas!.height = window.innerHeight
      buildCircuit()
    }

    function buildCircuit() {
      traces = []
      junctions = []
      pulses = []
      const w = canvas!.width
      const h = canvas!.height

      // === Main horizontal bus lines ===
      const busCount = Math.floor(h / 140) + 1
      const busYPositions: number[] = []
      for (let i = 0; i < busCount; i++) {
        const y = 80 + i * 140 + (Math.random() - 0.5) * 30
        busYPositions.push(y)
        traces.push({ x1: 0, y1: y, x2: w, y2: y, width: 2, brightness: 0.18 })
        // Parallel thin companion line
        if (Math.random() > 0.4) {
          const offset = 8 + Math.random() * 6
          traces.push({ x1: 0, y1: y + offset, x2: w, y2: y + offset, width: 1, brightness: 0.08 })
        }
      }

      // === Main vertical bus lines ===
      const vBusCount = Math.floor(w / 180) + 1
      const busXPositions: number[] = []
      for (let i = 0; i < vBusCount; i++) {
        const x = 100 + i * 180 + (Math.random() - 0.5) * 40
        busXPositions.push(x)
        traces.push({ x1: x, y1: 0, x2: x, y2: h, width: 2, brightness: 0.15 })
        if (Math.random() > 0.5) {
          const offset = 8 + Math.random() * 6
          traces.push({ x1: x + offset, y1: 0, x2: x + offset, y2: h, width: 1, brightness: 0.07 })
        }
      }

      // === Junction nodes at intersections ===
      for (const bx of busXPositions) {
        for (const by of busYPositions) {
          const jx = bx + (Math.random() - 0.5) * 4
          const jy = by + (Math.random() - 0.5) * 4
          junctions.push({
            x: jx,
            y: jy,
            radius: 3 + Math.random() * 2,
            ringRadius: 8 + Math.random() * 4,
            hasRing: Math.random() > 0.4,
          })
        }
      }

      // === Branch traces (L-shaped offshoots from bus lines) ===
      for (const by of busYPositions) {
        const branchCount = Math.floor(w / 120)
        for (let b = 0; b < branchCount; b++) {
          if (Math.random() > 0.55) continue
          const startX = 40 + b * 120 + Math.random() * 60
          const length = 30 + Math.random() * 70
          const dir = Math.random() > 0.5 ? 1 : -1

          // Vertical drop from bus
          traces.push({
            x1: startX, y1: by, x2: startX, y2: by + length * dir,
            width: 1, brightness: 0.1,
          })
          // Horizontal continuation
          if (Math.random() > 0.3) {
            const hLen = 20 + Math.random() * 50
            const hDir = Math.random() > 0.5 ? 1 : -1
            traces.push({
              x1: startX, y1: by + length * dir,
              x2: startX + hLen * hDir, y2: by + length * dir,
              width: 1, brightness: 0.08,
            })
            // Endpoint node
            junctions.push({
              x: startX + hLen * hDir,
              y: by + length * dir,
              radius: 2,
              ringRadius: 5,
              hasRing: Math.random() > 0.6,
            })
          }
          // Branch origin node
          junctions.push({
            x: startX, y: by, radius: 2, ringRadius: 0, hasRing: false,
          })
        }
      }

      // === Branch traces from vertical buses ===
      for (const bx of busXPositions) {
        const branchCount = Math.floor(h / 120)
        for (let b = 0; b < branchCount; b++) {
          if (Math.random() > 0.55) continue
          const startY = 40 + b * 120 + Math.random() * 60
          const length = 25 + Math.random() * 60
          const dir = Math.random() > 0.5 ? 1 : -1

          traces.push({
            x1: bx, y1: startY, x2: bx + length * dir, y2: startY,
            width: 1, brightness: 0.1,
          })
          if (Math.random() > 0.3) {
            const vLen = 20 + Math.random() * 40
            const vDir = Math.random() > 0.5 ? 1 : -1
            traces.push({
              x1: bx + length * dir, y1: startY,
              x2: bx + length * dir, y2: startY + vLen * vDir,
              width: 1, brightness: 0.08,
            })
            junctions.push({
              x: bx + length * dir, y: startY + vLen * vDir,
              radius: 2, ringRadius: 5, hasRing: Math.random() > 0.6,
            })
          }
        }
      }

      // === Scatter small square pads (like SMD components) ===
      const padCount = Math.floor((w * h) / 40000)
      for (let i = 0; i < padCount; i++) {
        junctions.push({
          x: Math.random() * w,
          y: Math.random() * h,
          radius: 1.5,
          ringRadius: 0,
          hasRing: false,
        })
      }

      // === Seed data pulses on traces ===
      const pulseCount = Math.max(12, Math.floor(traces.length * 0.08))
      for (let i = 0; i < pulseCount; i++) {
        spawnPulse()
      }
    }

    function spawnPulse() {
      if (traces.length === 0) return
      const idx = Math.floor(Math.random() * traces.length)
      const seg = traces[idx]
      const isBus = seg.width >= 2
      pulses.push({
        segmentIndex: idx,
        progress: Math.random(),
        speed: (0.001 + Math.random() * 0.004) * (isBus ? 1.5 : 1),
        size: isBus ? 4 : 2.5,
        brightness: isBus ? 0.9 : 0.6,
        trail: isBus ? 40 : 20,
      })
    }

    function draw() {
      ctx!.clearRect(0, 0, canvas!.width, canvas!.height)

      // Draw traces
      for (const seg of traces) {
        ctx!.strokeStyle = `rgba(255, 45, 45, ${seg.brightness})`
        ctx!.lineWidth = seg.width
        ctx!.beginPath()
        ctx!.moveTo(seg.x1, seg.y1)
        ctx!.lineTo(seg.x2, seg.y2)
        ctx!.stroke()
      }

      // Draw junction nodes
      for (const j of junctions) {
        // Filled dot
        ctx!.fillStyle = "rgba(255, 45, 45, 0.25)"
        ctx!.beginPath()
        ctx!.arc(j.x, j.y, j.radius, 0, Math.PI * 2)
        ctx!.fill()

        // Ring
        if (j.hasRing) {
          ctx!.strokeStyle = "rgba(255, 45, 45, 0.12)"
          ctx!.lineWidth = 1
          ctx!.beginPath()
          ctx!.arc(j.x, j.y, j.ringRadius, 0, Math.PI * 2)
          ctx!.stroke()
        }
      }

      // Draw and update data pulses
      for (let p = pulses.length - 1; p >= 0; p--) {
        const pulse = pulses[p]
        pulse.progress += pulse.speed

        if (pulse.progress >= 1) {
          pulses.splice(p, 1)
          spawnPulse()
          continue
        }

        const seg = traces[pulse.segmentIndex]
        if (!seg) continue

        const px = seg.x1 + (seg.x2 - seg.x1) * pulse.progress
        const py = seg.y1 + (seg.y2 - seg.y1) * pulse.progress

        // Trail (line behind the pulse)
        const dx = seg.x2 - seg.x1
        const dy = seg.y2 - seg.y1
        const len = Math.sqrt(dx * dx + dy * dy)
        if (len > 0) {
          const nx = dx / len
          const ny = dy / len
          const trailX = px - nx * pulse.trail
          const trailY = py - ny * pulse.trail

          const trailGrad = ctx!.createLinearGradient(trailX, trailY, px, py)
          trailGrad.addColorStop(0, "rgba(255, 45, 45, 0)")
          trailGrad.addColorStop(1, `rgba(255, 45, 45, ${pulse.brightness * 0.4})`)
          ctx!.strokeStyle = trailGrad
          ctx!.lineWidth = seg.width + 1
          ctx!.beginPath()
          ctx!.moveTo(trailX, trailY)
          ctx!.lineTo(px, py)
          ctx!.stroke()
        }

        // Pulse glow
        const gradient = ctx!.createRadialGradient(px, py, 0, px, py, pulse.size * 3)
        gradient.addColorStop(0, `rgba(255, 60, 60, ${pulse.brightness})`)
        gradient.addColorStop(0.4, `rgba(255, 45, 45, ${pulse.brightness * 0.3})`)
        gradient.addColorStop(1, "rgba(255, 45, 45, 0)")
        ctx!.fillStyle = gradient
        ctx!.beginPath()
        ctx!.arc(px, py, pulse.size * 3, 0, Math.PI * 2)
        ctx!.fill()

        // Bright core
        ctx!.fillStyle = `rgba(255, 120, 120, ${pulse.brightness})`
        ctx!.beginPath()
        ctx!.arc(px, py, pulse.size * 0.6, 0, Math.PI * 2)
        ctx!.fill()
      }

      // Keep pulse count stable
      const targetPulses = Math.max(12, Math.floor(traces.length * 0.08))
      while (pulses.length < targetPulses) {
        spawnPulse()
      }

      animationId = requestAnimationFrame(draw)
    }

    resize()
    draw()

    window.addEventListener("resize", resize)
    return () => {
      window.removeEventListener("resize", resize)
      cancelAnimationFrame(animationId)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 pointer-events-none z-0"
      style={{ opacity: 0.7 }}
    />
  )
}
