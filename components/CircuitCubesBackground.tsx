"use client"

import { useEffect, useRef } from "react"
import * as THREE from "three"

const BACKGROUND_COLOR = "#010604"
const GRID_SIZE = 48
const GRID_DIVISIONS = 16
const GRID_SPACING = GRID_SIZE / GRID_DIVISIONS
const GRID_HALF_SIZE = GRID_SIZE / 2
const GRID_LINE_POSITIONS = Array.from({ length: GRID_DIVISIONS + 1 }, (_, index) => -GRID_HALF_SIZE + index * GRID_SPACING)
const LINE_CUBE_SIZE = GRID_SPACING * 0.72
const HASH_ALPHABET = "0123456789ABCDEF"

type CubeLane = {
  laneZ: number
  startIndex: number
  direction: 1 | -1
}

type AnimatedCubeState = "waiting" | "moving" | "typing" | "respawning"

type AnimatedCube = {
  group: THREE.Group
  label: THREE.Sprite
  labelTexture: THREE.CanvasTexture
  labelMaterial: THREE.SpriteMaterial
  labelCanvas: HTMLCanvasElement
  labelContext: CanvasRenderingContext2D
  lane: CubeLane
  currentIndex: number
  targetIndex: number
  state: AnimatedCubeState
  stateStartedAt: number
  stateUntil: number
  moveDuration: number
  hashText: string
  hashTypingStep: number
  hashHoldDuration: number
  lastRenderedLabel: string
  lastRenderedOpacity: number
}

type VerticalLineLane = {
  lineX: number
  nextSpawnAt: number
}

type VerticalLineStreak = {
  group: THREE.Group
  head: THREE.Sprite
  glow: THREE.Sprite
  trailAttribute: THREE.BufferAttribute
  trailGeometry: THREE.BufferGeometry
  lineX: number
  startedAt: number
  duration: number
  startZ: number
  endZ: number
  tailLength: number
  lift: number
}

const LEFT_CUBE_LANES: CubeLane[] = [
  { laneZ: -15, startIndex: 0, direction: 1 },
  { laneZ: -6, startIndex: 2, direction: 1 },
  { laneZ: 6, startIndex: 4, direction: 1 },
]

const RIGHT_CUBE_LANES: CubeLane[] = [
  { laneZ: -12, startIndex: GRID_LINE_POSITIONS.length - 1, direction: -1 },
  { laneZ: 0, startIndex: GRID_LINE_POSITIONS.length - 3, direction: -1 },
  { laneZ: 12, startIndex: GRID_LINE_POSITIONS.length - 5, direction: -1 },
]

function randomRange(min: number, max: number) {
  return min + Math.random() * (max - min)
}

function createHashText() {
  const length = 6 + Math.floor(Math.random() * 3)
  let value = "0x"

  for (let index = 0; index < length; index += 1) {
    const charIndex = Math.floor(Math.random() * HASH_ALPHABET.length)
    value += HASH_ALPHABET[charIndex]
  }

  return value
}

