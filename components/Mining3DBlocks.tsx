"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import * as THREE from "three"
import { fetchJson } from "@/lib/fetch-json"

const FUTURE_FRONT_FACE_COLOR = 0x154332
const FUTURE_DEPTH_FACE_COLOR = 0x1a211c
const FUTURE_DEPTH_FACE_EMISSIVE = 0x103222
const FUTURE_EDGE_COLOR = 0xb7ffd5
const FUTURE_EDGE_GLOW_COLOR = 0x4eff9f
const WON_FRONT_FACE_COLOR = 0x1d9d4b
const WON_DEPTH_FACE_COLOR = 0x144829
const WON_DEPTH_FACE_EMISSIVE = 0x1e6a3d
const WON_EDGE_COLOR = 0xd5ffe8
const WON_EDGE_GLOW_COLOR = 0x78ffb0
const MISSED_FRONT_FACE_COLOR = 0x556070
const MISSED_DEPTH_FACE_COLOR = 0x2f3640
const MISSED_DEPTH_FACE_EMISSIVE = 0x222833
const MISSED_EDGE_COLOR = 0xd2d8e3
const MISSED_EDGE_GLOW_COLOR = 0xaeb7c6
const DIVIDER_COLOR = 0x9de0ff
const DIVIDER_GLOW_COLOR = 0x5fcfff
const MAX_VISIBLE_BLOCKS = 100
const TIMELINE_FETCH_LIMIT = 1_000
const VISIBLE_BUFFER_BLOCKS = 8
const FUTURE_WINDOW_BLOCKS = 11
const DISPLAY_SCALE = 1.5
const BLOCK_SCALE = 1.5 * DISPLAY_SCALE
const BLOCK_WIDTH = 3.6 * BLOCK_SCALE
const BLOCK_HEIGHT = 4.2 * BLOCK_SCALE
const BLOCK_DEPTH = 2.1 * BLOCK_SCALE
const BLOCK_SKEW_X = 0.9 * DISPLAY_SCALE
const BLOCK_SKEW_Y = 0.7 * DISPLAY_SCALE
const BLOCK_SPACING = 6.8 * DISPLAY_SCALE
const INITIAL_BLOCK_X = -2
const SCENE_FOG_COLOR = 0x010604
const ORTHO_HALF_HEIGHT = 9.8
const DRAG_SMOOTHING = 0.16
const DRAG_SENSITIVITY = 0.06
const CLICK_MOVE_THRESHOLD = 6
const CONVEYOR_DURATION_MS = 560
const CONVEYOR_CONFIRM_SWITCH_PROGRESS = 0.38
const CONVEYOR_POP_SCALE = 0.18
const BLOCK_LABEL_FONT_FAMILY = '"Share Tech Mono", monospace'
const BLOCK_LABEL_FONT_LOAD = '16px "Share Tech Mono"'

interface Mining3DBlocksProps {
  currentBlock?: number | null
  streamTimeline?: MiningBlocksStreamTimeline | null
}

export interface TimelineBlock {
  blockNumber: number
  blockHash: `0x${string}`
  blockTimestamp: string
  bucketId: number | null
  status: "won" | "missed"
  eligibleWalletCount: number
  eligiblePowerTotal: string | null
  winner: `0x${string}` | null
  winnerPower: string | null
  missReason: "no_eligible_power" | null
  claimed: boolean
  claimedTxHash: `0x${string}` | null
  reward: string | null
  createdAt: string
}

export interface MiningBlocksStreamTimeline {
  currentBlock: number | null
  lastProcessedBlock: number | null
  latestOutcome: TimelineBlock | null
}

interface TimelineResponse {
  startBlock: number | null
  currentBlock: number | null
  lastProcessedBlock: number | null
  windowStartBlock: number | null
  windowEndBlock: number | null
  blocks: TimelineBlock[]
}

interface TimelineSnapshot {
  firstBlockNumber: number | null
  currentBlock: number | null
  lastProcessedBlock: number | null
  blocksByNumber: Map<number, TimelineBlock>
}

interface BlockLabelState {
  canvas: HTMLCanvasElement
  context: CanvasRenderingContext2D
  texture: THREE.CanvasTexture
  material: THREE.SpriteMaterial
  sprite: THREE.Sprite
  text: string
}

interface BlockPoolItem {
  group: THREE.Group
  frontMaterial: THREE.MeshPhongMaterial
  depthMaterial: THREE.MeshPhongMaterial
  edgeMaterial: THREE.LineBasicMaterial
  glowMaterial: THREE.LineBasicMaterial
  label: BlockLabelState | null
  logicalIndex: number
}

type BlockVisualKind = "future" | "won" | "missed"

interface BlockLabelContent {
  primary: string
  secondary: string | null
  tertiary: string | null
  kind: BlockVisualKind
}

interface ConveyorAnimationState {
  active: boolean
  startTime: number
  confirmedBlock: number | null
}

function compactValue(value: string | null | undefined) {
  if (!value) return "-"
  if (value.length <= 14) return value
  return `${value.slice(0, 6)}...${value.slice(-4)}`
}

function formatDateTime(value: string) {
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) return value
  return parsed.toLocaleString()
}

function formatPowerValue(value: string | null | undefined) {
  if (!value) return "-"
  try {
    return BigInt(value).toLocaleString("en-US")
  } catch {
    return value
  }
}

