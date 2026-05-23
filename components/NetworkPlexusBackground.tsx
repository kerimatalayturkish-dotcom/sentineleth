"use client"

import { useRef, useMemo } from "react"
import { Canvas, useFrame } from "@react-three/fiber"
import * as THREE from "three"

const PARTICLE_COUNT = 250 // optimal count to prevent slowing down
const MAX_DISTANCE = 3.5   // connect points if they are closer than this

function seededRandom(seed: number) {
  const value = Math.sin(seed) * 10000
  return value - Math.floor(value)
}

function randomRange(seed: number, min: number, max: number) {
  return min + seededRandom(seed) * (max - min)
}

function PlexusNetwork() {
  const pointsRef = useRef<THREE.Points>(null)
  const linesRef = useRef<THREE.LineSegments>(null)

  // Initialize particle positions and velocities
  const [positions, velocities] = useMemo(() => {
    const pos = new Float32Array(PARTICLE_COUNT * 3)
    const vel = new Float32Array(PARTICLE_COUNT * 3)

    for (let i = 0; i < PARTICLE_COUNT; i++) {
        // spread widely across the screen
          pos[i * 3] = randomRange(i * 6 + 1, -15, 15)
          pos[i * 3 + 1] = randomRange(i * 6 + 2, -15, 15)
          pos[i * 3 + 2] = randomRange(i * 6 + 3, -7.5, 7.5)
        
        // slow movement speed
          vel[i * 3] = randomRange(i * 6 + 4, -0.01, 0.01)
          vel[i * 3 + 1] = randomRange(i * 6 + 5, -0.01, 0.01)
          vel[i * 3 + 2] = randomRange(i * 6 + 6, -0.01, 0.01)
    }
    return [pos, vel]
  }, [])
        const velocitiesRef = useRef(velocities)

  // Line positions array (max possible lines = N * (N-1) / 2) -> using a generous buffer
  const maxLines = PARTICLE_COUNT * 15 // Assuming each connects to ~15 nodes max
  const linePositions = useMemo(() => new Float32Array(maxLines * 6), [maxLines])

  useFrame((state) => {
    if (!pointsRef.current || !linesRef.current) return

    // 1. Move particles
    for (let i = 0; i < PARTICLE_COUNT; i++) {
        const positionAttribute = pointsRef.current.geometry.attributes.position
        const positionArray = positionAttribute.array as Float32Array
        const velocityArray = velocitiesRef.current

        positionArray[i * 3] += velocityArray[i * 3]
        positionArray[i * 3 + 1] += velocityArray[i * 3 + 1]
        positionArray[i * 3 + 2] += velocityArray[i * 3 + 2]

        // Bounce back if they go too far out of bounds
        if (Math.abs(positionArray[i * 3]) > 20) velocityArray[i * 3] *= -1
        if (Math.abs(positionArray[i * 3 + 1]) > 20) velocityArray[i * 3 + 1] *= -1
        if (Math.abs(positionArray[i * 3 + 2]) > 10) velocityArray[i * 3 + 2] *= -1
    }
    pointsRef.current.geometry.attributes.position.needsUpdate = true

      const positionArray = pointsRef.current.geometry.attributes.position.array as Float32Array
      const lineAttribute = linesRef.current.geometry.attributes.position
      const lineArray = lineAttribute.array as Float32Array

    // 2. Connect nearby particles
    let lineIndex = 0
    for (let i = 0; i < PARTICLE_COUNT; i++) {
        for (let j = i + 1; j < PARTICLE_COUNT; j++) {
          const dx = positionArray[i * 3] - positionArray[j * 3]
          const dy = positionArray[i * 3 + 1] - positionArray[j * 3 + 1]
          const dz = positionArray[i * 3 + 2] - positionArray[j * 3 + 2]
            const distSq = dx * dx + dy * dy + dz * dz

            if (distSq < MAX_DISTANCE * MAX_DISTANCE && lineIndex < maxLines * 6) {
                // Point A
            lineArray[lineIndex++] = positionArray[i * 3]
            lineArray[lineIndex++] = positionArray[i * 3 + 1]
            lineArray[lineIndex++] = positionArray[i * 3 + 2]
                
                // Point B
            lineArray[lineIndex++] = positionArray[j * 3]
            lineArray[lineIndex++] = positionArray[j * 3 + 1]
            lineArray[lineIndex++] = positionArray[j * 3 + 2]
            }
        }
    }
    
    // Update line geometries
    linesRef.current.geometry.setDrawRange(0, lineIndex / 3) // 3 vertices per point
    linesRef.current.geometry.attributes.position.needsUpdate = true

    // 3. Interactive Camera Parallax with mouse
    state.camera.position.x += (state.pointer.x * 2 - state.camera.position.x) * 0.05
    state.camera.position.y += (state.pointer.y * 2 - state.camera.position.y) * 0.05
    state.camera.lookAt(0, 0, 0)
  })

  return (
    <group>
      <points ref={pointsRef}>
        <bufferGeometry>
          <bufferAttribute 
            attach="attributes-position" 
            args={[positions, 3]}
            count={PARTICLE_COUNT} 
            array={positions} 
            itemSize={3} 
          />
        </bufferGeometry>
        <pointsMaterial 
          color="#00ff9d" 
          size={0.12} 
          transparent 
          opacity={0.8} 
          sizeAttenuation={true} 
          blending={THREE.AdditiveBlending}
        />
      </points>

      <lineSegments ref={linesRef}>
        <bufferGeometry>
          <bufferAttribute 
            attach="attributes-position" 
            args={[linePositions, 3]}
            count={maxLines * 2} 
            array={linePositions} 
            itemSize={3} 
          />
        </bufferGeometry>
        <lineBasicMaterial 
          color="#00ff9d" 
          transparent 
          opacity={0.15} 
          blending={THREE.AdditiveBlending}
        />
      </lineSegments>
    </group>
  )
}

export function NetworkPlexusBackground() {
  return (
    <div className="fixed inset-0 z-[-1] bg-[#030305] pointer-events-none">
      <Canvas camera={{ position: [0, 0, 15], fov: 60 }}>
        {/* Subtle fog so nodes in the far back fade out natively */}
        <fog attach="fog" args={["#030305", 5, 25]} />
        <PlexusNetwork />
      </Canvas>
    </div>
  )
}
