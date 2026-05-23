"use client"

import { useRef, useMemo } from "react"
import { Canvas, useFrame } from "@react-three/fiber"
import { Points, PointMaterial } from "@react-three/drei"
import * as THREE from "three"

function seededRandom(seed: number) {
  const value = Math.sin(seed) * 10000
  return value - Math.floor(value)
}

function randomRange(seed: number, min: number, max: number) {
  return min + seededRandom(seed) * (max - min)
}

function Particles() {
  const ref = useRef<THREE.Points>(null)
  
  const [positions, speeds] = useMemo(() => {
    const count = 3000
    const pos = new Float32Array(count * 3)
    const spd = new Float32Array(count)
    
    for (let i = 0; i < count; i++) {
      // x, y, z
      pos[i * 3] = randomRange(i * 4 + 1, -20, 20)
      pos[i * 3 + 1] = randomRange(i * 4 + 2, 0, 40)
      pos[i * 3 + 2] = randomRange(i * 4 + 3, -15, 5)
      
      // speed
      spd[i] = randomRange(i * 4 + 4, 0.05, 0.15)
    }
    return [pos, spd]
  }, [])

  useFrame((state, delta) => {
    if (!ref.current) return
    const positions = ref.current.geometry.attributes.position.array as Float32Array
    
    for (let i = 0; i < 3000; i++) {
      positions[i * 3 + 1] -= speeds[i]
      if (positions[i * 3 + 1] < -5) {
        positions[i * 3 + 1] = 40
      }
    }
    ref.current.geometry.attributes.position.needsUpdate = true
    
    ref.current.rotation.y = state.pointer.x * 0.2
    ref.current.rotation.x = -state.pointer.y * 0.2
  })

  return (
    <Points ref={ref} positions={positions} stride={3} frustumCulled={false}>
      <PointMaterial
        transparent
        color="#00ff9d"
        size={0.05}
        sizeAttenuation={true}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </Points>
  )
}

function GridFloor() {
  const gridRef = useRef<THREE.GridHelper>(null)
  
  useFrame((state) => {
    if (gridRef.current) {
      gridRef.current.position.z = (state.clock.elapsedTime * 2) % 4
      gridRef.current.rotation.y = state.pointer.x * 0.05
    }
  })

  return (
    <gridHelper
      ref={gridRef}
      args={[100, 50, "#00ff9d", "#002b18"]}
      position={[0, -2, 0]}
    />
  )
}

export function GridBackground() {
  return (
    <div className="fixed inset-0 z-[-1] bg-[#030305] pointer-events-none">
      <Canvas camera={{ position: [0, 2, 15], fov: 60 }}>
        <fog attach="fog" args={["#030305", 5, 25]} />
        <Particles />
        <GridFloor />
      </Canvas>
    </div>
  )
}