function buildTimelineSnapshot(timeline: TimelineResponse | null, currentBlock: number | null): TimelineSnapshot {
  const blocks = timeline?.blocks ?? []
  return {
    firstBlockNumber: blocks[0]?.blockNumber ?? timeline?.windowStartBlock ?? currentBlock,
    currentBlock: timeline?.currentBlock ?? currentBlock,
    lastProcessedBlock: timeline?.lastProcessedBlock ?? blocks.at(-1)?.blockNumber ?? null,
    blocksByNumber: new Map(blocks.map((block) => [block.blockNumber, block])),
  }
}

function getDividerBlockNumber(snapshot: TimelineSnapshot) {
  if (snapshot.currentBlock !== null) {
    return snapshot.currentBlock - 1
  }
  return snapshot.lastProcessedBlock
}

function mergeStreamTimeline(
  timeline: TimelineResponse | null,
  streamTimeline: MiningBlocksStreamTimeline,
  fallbackCurrentBlock: number | null,
) {
  const currentBlock = streamTimeline.currentBlock ?? fallbackCurrentBlock
  const lastProcessedBlock = streamTimeline.lastProcessedBlock
  const latestOutcome = streamTimeline.latestOutcome

  if (!timeline) {
    const blocks = latestOutcome ? [latestOutcome] : []
    return {
      startBlock: latestOutcome?.blockNumber ?? currentBlock,
      currentBlock,
      lastProcessedBlock,
      windowStartBlock: blocks[0]?.blockNumber ?? null,
      windowEndBlock: latestOutcome?.blockNumber ?? null,
      blocks,
    }
  }

  if (lastProcessedBlock === null) {
    return {
      ...timeline,
      currentBlock,
    }
  }

  const previousLastProcessed = timeline.lastProcessedBlock
  if (previousLastProcessed === null) {
    if (!latestOutcome || latestOutcome.blockNumber !== lastProcessedBlock) return null
    return {
      ...timeline,
      currentBlock,
      lastProcessedBlock,
      windowStartBlock: latestOutcome.blockNumber,
      windowEndBlock: latestOutcome.blockNumber,
      blocks: [latestOutcome],
    }
  }

  if (lastProcessedBlock < previousLastProcessed) {
    return {
      ...timeline,
      currentBlock,
    }
  }

  if (lastProcessedBlock === previousLastProcessed) {
    if (!latestOutcome || latestOutcome.blockNumber !== lastProcessedBlock) {
      return {
        ...timeline,
        currentBlock,
      }
    }

    const blocks = timeline.blocks.map((block) => block.blockNumber === latestOutcome.blockNumber ? latestOutcome : block)
    return {
      ...timeline,
      currentBlock,
      lastProcessedBlock,
      blocks,
    }
  }

  if (lastProcessedBlock !== previousLastProcessed + 1 || !latestOutcome || latestOutcome.blockNumber !== lastProcessedBlock) {
    return null
  }

  const previousBlocks = timeline.blocks.filter((block) => block.blockNumber !== latestOutcome.blockNumber)
  const blocks = [...previousBlocks, latestOutcome]
  const trimmedBlocks = blocks.length > TIMELINE_FETCH_LIMIT ? blocks.slice(blocks.length - TIMELINE_FETCH_LIMIT) : blocks

  return {
    ...timeline,
    currentBlock,
    lastProcessedBlock,
    windowStartBlock: trimmedBlocks[0]?.blockNumber ?? timeline.windowStartBlock,
    windowEndBlock: latestOutcome.blockNumber,
    blocks: trimmedBlocks,
  }
}

function getDisplayEndBlock(snapshot: TimelineSnapshot) {
  const { currentBlock, firstBlockNumber, lastProcessedBlock } = snapshot

  if (currentBlock !== null) {
    const displayEnd = currentBlock + FUTURE_WINDOW_BLOCKS - 1
    return Math.max(firstBlockNumber ?? displayEnd, displayEnd)
  }

  if (lastProcessedBlock !== null) {
    const displayEnd = lastProcessedBlock + FUTURE_WINDOW_BLOCKS
    return Math.max(firstBlockNumber ?? displayEnd, displayEnd)
  }

  const candidates = [firstBlockNumber].filter(
    (value): value is number => value !== null,
  )
  if (candidates.length === 0) return null
  return Math.max(...candidates)
}

function getTotalBlockCount(snapshot: TimelineSnapshot) {
  const firstBlock = snapshot.firstBlockNumber
  const displayEndBlock = getDisplayEndBlock(snapshot)
  if (firstBlock === null || displayEndBlock === null || displayEndBlock < firstBlock) return 1
  return displayEndBlock - firstBlock + 1
}

function resolveBlockVisual(snapshot: TimelineSnapshot, blockNumber: number) {
  if (snapshot.currentBlock !== null && blockNumber >= snapshot.currentBlock) {
    return { kind: "future" as const, outcome: null }
  }

  const outcome = snapshot.blocksByNumber.get(blockNumber)
  if (outcome?.status === "won") return { kind: "won" as const, outcome }
  if (outcome?.status === "missed") return { kind: "missed" as const, outcome }
  return { kind: "future" as const, outcome: null }
}