function createGlowTexture() {
  const canvas = document.createElement("canvas")
  canvas.width = 64
  canvas.height = 64
  const context = canvas.getContext("2d")

  if (!context) {
    throw new Error("Canvas 2D context is required for streak glow")
  }

  const gradient = context.createRadialGradient(32, 32, 3, 32, 32, 32)
  gradient.addColorStop(0, "rgba(232, 255, 255, 1)")
  gradient.addColorStop(0.28, "rgba(160, 255, 248, 0.95)")
  gradient.addColorStop(0.62, "rgba(72, 218, 207, 0.44)")
  gradient.addColorStop(1, "rgba(72, 218, 207, 0)")
  context.fillStyle = gradient
  context.fillRect(0, 0, canvas.width, canvas.height)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

export function CircuitCubesBackground() {
  const mountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(BACKGROUND_COLOR)
    scene.fog = new THREE.Fog(BACKGROUND_COLOR, 16, 52)

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100)
    camera.position.set(18, 15, 18)
    camera.lookAt(0, 0, 0)

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    })
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.domElement.style.width = "100%"
    renderer.domElement.style.height = "100%"
    renderer.domElement.style.display = "block"
    mount.appendChild(renderer.domElement)

    const root = new THREE.Group()
    root.rotation.y = Math.PI / 4
    scene.add(root)

    const ambientLight = new THREE.AmbientLight(0x6fe0b2, 0.34)
    const keyLight = new THREE.DirectionalLight(0x8deeff, 0.58)
    keyLight.position.set(14, 20, 10)
    const rimLight = new THREE.DirectionalLight(0x2f8f5d, 0.42)
    rimLight.position.set(-10, 8, -14)
    scene.add(ambientLight, keyLight, rimLight)

    const floorGeometry = new THREE.PlaneGeometry(GRID_SIZE, GRID_SIZE)
    const floorMaterial = new THREE.MeshPhongMaterial({
      color: 0x03110a,
      side: THREE.DoubleSide,
      shininess: 10,
    })
    const floor = new THREE.Mesh(floorGeometry, floorMaterial)
    floor.rotation.x = -Math.PI / 2
    root.add(floor)

    const grid = new THREE.GridHelper(GRID_SIZE, GRID_DIVISIONS, 0x376f46, 0x173421)
    grid.position.y = 0.02
    root.add(grid)

    const cubeGeometry = new THREE.BoxGeometry(LINE_CUBE_SIZE, LINE_CUBE_SIZE, LINE_CUBE_SIZE)
    const cubeEdgeGeometry = new THREE.EdgesGeometry(cubeGeometry)
    const cubeBodyMaterial = new THREE.MeshPhongMaterial({
      color: 0x052019,
      emissive: 0x0a3a44,
      emissiveIntensity: 0.2,
      transparent: true,
      opacity: 0.12,
      shininess: 20,
    })
    const cubeEdgeMaterial = new THREE.LineBasicMaterial({
      color: 0xd6fcff,
      transparent: true,
      opacity: 0.96,
      toneMapped: false,
    })
    const cubeEdgeGlowMaterial = new THREE.LineBasicMaterial({
      color: 0x4eeaff,
      transparent: true,
      opacity: 0.28,
      toneMapped: false,
    })
    const streakGlowTexture = createGlowTexture()
    const streakTrailMaterial = new THREE.LineBasicMaterial({
      color: 0xa8ffff,
      transparent: true,
      opacity: 0.78,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    })
    const streakHeadMaterial = new THREE.SpriteMaterial({
      map: streakGlowTexture,
      color: 0xeaffff,
      transparent: true,
      opacity: 0.96,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    })
    const streakGlowMaterial = new THREE.SpriteMaterial({
      map: streakGlowTexture,
      color: 0x5df7f0,
      transparent: true,
      opacity: 0.42,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    })

    const drawLabel = (cube: AnimatedCube, labelText: string, opacity: number) => {
      if (cube.lastRenderedLabel === labelText && Math.abs(cube.lastRenderedOpacity - opacity) < 0.01) {
        return
      }

      const context = cube.labelContext
      const canvas = cube.labelCanvas
      context.clearRect(0, 0, canvas.width, canvas.height)

      if (!labelText || opacity <= 0.01) {
        cube.label.visible = false
        cube.labelTexture.needsUpdate = true
        cube.lastRenderedLabel = labelText
        cube.lastRenderedOpacity = opacity
        return
      }

      cube.label.visible = true
      context.globalAlpha = Math.min(opacity * 0.72, 0.72)
      context.font = "700 28px monospace"
      context.textAlign = "center"
      context.textBaseline = "middle"
      context.strokeStyle = "rgba(28, 84, 96, 0.48)"
      context.lineWidth = 4
      context.strokeText(labelText, canvas.width / 2, canvas.height / 2)
      context.fillStyle = "rgba(142, 212, 220, 0.78)"
      context.fillText(labelText, canvas.width / 2, canvas.height / 2)

      cube.labelTexture.needsUpdate = true
      cube.lastRenderedLabel = labelText
      cube.lastRenderedOpacity = opacity
    }

    const createLabelSprite = () => {
      const labelCanvas = document.createElement("canvas")
      labelCanvas.width = 320
      labelCanvas.height = 110
      const labelContext = labelCanvas.getContext("2d")

      if (!labelContext) {
        throw new Error("Canvas 2D context is required for cube labels")
      }

      const labelTexture = new THREE.CanvasTexture(labelCanvas)
      labelTexture.colorSpace = THREE.SRGBColorSpace
      const labelMaterial = new THREE.SpriteMaterial({
        map: labelTexture,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        toneMapped: false,
      })
      const label = new THREE.Sprite(labelMaterial)
      label.position.set(0, LINE_CUBE_SIZE * 1.05, 0)
      label.scale.set(6.4, 2.2, 1)
      label.visible = false

      return { label, labelCanvas, labelContext, labelTexture, labelMaterial }
    }

    const createAnimatedCube = (lane: CubeLane): AnimatedCube => {
      const cube = new THREE.Group()
      cube.position.set(GRID_LINE_POSITIONS[lane.startIndex], 0, lane.laneZ)

      const body = new THREE.Mesh(cubeGeometry, cubeBodyMaterial)
      body.position.y = LINE_CUBE_SIZE / 2 + 0.04
      cube.add(body)

      const edges = new THREE.LineSegments(cubeEdgeGeometry, cubeEdgeMaterial)
      edges.position.copy(body.position)
      cube.add(edges)

      const edgeGlow = new THREE.LineSegments(cubeEdgeGeometry, cubeEdgeGlowMaterial)
      edgeGlow.position.copy(body.position)
      edgeGlow.scale.setScalar(1.045)
      cube.add(edgeGlow)

      const { label, labelCanvas, labelContext, labelTexture, labelMaterial } = createLabelSprite()
      cube.add(label)

      return {
        group: cube,
        label,
        labelTexture,
        labelMaterial,
        labelCanvas,
        labelContext,
        lane,
        currentIndex: lane.startIndex,
        targetIndex: lane.startIndex,
        state: "waiting",
        stateStartedAt: 0,
        stateUntil: randomRange(0.35, 1.8),
        moveDuration: 0.72,
        hashText: "",
        hashTypingStep: 0.06,
        hashHoldDuration: 0.8,
        lastRenderedLabel: "",
        lastRenderedOpacity: 0,
      }
    }

    const animatedCubes: AnimatedCube[] = []
    const verticalLineLanes: VerticalLineLane[] = GRID_LINE_POSITIONS.map((lineX) => ({
      lineX,
      nextSpawnAt: randomRange(0.35, 4.5),
    }))
    const verticalLineStreaks: VerticalLineStreak[] = []

    LEFT_CUBE_LANES.forEach((lane) => {
      const cube = createAnimatedCube(lane)
      animatedCubes.push(cube)
      root.add(cube.group)
    })

    RIGHT_CUBE_LANES.forEach((lane) => {
      const cube = createAnimatedCube(lane)
      animatedCubes.push(cube)
      root.add(cube.group)
    })

    const createVerticalLineStreak = (lineX: number, startedAt: number): VerticalLineStreak => {
      const group = new THREE.Group()
      group.visible = false

      const trailGeometry = new THREE.BufferGeometry()
      const trailAttribute = new THREE.BufferAttribute(new Float32Array(6), 3)
      trailGeometry.setAttribute("position", trailAttribute)
      const trail = new THREE.Line(trailGeometry, streakTrailMaterial)
      group.add(trail)

      const glow = new THREE.Sprite(streakGlowMaterial)
      glow.scale.set(1.05, 1.05, 1)
      group.add(glow)

      const head = new THREE.Sprite(streakHeadMaterial)
      head.scale.set(0.44, 0.44, 1)
      group.add(head)

      root.add(group)

      return {
        group,
        head,
        glow,
        trailAttribute,
        trailGeometry,
        lineX,
        startedAt,
        duration: randomRange(0.72, 1.55),
        startZ: GRID_HALF_SIZE - randomRange(GRID_SPACING * 0.08, GRID_SPACING * 0.55),
        endZ: -GRID_HALF_SIZE + randomRange(GRID_SPACING * 0.08, GRID_SPACING * 0.55),
        tailLength: randomRange(GRID_SPACING * 0.8, GRID_SPACING * 1.7),
        lift: 0.08 + randomRange(0.03, 0.09),
      }
    }

    const disposeVerticalLineStreak = (streak: VerticalLineStreak) => {
      root.remove(streak.group)
      streak.trailGeometry.dispose()
    }

    const updateVerticalLineStreak = (streak: VerticalLineStreak, now: number) => {
      if (now < streak.startedAt) {
        return false
      }

      streak.group.visible = true
      const progress = Math.min((now - streak.startedAt) / streak.duration, 1)
      const zPosition = THREE.MathUtils.lerp(streak.startZ, streak.endZ, progress)
      const shimmer = 0.9 + Math.sin(now * 26 + streak.lineX * 0.7) * 0.16
      const visibleTailLength = streak.tailLength * (0.45 + Math.sin(progress * Math.PI) * 0.55)

      streak.group.position.set(streak.lineX, streak.lift, zPosition)
      streak.head.scale.set(0.34 * shimmer, 0.34 * shimmer, 1)
      streak.glow.scale.set(0.92 * shimmer, 0.92 * shimmer, 1)
      streak.trailAttribute.setXYZ(0, 0, 0, 0)
      streak.trailAttribute.setXYZ(1, 0, 0, visibleTailLength)
      streak.trailAttribute.needsUpdate = true

      return progress >= 1
    }

    const setCubeToIndex = (cube: AnimatedCube, lineIndex: number) => {
      cube.group.position.set(GRID_LINE_POSITIONS[lineIndex], 0, cube.lane.laneZ)
    }

    const beginNextMove = (cube: AnimatedCube, now: number) => {
      const nextIndex = cube.currentIndex + cube.lane.direction

      drawLabel(cube, "", 0)

      if (nextIndex < 0 || nextIndex >= GRID_LINE_POSITIONS.length) {
        cube.state = "respawning"
        cube.stateStartedAt = now
        cube.stateUntil = now + randomRange(1.2, 2.5)
        cube.group.visible = false
        return
      }

      cube.state = "moving"
      cube.stateStartedAt = now
      cube.moveDuration = randomRange(0.55, 0.92)
      cube.targetIndex = nextIndex
    }

    const startTypingHash = (cube: AnimatedCube, now: number) => {
      cube.state = "typing"
      cube.stateStartedAt = now
      cube.hashText = createHashText()
      cube.hashTypingStep = randomRange(0.045, 0.095)
      cube.hashHoldDuration = randomRange(0.6, 1.3)
    }

    const updateCube = (cube: AnimatedCube, now: number) => {
      if (cube.state === "waiting") {
        if (now >= cube.stateUntil) {
          beginNextMove(cube, now)
        }
        return
      }

      if (cube.state === "moving") {
        const fromX = GRID_LINE_POSITIONS[cube.currentIndex]
        const toX = GRID_LINE_POSITIONS[cube.targetIndex]
        const progress = Math.min((now - cube.stateStartedAt) / cube.moveDuration, 1)
        const easedProgress = progress * progress * (3 - 2 * progress)

        cube.group.position.x = THREE.MathUtils.lerp(fromX, toX, easedProgress)
        cube.group.position.z = cube.lane.laneZ

        if (progress >= 1) {
          cube.currentIndex = cube.targetIndex
          setCubeToIndex(cube, cube.currentIndex)
          startTypingHash(cube, now)
        }
        return
      }

      if (cube.state === "typing") {
        const elapsed = now - cube.stateStartedAt
        const visibleChars = Math.min(
          cube.hashText.length,
          Math.floor(elapsed / cube.hashTypingStep) + 1,
        )
        const visibleText = cube.hashText.slice(0, visibleChars)
        drawLabel(cube, visibleText, 1)

        if (elapsed >= cube.hashTypingStep * cube.hashText.length + cube.hashHoldDuration) {
          drawLabel(cube, "", 0)
          cube.state = "waiting"
          cube.stateStartedAt = now
          cube.stateUntil = now + randomRange(0.55, 1.9)
        }
        return
      }

      if (cube.state === "respawning" && now >= cube.stateUntil) {
        cube.currentIndex = cube.lane.startIndex
        cube.targetIndex = cube.currentIndex
        cube.group.visible = true
        setCubeToIndex(cube, cube.currentIndex)
        drawLabel(cube, "", 0)
        cube.state = "waiting"
        cube.stateStartedAt = now
        cube.stateUntil = now + randomRange(0.35, 1.15)
      }
    }

    const resize = () => {
      const width = mount.clientWidth || window.innerWidth
      const height = mount.clientHeight || window.innerHeight
      camera.aspect = width / Math.max(height, 1)
      camera.updateProjectionMatrix()
      renderer.setSize(width, height, false)
    }

    resize()
    window.addEventListener("resize", resize)

    let frameId = 0
    const renderFrame = (timestamp = 0) => {
      const now = timestamp * 0.001

      verticalLineLanes.forEach((lane) => {
        if (now < lane.nextSpawnAt) {
          return
        }

        const burstCount = 1 + Math.floor(Math.random() * 3)

        for (let burstIndex = 0; burstIndex < burstCount; burstIndex += 1) {
          verticalLineStreaks.push(
            createVerticalLineStreak(lane.lineX, now + burstIndex * randomRange(0.08, 0.22)),
          )
        }

        lane.nextSpawnAt = now + randomRange(2.8, 7.4)
      })

      animatedCubes.forEach((cube, cubeIndex) => {
        updateCube(cube, now)

        if (cube.group.visible) {
          cube.group.position.y = Math.sin(now * 1.45 + cubeIndex * 0.85) * 0.03
        }
      })

      for (let streakIndex = verticalLineStreaks.length - 1; streakIndex >= 0; streakIndex -= 1) {
        const streak = verticalLineStreaks[streakIndex]

        if (updateVerticalLineStreak(streak, now)) {
          disposeVerticalLineStreak(streak)
          verticalLineStreaks.splice(streakIndex, 1)
        }
      }

      renderer.render(scene, camera)
      frameId = window.requestAnimationFrame(renderFrame)
    }
    renderFrame()

    return () => {
      window.cancelAnimationFrame(frameId)
      window.removeEventListener("resize", resize)
      floorGeometry.dispose()
      floorMaterial.dispose()
      cubeGeometry.dispose()
      cubeEdgeGeometry.dispose()
      cubeBodyMaterial.dispose()
      cubeEdgeMaterial.dispose()
      cubeEdgeGlowMaterial.dispose()
      verticalLineStreaks.forEach(disposeVerticalLineStreak)
      streakGlowTexture.dispose()
      streakTrailMaterial.dispose()
      streakHeadMaterial.dispose()
      streakGlowMaterial.dispose()
      animatedCubes.forEach((cube) => {
        cube.labelTexture.dispose()
        cube.labelMaterial.dispose()
      })
      grid.geometry.dispose()
      if (Array.isArray(grid.material)) {
        grid.material.forEach((material) => material.dispose())
      } else {
        grid.material.dispose()
      }
      renderer.dispose()
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement)
      }
    }
  }, [])

  return (
    <div className="pointer-events-none fixed inset-0 z-[-1] overflow-hidden bg-[#010604]">
      <div ref={mountRef} className="absolute inset-0" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(13,42,23,0.2),transparent_42%),linear-gradient(to_bottom,rgba(2,6,4,0)_0%,rgba(1,3,2,0.28)_100%)]" />
    </div>
  )
}