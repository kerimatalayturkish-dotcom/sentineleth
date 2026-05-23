"use client"

import { useRef, useMemo } from "react"
import { Canvas, useFrame } from "@react-three/fiber"
import { Float } from "@react-three/drei"
import * as THREE from "three"

function seededRandom(seed: number) {
  const value = Math.sin(seed) * 10000
  return value - Math.floor(value)
}

function randomRange(seed: number, min: number, max: number) {
  return min + seededRandom(seed) * (max - min)
}

function EthLogo() {
  const ref = useRef<THREE.Group>(null)
  
  useFrame((state, delta) => {
    if (ref.current) {
      ref.current.rotation.y += delta * 0.2
    }
  })

  return (
    <group ref={ref}>
      <Float speed={2} rotationIntensity={0.1} floatIntensity={1}>
        {/* Outer wireframe */}
        <mesh scale={[1.5, 2.5, 1.5]}>
          <octahedronGeometry args={[1, 0]} />
          <meshBasicMaterial color="#00ff9d" wireframe transparent opacity={0.6} />
        </mesh>
        {/* Inner core */}
        <mesh scale={[1.4, 2.4, 1.4]}>
          <octahedronGeometry args={[1, 0]} />
          <meshBasicMaterial color="#00150b" transparent opacity={0.9} />
        </mesh>
        {/* Central tight core */}
        <mesh scale={[0.5, 1, 0.5]}>
          <octahedronGeometry args={[1, 0]} />
          <meshBasicMaterial color="#00ff9d" wireframe transparent opacity={0.3} />
        </mesh>
      </Float>
    </group>
  )
}

function AgentNodes() {
  const gRef = useRef<THREE.Group>(null)
  const count = 100
  
  const nodes = useMemo(() => {
    const temp = []
    for (let i = 0; i < count; i++) {
      const r = randomRange(i * 5 + 1, 4, 10)
      const theta = randomRange(i * 5 + 2, 0, Math.PI * 2)
      const phi = randomRange(i * 5 + 3, 0, Math.PI)
      temp.push({
        x: r * Math.sin(phi) * Math.cos(theta),
        y: r * Math.sin(phi) * Math.sin(theta),
        z: r * Math.cos(phi),
        speed: randomRange(i * 5 + 4, 0.5, 2),
        offsetY: randomRange(i * 5 + 5, 0, Math.PI * 2)
      })
    }
    return temp
  }, [count])

  useFrame((state, delta) => {
    if (!gRef.current) return
    gRef.current.rotation.y -= delta * 0.1
    gRef.current.rotation.x += delta * 0.05
    gRef.current.rotation.z -= delta * 0.02
  })

  return (
    <group ref={gRef}>
      {nodes.map((pos, i) => (
        <mesh key={i} position={[pos.x, pos.y, pos.z]}>
          <boxGeometry args={[0.08, 0.08, 0.08]} />
          <meshBasicMaterial color="#00ff9d" transparent opacity={0.5} />
        </mesh>
      ))}
    </group>
  )
}

function MiningBlocks() {
  const meshRef = useRef<THREE.InstancedMesh>(null)
  const count = 60
  const dummy = useMemo(() => new THREE.Object3D(), [])
  
  const blocks = useMemo(() => {
    const temp = []
    for (let i = 0; i < count; i++) {
      temp.push({
        x: randomRange(i * 7 + 1, -10, 10),
        y: randomRange(i * 7 + 2, -35, -15),
        z: randomRange(i * 7 + 3, -7.5, 7.5),
        speed: randomRange(i * 7 + 4, 1, 3),
        rotX: randomRange(i * 7 + 5, -0.025, 0.025),
        rotY: randomRange(i * 7 + 6, -0.025, 0.025),
        scale: randomRange(i * 7 + 7, 0.2, 0.5)
      })
    }
    return temp
  }, [count])

  useFrame((state, delta) => {
    if (!meshRef.current) return
    blocks.forEach((block, i) => {
      // Float up
      block.y += block.speed * delta
      if (block.y > 15) {
        block.y = randomRange(i * 11 + Math.floor(state.clock.elapsedTime), -20, -15)
        block.x = randomRange(i * 13 + Math.floor(state.clock.elapsedTime), -10, 10)
      }
      
      dummy.position.set(block.x, block.y, block.z)
      dummy.rotation.x += block.rotX
      dummy.rotation.y += block.rotY
      dummy.scale.setScalar(block.scale)
      dummy.updateMatrix()
      meshRef.current!.setMatrixAt(i, dummy.matrix)
    })
    meshRef.current.instanceMatrix.needsUpdate = true
  })

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, count]}>
      <boxGeometry args={[1, 1, 1]} />
      <meshBasicMaterial color="#00ff9d" wireframe transparent opacity={0.3} />
    </instancedMesh>
  )
}

function CameraRig() {
  useFrame((state) => {
    state.camera.position.x = THREE.MathUtils.lerp(state.camera.position.x, state.pointer.x * 3, 0.05)
    state.camera.position.y = THREE.MathUtils.lerp(state.camera.position.y, state.pointer.y * 3, 0.05)
    state.camera.lookAt(0, 0, 0)
  })
  return null
}

export function EthMiningBackground() {
  return (
    <div className="fixed inset-0 z-[-1] bg-[#030305] pointer-events-none">
      <Canvas camera={{ position: [0, 0, 12], fov: 45 }}>
        <fog attach="fog" args={["#030305", 5, 20]} />
        <EthLogo />
        <AgentNodes />
        <MiningBlocks />
        <CameraRig />
      </Canvas>
    </div>
  )
}