function applyBlockVisualState(item: BlockPoolItem, kind: BlockVisualKind) {
  if (kind === "won") {
    item.frontMaterial.color.setHex(WON_FRONT_FACE_COLOR)
    item.frontMaterial.emissive.setHex(WON_DEPTH_FACE_EMISSIVE)
    item.frontMaterial.emissiveIntensity = 0.22
    item.depthMaterial.color.setHex(WON_DEPTH_FACE_COLOR)
    item.depthMaterial.emissive.setHex(WON_DEPTH_FACE_EMISSIVE)
    item.depthMaterial.emissiveIntensity = 0.18
    item.edgeMaterial.color.setHex(WON_EDGE_COLOR)
    item.glowMaterial.color.setHex(WON_EDGE_GLOW_COLOR)
    item.glowMaterial.opacity = 0.38
    return
  }

  if (kind === "missed") {
    item.frontMaterial.color.setHex(MISSED_FRONT_FACE_COLOR)
    item.frontMaterial.emissive.setHex(MISSED_DEPTH_FACE_EMISSIVE)
    item.frontMaterial.emissiveIntensity = 0.12
    item.depthMaterial.color.setHex(MISSED_DEPTH_FACE_COLOR)
    item.depthMaterial.emissive.setHex(MISSED_DEPTH_FACE_EMISSIVE)
    item.depthMaterial.emissiveIntensity = 0.1
    item.edgeMaterial.color.setHex(MISSED_EDGE_COLOR)
    item.glowMaterial.color.setHex(MISSED_EDGE_GLOW_COLOR)
    item.glowMaterial.opacity = 0.16
    return
  }

  item.frontMaterial.color.setHex(FUTURE_FRONT_FACE_COLOR)
  item.frontMaterial.emissive.setHex(FUTURE_DEPTH_FACE_EMISSIVE)
  item.frontMaterial.emissiveIntensity = 0.12
  item.depthMaterial.color.setHex(FUTURE_DEPTH_FACE_COLOR)
  item.depthMaterial.emissive.setHex(FUTURE_DEPTH_FACE_EMISSIVE)
  item.depthMaterial.emissiveIntensity = 0.08
  item.edgeMaterial.color.setHex(FUTURE_EDGE_COLOR)
  item.glowMaterial.color.setHex(FUTURE_EDGE_GLOW_COLOR)
  item.glowMaterial.opacity = 0.22
}

function createObliqueBlockGeometry(
  width: number,
  height: number,
  depth: number,
  skewX: number,
  skewY: number,
) {
  const halfWidth = width / 2
  const halfHeight = height / 2
  const frontZ = depth / 2
  const backZ = -depth / 2

  const frontBottomLeft = [-halfWidth, -halfHeight, frontZ]
  const frontBottomRight = [halfWidth, -halfHeight, frontZ]
  const frontTopRight = [halfWidth, halfHeight, frontZ]
  const frontTopLeft = [-halfWidth, halfHeight, frontZ]

  const backBottomLeft = [-halfWidth - skewX, -halfHeight + skewY, backZ]
  const backTopLeft = [-halfWidth - skewX, halfHeight + skewY, backZ]
  const backTopRight = [halfWidth - skewX, halfHeight + skewY, backZ]

  const vertices = new Float32Array([
    ...frontBottomLeft, ...frontBottomRight, ...frontTopRight,
    ...frontBottomLeft, ...frontTopRight, ...frontTopLeft,

    ...frontTopLeft, ...frontTopRight, ...backTopRight,
    ...frontTopLeft, ...backTopRight, ...backTopLeft,

    ...frontBottomLeft, ...frontTopLeft, ...backTopLeft,
    ...frontBottomLeft, ...backTopLeft, ...backBottomLeft,
  ])

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3))
  geometry.clearGroups()
  geometry.addGroup(0, 6, 0)
  geometry.addGroup(6, 6, 1)
  geometry.addGroup(12, 6, 1)
  geometry.computeVertexNormals()
  return geometry
}

function createBlockLabelState() {
  const canvas = document.createElement("canvas")
  canvas.width = 768
  canvas.height = 320

  const context = canvas.getContext("2d")
  if (!context) return null

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = false

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })

  const sprite = new THREE.Sprite(material)
  sprite.position.set(0, BLOCK_HEIGHT / 2 - 1.9 * DISPLAY_SCALE, BLOCK_DEPTH / 2 + 0.16 * DISPLAY_SCALE)
  sprite.scale.set(BLOCK_WIDTH * 0.96, 3.45 * DISPLAY_SCALE, 1)
  sprite.renderOrder = 8

  return {
    canvas,
    context,
    texture,
    material,
    sprite,
    text: "",
  }
}

function getBlockClaimLabel(block: TimelineBlock) {
  if (block.status === "won") return block.claimed ? "CLAIMED" : "NOT CLAIMED"
  return "NO CLAIM"
}

function buildBlockLabelContent(blockNumber: number, outcome: TimelineBlock | null, kind: BlockVisualKind): BlockLabelContent {
  return {
    primary: blockNumber.toLocaleString("en-US"),
    secondary: outcome ? `PWR ${formatPowerValue(outcome.eligiblePowerTotal)}` : null,
    tertiary: outcome ? getBlockClaimLabel(outcome) : null,
    kind,
  }
}

function drawBlockLabel(label: BlockLabelState, content: BlockLabelContent) {
  const cacheKey = `${content.kind}|${content.primary}|${content.secondary ?? ""}|${content.tertiary ?? ""}`
  if (label.text === cacheKey) return

  const { canvas, context, texture } = label
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.textAlign = "center"
  context.textBaseline = "middle"

  const hasDetails = Boolean(content.secondary || content.tertiary)
  const primaryY = hasDetails ? canvas.height * 0.18 : canvas.height * 0.5
  const secondaryY = canvas.height * 0.57
  const tertiaryY = canvas.height * 0.9

  context.font = `400 ${hasDetails ? 72 : 90}px ${BLOCK_LABEL_FONT_FAMILY}`
  context.fillStyle = "rgba(234, 255, 244, 0.98)"
  context.shadowColor = "rgba(78, 255, 159, 0.42)"
  context.shadowBlur = 20
  context.fillText(content.primary, canvas.width / 2, primaryY)

  if (content.secondary) {
    context.font = `400 64px ${BLOCK_LABEL_FONT_FAMILY}`
    context.fillStyle = "rgba(213, 223, 231, 0.94)"
    context.shadowColor = "rgba(157, 224, 255, 0.18)"
    context.shadowBlur = 14
    context.fillText(content.secondary, canvas.width / 2, secondaryY)
  }

  if (content.tertiary) {
    context.font = `400 60px ${BLOCK_LABEL_FONT_FAMILY}`
    context.fillStyle = content.kind === "won"
      ? "rgba(120, 255, 176, 0.98)"
      : content.kind === "missed"
        ? "rgba(222, 229, 238, 0.94)"
        : "rgba(183, 255, 213, 0.96)"
    context.shadowColor = content.kind === "won"
      ? "rgba(120, 255, 176, 0.24)"
      : "rgba(183, 255, 213, 0.14)"
    context.shadowBlur = 14
    context.fillText(content.tertiary, canvas.width / 2, tertiaryY)
  }

  texture.needsUpdate = true
  label.text = cacheKey
}

export function Mining3DBlocks({ currentBlock = null, streamTimeline = null }: Mining3DBlocksProps) {
  const mountRef = useRef<HTMLDivElement>(null)
  const renderSnapshotRef = useRef<TimelineSnapshot>(buildTimelineSnapshot(null, currentBlock))
  const pendingSnapshotRef = useRef<TimelineSnapshot | null>(null)
  const followLiveRef = useRef(true)
  const lastDisplayEndBlockRef = useRef<number | null>(null)
  const conveyorRef = useRef<ConveyorAnimationState>({ active: false, startTime: 0, confirmedBlock: null })
  const [timeline, setTimeline] = useState<TimelineResponse | null>(null)
  const [selectedBlock, setSelectedBlock] = useState<TimelineBlock | null>(null)
  const effectiveCurrentBlock = streamTimeline?.currentBlock ?? currentBlock

  const loadTimeline = useCallback(async () => {
    try {
      const data = await fetchJson<TimelineResponse>(`/api/mining/timeline?limit=${TIMELINE_FETCH_LIMIT}`, { cache: "no-store" })
      setTimeline(data)
    } catch {
      setTimeline((value) => value)
    }
  }, [])

  useEffect(() => {
    void loadTimeline()
  }, [loadTimeline])

  useEffect(() => {
    if (!streamTimeline) return

    setTimeline((value) => {
      const merged = mergeStreamTimeline(value, streamTimeline, currentBlock)
      if (!merged) {
        void loadTimeline()
        return value
      }
      return merged
    })
  }, [currentBlock, loadTimeline, streamTimeline])

  useEffect(() => {
    const nextSnapshot = buildTimelineSnapshot(timeline, effectiveCurrentBlock)
    const currentSnapshot = renderSnapshotRef.current

    if (conveyorRef.current.active) {
      if (pendingSnapshotRef.current?.lastProcessedBlock === nextSnapshot.lastProcessedBlock) {
        pendingSnapshotRef.current = nextSnapshot
        return
      }

      conveyorRef.current = { active: false, startTime: 0, confirmedBlock: null }
      pendingSnapshotRef.current = null
    }

    const currentBlockNumber = currentSnapshot.currentBlock
    const nextBlockNumber = nextSnapshot.currentBlock
    const canAnimate = followLiveRef.current
      && currentBlockNumber !== null
      && nextBlockNumber !== null
      && nextBlockNumber === currentBlockNumber + 1
      && nextSnapshot.blocksByNumber.has(currentBlockNumber)

    if (canAnimate) {
      pendingSnapshotRef.current = nextSnapshot
      conveyorRef.current = {
        active: true,
        startTime: performance.now(),
        confirmedBlock: currentBlockNumber,
      }
      return
    }

    renderSnapshotRef.current = nextSnapshot
    pendingSnapshotRef.current = null
    lastDisplayEndBlockRef.current = null
  }, [effectiveCurrentBlock, timeline])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const scene = new THREE.Scene()
    scene.fog = new THREE.Fog(SCENE_FOG_COLOR, 16, 44)

    const camera = new THREE.OrthographicCamera(-10, 10, ORTHO_HALF_HEIGHT, -ORTHO_HALF_HEIGHT, 0.1, 100)
    camera.position.set(0, 0, 18)
    camera.lookAt(0, 0, 0)

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    })
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.domElement.style.width = "100%"
    renderer.domElement.style.height = "100%"
    renderer.domElement.style.display = "block"
    renderer.domElement.style.touchAction = "none"
    mount.appendChild(renderer.domElement)

    const root = new THREE.Group()
    scene.add(root)

    const ambientLight = new THREE.AmbientLight(0x6fe0b2, 0.34)
    const keyLight = new THREE.DirectionalLight(0x8deeff, 0.58)
    keyLight.position.set(14, 20, 10)
    const rimLight = new THREE.DirectionalLight(0x2f8f5d, 0.42)
    rimLight.position.set(-10, 8, -14)
    scene.add(ambientLight, keyLight, rimLight)

    const blockStrip = new THREE.Group()
    root.add(blockStrip)

    const confirmationDivider = new THREE.Group()
    root.add(confirmationDivider)

    const blockGeometry = createObliqueBlockGeometry(
      BLOCK_WIDTH,
      BLOCK_HEIGHT,
      BLOCK_DEPTH,
      BLOCK_SKEW_X,
      BLOCK_SKEW_Y,
    )
    const edgeGeometry = new THREE.EdgesGeometry(blockGeometry)
    const dividerGeometry = new THREE.PlaneGeometry(0.08 * DISPLAY_SCALE, BLOCK_HEIGHT + 4.4 * DISPLAY_SCALE)
    const dividerGlowGeometry = new THREE.PlaneGeometry(0.34 * DISPLAY_SCALE, BLOCK_HEIGHT + 4.9 * DISPLAY_SCALE)

    const dividerMaterial = new THREE.MeshBasicMaterial({
      color: DIVIDER_COLOR,
      transparent: true,
      opacity: 0.94,
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: false,
    })
    const dividerGlowMaterial = new THREE.MeshBasicMaterial({
      color: DIVIDER_GLOW_COLOR,
      transparent: true,
      opacity: 0.24,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    })

    const dividerGlow = new THREE.Mesh(dividerGlowGeometry, dividerGlowMaterial)
    dividerGlow.renderOrder = 4
    confirmationDivider.add(dividerGlow)

    const dividerCore = new THREE.Mesh(dividerGeometry, dividerMaterial)
    dividerCore.renderOrder = 5
    confirmationDivider.add(dividerCore)

    const blockPool: BlockPoolItem[] = []

    for (let slot = 0; slot < MAX_VISIBLE_BLOCKS; slot += 1) {
      const group = new THREE.Group()
      group.visible = false

      const frontMaterial = new THREE.MeshPhongMaterial({
        color: FUTURE_FRONT_FACE_COLOR,
        emissive: FUTURE_DEPTH_FACE_EMISSIVE,
        emissiveIntensity: 0.12,
        side: THREE.DoubleSide,
        shininess: 18,
      })
      const depthMaterial = new THREE.MeshPhongMaterial({
        color: FUTURE_DEPTH_FACE_COLOR,
        emissive: FUTURE_DEPTH_FACE_EMISSIVE,
        emissiveIntensity: 0.08,
        side: THREE.DoubleSide,
        shininess: 10,
      })
      const faces = new THREE.Mesh(blockGeometry, [frontMaterial, depthMaterial])
      group.add(faces)

      const edgeMaterial = new THREE.LineBasicMaterial({
        color: FUTURE_EDGE_COLOR,
        transparent: true,
        opacity: 0.98,
        toneMapped: false,
      })
      const edges = new THREE.LineSegments(edgeGeometry, edgeMaterial)
      group.add(edges)

      const glowMaterial = new THREE.LineBasicMaterial({
        color: FUTURE_EDGE_GLOW_COLOR,
        transparent: true,
        opacity: 0.22,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      })
      const glowEdges = new THREE.LineSegments(edgeGeometry, glowMaterial)
      glowEdges.scale.setScalar(1.04)
      group.add(glowEdges)

      const label = createBlockLabelState()
      if (label) {
        label.sprite.visible = false
        group.add(label.sprite)
      }

      blockStrip.add(group)
      blockPool.push({ group, frontMaterial, depthMaterial, edgeMaterial, glowMaterial, label, logicalIndex: -1 })
    }

    const dragState = {
      active: false,
      pointerId: null as number | null,
      startX: 0,
      startY: 0,
      startOffset: 0,
      currentOffset: 0,
      targetOffset: 0,
      moved: false,
    }
    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()

    const blockHalfSpanX = BLOCK_WIDTH / 2 + BLOCK_SKEW_X

    const getBlockX = (index: number) => INITIAL_BLOCK_X + index * BLOCK_SPACING

    const latestAlignedOffset = (snapshot = renderSnapshotRef.current, totalBlockCount = getTotalBlockCount(snapshot)) => {
      const firstBlockNumber = snapshot.firstBlockNumber
      const dividerBlockNumber = firstBlockNumber === null ? null : getDividerBlockNumber(snapshot)
      if (firstBlockNumber === null || dividerBlockNumber === null) return 0

      const dividerIndex = dividerBlockNumber - firstBlockNumber
      return clampOffset(-(getBlockX(dividerIndex) + BLOCK_SPACING / 2), totalBlockCount)
    }

    const clampOffset = (value: number, totalBlockCount = getTotalBlockCount(renderSnapshotRef.current)) => {
      const maxOffset = camera.right - blockHalfSpanX - getBlockX(0)
      const minOffset = camera.left - blockHalfSpanX - getBlockX(Math.max(0, totalBlockCount - 1))
      return THREE.MathUtils.clamp(value, minOffset, maxOffset)
    }

    const updateVisibleBlocks = () => {
      const timelineState = renderSnapshotRef.current
      const pendingTimelineState = pendingSnapshotRef.current
      const conveyor = conveyorRef.current
      const conveyorActive = conveyor.active && pendingTimelineState !== null && conveyor.confirmedBlock !== null
      const conveyorProgress = conveyorActive
        ? THREE.MathUtils.clamp((performance.now() - conveyor.startTime) / CONVEYOR_DURATION_MS, 0, 1)
        : 0
      const conveyorOffset = conveyorActive ? -BLOCK_SPACING * conveyorProgress : 0
      const firstBlockNumber = timelineState.firstBlockNumber
      const totalBlockCount = getTotalBlockCount(timelineState) + (conveyorActive ? 1 : 0)
      const leftLimit = camera.left - blockHalfSpanX - BLOCK_SPACING * VISIBLE_BUFFER_BLOCKS
      const rightLimit = camera.right + blockHalfSpanX + BLOCK_SPACING * VISIBLE_BUFFER_BLOCKS
      const visibleLeft = leftLimit - dragState.currentOffset
      const visibleRight = rightLimit - dragState.currentOffset

      let logicalIndex = THREE.MathUtils.clamp(
        Math.floor((visibleLeft - INITIAL_BLOCK_X) / BLOCK_SPACING) - 1,
        0,
        Math.max(0, totalBlockCount - 1),
      )

      while (logicalIndex > 0 && getBlockX(logicalIndex) > visibleLeft) {
        logicalIndex -= 1
      }
      while (logicalIndex < totalBlockCount - 1 && getBlockX(logicalIndex + 1) < visibleLeft) {
        logicalIndex += 1
      }

      let poolIndex = 0
      while (logicalIndex < totalBlockCount && poolIndex < blockPool.length) {
        const blockX = getBlockX(logicalIndex)
        if (blockX > visibleRight) break

        const blockNumber = firstBlockNumber === null ? null : firstBlockNumber + logicalIndex
        let visual = blockNumber === null ? { kind: "future" as const, outcome: null } : resolveBlockVisual(timelineState, blockNumber)
        const isConveyorBlock = conveyorActive && blockNumber === conveyor.confirmedBlock
        if (isConveyorBlock && pendingTimelineState) {
          const pendingOutcome = pendingTimelineState.blocksByNumber.get(blockNumber)
          if (pendingOutcome) {
            visual = conveyorProgress < CONVEYOR_CONFIRM_SWITCH_PROGRESS
              ? { kind: "future" as const, outcome: null }
              : { kind: pendingOutcome.status, outcome: pendingOutcome }
          }
        }

        const item = blockPool[poolIndex]
        item.group.visible = true
        item.group.position.set(blockX + dragState.currentOffset + conveyorOffset, 0, 0)
        item.group.scale.setScalar(1)
        item.logicalIndex = logicalIndex
        item.group.userData.blockNumber = blockNumber
        item.group.userData.interactive = Boolean(visual.outcome)
        applyBlockVisualState(item, visual.kind)

        if (isConveyorBlock && conveyorProgress >= CONVEYOR_CONFIRM_SWITCH_PROGRESS) {
          const pulseProgress = THREE.MathUtils.clamp(
            (conveyorProgress - CONVEYOR_CONFIRM_SWITCH_PROGRESS) / (1 - CONVEYOR_CONFIRM_SWITCH_PROGRESS),
            0,
            1,
          )
          const pulse = Math.sin(pulseProgress * Math.PI) * CONVEYOR_POP_SCALE
          item.group.scale.setScalar(1 + pulse)
          item.group.position.z = pulse * 1.8 * DISPLAY_SCALE
          item.glowMaterial.opacity = Math.min(1, item.glowMaterial.opacity + pulse * 3.2)
          item.frontMaterial.emissiveIntensity = Math.min(0.7, item.frontMaterial.emissiveIntensity + pulse * 2.4)
          item.depthMaterial.emissiveIntensity = Math.min(0.62, item.depthMaterial.emissiveIntensity + pulse * 1.9)
        }

        if (item.label) {
          if (blockNumber !== null && blockNumber >= 0) {
            item.label.sprite.visible = true
            drawBlockLabel(item.label, buildBlockLabelContent(blockNumber, visual.outcome, visual.kind))
          } else {
            item.label.sprite.visible = false
          }
        }

        poolIndex += 1
        logicalIndex += 1
      }

      for (; poolIndex < blockPool.length; poolIndex += 1) {
        const item = blockPool[poolIndex]
        item.group.visible = false
        item.logicalIndex = -1
        item.group.userData.blockNumber = null
        item.group.userData.interactive = false
        item.group.scale.setScalar(1)
        if (item.label) {
          item.label.sprite.visible = false
        }
      }

      const dividerBlockNumber = firstBlockNumber === null ? null : getDividerBlockNumber(timelineState)
      const dividerIndex = firstBlockNumber !== null && dividerBlockNumber !== null
        ? dividerBlockNumber - firstBlockNumber
        : null
      confirmationDivider.visible = dividerIndex !== null && dividerIndex >= 0 && dividerIndex < totalBlockCount
      confirmationDivider.position.set(0, 0, BLOCK_DEPTH / 2 + 0.2)
    }

    const invalidateBlockLabels = () => {
      for (const item of blockPool) {
        if (item.label) item.label.text = ""
      }
    }

    const resize = () => {
      const width = mount.clientWidth || window.innerWidth
      const height = mount.clientHeight || Math.max(window.innerHeight * 0.35, 220)
      const aspect = width / Math.max(height, 1)
      camera.left = -ORTHO_HALF_HEIGHT * aspect
      camera.right = ORTHO_HALF_HEIGHT * aspect
      camera.top = ORTHO_HALF_HEIGHT
      camera.bottom = -ORTHO_HALF_HEIGHT
      camera.updateProjectionMatrix()
      renderer.setSize(width, height, false)
      const totalBlockCount = getTotalBlockCount(renderSnapshotRef.current)
      if (followLiveRef.current) {
        const alignedOffset = latestAlignedOffset(renderSnapshotRef.current, totalBlockCount)
        dragState.targetOffset = alignedOffset
        dragState.currentOffset = alignedOffset
      } else {
        dragState.targetOffset = clampOffset(dragState.targetOffset, totalBlockCount)
        dragState.currentOffset = clampOffset(dragState.currentOffset, totalBlockCount)
      }
      updateVisibleBlocks()
    }

    const pickBlock = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointer, camera)
      const intersects = raycaster.intersectObjects(blockPool.map((item) => item.group), true)

      for (const hit of intersects) {
        let current: THREE.Object3D | null = hit.object
        while (current) {
          const blockNumber = current.userData.blockNumber as number | null | undefined
          if (typeof blockNumber === "number") {
            const outcome = renderSnapshotRef.current.blocksByNumber.get(blockNumber) ?? pendingSnapshotRef.current?.blocksByNumber.get(blockNumber)
            if (outcome) {
              setSelectedBlock(outcome)
              return
            }
          }
          current = current.parent
        }
      }
    }

    const handlePointerDown = (event: PointerEvent) => {
      dragState.active = true
      dragState.pointerId = event.pointerId
      dragState.startX = event.clientX
      dragState.startY = event.clientY
      dragState.startOffset = dragState.targetOffset
      dragState.moved = false
      renderer.domElement.setPointerCapture(event.pointerId)
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (!dragState.active || dragState.pointerId !== event.pointerId) return
      const deltaX = event.clientX - dragState.startX
      const deltaY = event.clientY - dragState.startY
      if (Math.abs(deltaX) > CLICK_MOVE_THRESHOLD || Math.abs(deltaY) > CLICK_MOVE_THRESHOLD) {
        dragState.moved = true
      }
      const totalBlockCount = getTotalBlockCount(renderSnapshotRef.current)
      dragState.targetOffset = clampOffset(dragState.startOffset + deltaX * DRAG_SENSITIVITY, totalBlockCount)
      if (Math.abs(dragState.targetOffset - latestAlignedOffset(renderSnapshotRef.current, totalBlockCount)) > BLOCK_SPACING * 1.5) {
        followLiveRef.current = false
      }
    }

    const finishPointerDrag = (event: PointerEvent) => {
      if (dragState.pointerId !== event.pointerId) return
      const wasClick = !dragState.moved
      dragState.active = false
      dragState.pointerId = null
      if (renderer.domElement.hasPointerCapture(event.pointerId)) {
        renderer.domElement.releasePointerCapture(event.pointerId)
      }
      const totalBlockCount = getTotalBlockCount(renderSnapshotRef.current)
      if (Math.abs(dragState.targetOffset - latestAlignedOffset(renderSnapshotRef.current, totalBlockCount)) <= BLOCK_SPACING) {
        followLiveRef.current = true
      }
      if (wasClick) pickBlock(event)
    }

    resize()
    window.addEventListener("resize", resize)
    renderer.domElement.addEventListener("pointerdown", handlePointerDown)
    renderer.domElement.addEventListener("pointermove", handlePointerMove)
    renderer.domElement.addEventListener("pointerup", finishPointerDrag)
    renderer.domElement.addEventListener("pointercancel", finishPointerDrag)

    let disposed = false
    if ("fonts" in document) {
      void document.fonts.load(BLOCK_LABEL_FONT_LOAD).then(() => {
        if (disposed) return
        invalidateBlockLabels()
        updateVisibleBlocks()
        renderer.render(scene, camera)
      }).catch(() => {})
    }

    let frameId = 0
    const renderFrame = () => {
      if (conveyorRef.current.active && pendingSnapshotRef.current) {
        const progress = THREE.MathUtils.clamp((performance.now() - conveyorRef.current.startTime) / CONVEYOR_DURATION_MS, 0, 1)
        if (progress >= 1) {
          dragState.currentOffset -= BLOCK_SPACING
          dragState.targetOffset -= BLOCK_SPACING
          renderSnapshotRef.current = pendingSnapshotRef.current
          pendingSnapshotRef.current = null
          conveyorRef.current = { active: false, startTime: 0, confirmedBlock: null }
          lastDisplayEndBlockRef.current = null
        }
      }

      const totalBlockCount = getTotalBlockCount(renderSnapshotRef.current)
      const displayEndBlock = getDisplayEndBlock(renderSnapshotRef.current)
      if (displayEndBlock !== lastDisplayEndBlockRef.current) {
        if (followLiveRef.current) {
          dragState.targetOffset = latestAlignedOffset(renderSnapshotRef.current, totalBlockCount)
        } else {
          dragState.targetOffset = clampOffset(dragState.targetOffset, totalBlockCount)
        }
        lastDisplayEndBlockRef.current = displayEndBlock
      }

      dragState.currentOffset = THREE.MathUtils.lerp(
        dragState.currentOffset,
        dragState.targetOffset,
        DRAG_SMOOTHING,
      )
      if (Math.abs(dragState.currentOffset - dragState.targetOffset) < 0.001) {
        dragState.currentOffset = dragState.targetOffset
      }
      updateVisibleBlocks()

      renderer.render(scene, camera)
      frameId = window.requestAnimationFrame(renderFrame)
    }
    renderFrame()

    return () => {
      disposed = true
      window.cancelAnimationFrame(frameId)
      window.removeEventListener("resize", resize)
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown)
      renderer.domElement.removeEventListener("pointermove", handlePointerMove)
      renderer.domElement.removeEventListener("pointerup", finishPointerDrag)
      renderer.domElement.removeEventListener("pointercancel", finishPointerDrag)
      dividerGeometry.dispose()
      dividerGlowGeometry.dispose()
      blockGeometry.dispose()
      edgeGeometry.dispose()
      dividerMaterial.dispose()
      dividerGlowMaterial.dispose()
      for (const item of blockPool) {
        item.frontMaterial.dispose()
        item.depthMaterial.dispose()
        item.edgeMaterial.dispose()
        item.glowMaterial.dispose()
        item.label?.texture.dispose()
        item.label?.material.dispose()
      }
      renderer.dispose()
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement)
      }
    }
  }, [])

  return (
    <>
      <div ref={mountRef} className="absolute inset-0" aria-label="Interactive 3D mining blocks" />
      {selectedBlock && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-xl border border-sentinel/25 bg-card/95 p-5 text-sm text-foreground shadow-2xl shadow-sentinel/15">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Mining Block</div>
                <h3 className="mt-2 font-pixel text-xl text-sentinel">#{selectedBlock.blockNumber.toLocaleString()}</h3>
              </div>
              <button
                type="button"
                className="rounded-md border border-sentinel/20 px-2 py-1 text-xs text-muted-foreground hover:border-sentinel/40 hover:text-foreground"
                onClick={() => setSelectedBlock(null)}
              >
                Close
              </button>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-sentinel/15 bg-background/60 p-3">
                <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Status</div>
                <div className="mt-2 text-base text-foreground">{selectedBlock.status === "won" ? "Won" : "Missed"}</div>
              </div>
              <div className="rounded-lg border border-sentinel/15 bg-background/60 p-3">
                <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Block Time</div>
                <div className="mt-2 text-base text-foreground">{formatDateTime(selectedBlock.blockTimestamp)}</div>
              </div>
              <div className="rounded-lg border border-sentinel/15 bg-background/60 p-3">
                <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Winner</div>
                <div className="mt-2 break-all text-base text-foreground">{selectedBlock.winner ? compactValue(selectedBlock.winner) : "No winner"}</div>
              </div>
              <div className="rounded-lg border border-sentinel/15 bg-background/60 p-3">
                <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Winner Power</div>
                <div className="mt-2 text-base text-foreground">{formatPowerValue(selectedBlock.winnerPower)}</div>
              </div>
              <div className="rounded-lg border border-sentinel/15 bg-background/60 p-3">
                <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Eligible Miners</div>
                <div className="mt-2 text-base text-foreground">{selectedBlock.eligibleWalletCount.toLocaleString()}</div>
              </div>
              <div className="rounded-lg border border-sentinel/15 bg-background/60 p-3">
                <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Total Power Used</div>
                <div className="mt-2 text-base text-foreground">{formatPowerValue(selectedBlock.eligiblePowerTotal)}</div>
              </div>
              <div className="rounded-lg border border-sentinel/15 bg-background/60 p-3">
                <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Claim Status</div>
                <div className="mt-2 text-base text-foreground">
                  {selectedBlock.status === "won" ? (selectedBlock.claimed ? "Claimed" : "Not claimed") : "Not claimable"}
                </div>
              </div>
            </div>

            <div className="mt-4 rounded-lg border border-sentinel/15 bg-background/60 p-3 text-xs text-muted-foreground">
              <div>Hash: <span className="break-all text-foreground">{compactValue(selectedBlock.blockHash)}</span></div>
              <div className="mt-2">
                {selectedBlock.status === "won"
                  ? `Reward: ${selectedBlock.reward ?? "-"} SENTI`
                  : `Miss reason: ${selectedBlock.missReason === "no_eligible_power" ? "No eligible miners were online." : "No outcome data."}`}
              </div>
              {selectedBlock.claimedTxHash && (
                <div className="mt-2">Claim Tx: <span className="break-all text-foreground">{compactValue(selectedBlock.claimedTxHash)}</span></div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
