import sharp from "sharp"
import path from "path"

const LAYERS_DIR = path.resolve(__dirname, "../assets/layers")
const SIZE = 1024

async function createSolid(color: string, filePath: string) {
  await sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: color } })
    .png()
    .toFile(filePath)
  console.log(`  ✓ ${path.relative(LAYERS_DIR, filePath)}`)
}

async function createTransparent(filePath: string) {
  await sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .png()
    .toFile(filePath)
  console.log(`  ✓ ${path.relative(LAYERS_DIR, filePath)} (transparent)`)
}

async function createShape(
  color: string,
  shape: { left: number; top: number; width: number; height: number },
  filePath: string
) {
  // Create a colored rectangle on transparent background
  const overlay = await sharp({
    create: { width: shape.width, height: shape.height, channels: 4, background: color },
  })
    .png()
    .toBuffer()

  await sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: overlay, left: shape.left, top: shape.top }])
    .png()
    .toFile(filePath)
  console.log(`  ✓ ${path.relative(LAYERS_DIR, filePath)}`)
}

async function createCircle(
  color: string,
  cx: number,
  cy: number,
  r: number,
  filePath: string
) {
  const svg = `<svg width="${SIZE}" height="${SIZE}"><circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/></svg>`
  await sharp(Buffer.from(svg))
    .png()
    .toFile(filePath)
  console.log(`  ✓ ${path.relative(LAYERS_DIR, filePath)}`)
}

async function createSemiTransparent(color: string, alpha: number, filePath: string) {
  // Parse hex color and apply alpha
  const r = parseInt(color.slice(1, 3), 16)
  const g = parseInt(color.slice(3, 5), 16)
  const b = parseInt(color.slice(5, 7), 16)
  await sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: { r, g, b, alpha } } })
    .png()
    .toFile(filePath)
  console.log(`  ✓ ${path.relative(LAYERS_DIR, filePath)}`)
}

async function main() {
  console.log("Generating placeholder PNGs...\n")

  // Layer 0 — Backgrounds (solid, opaque)
  console.log("Layer 0 — Backgrounds:")
  await createSolid("#3B82F6", path.join(LAYERS_DIR, "0-background/bg_blue.png"))
  await createSolid("#EF4444", path.join(LAYERS_DIR, "0-background/bg_red.png"))
  await createSolid("#22C55E", path.join(LAYERS_DIR, "0-background/bg_green.png"))

  // Layer 1 — Body (shapes on transparent)
  console.log("\nLayer 1 — Body:")
  // Armor: wide gray rectangle torso area
  await createShape("#6B7280", { left: 312, top: 400, width: 400, height: 450 },
    path.join(LAYERS_DIR, "1-body/body_armor.png"))
  // Robe: taller purple shape
  await createShape("#7C3AED", { left: 312, top: 350, width: 400, height: 550 },
    path.join(LAYERS_DIR, "1-body/body_robe.png"))

  // Layer 2 — Head (circles on transparent)
  console.log("\nLayer 2 — Head:")
  // Helmet: dark circle at head position
  await createCircle("#374151", 512, 280, 150,
    path.join(LAYERS_DIR, "2-head/head_helmet.png"))
  // Crown: golden circle
  await createCircle("#F59E0B", 512, 260, 130,
    path.join(LAYERS_DIR, "2-head/head_crown.png"))

  // Layer 3 — Eyes (small dots)
  console.log("\nLayer 3 — Eyes:")
  // Laser: red dots
  const laserSvg = `<svg width="${SIZE}" height="${SIZE}">
    <circle cx="460" cy="270" r="20" fill="#EF4444"/>
    <circle cx="564" cy="270" r="20" fill="#EF4444"/>
    <line x1="460" y1="270" x2="200" y2="400" stroke="#EF4444" stroke-width="4" opacity="0.8"/>
    <line x1="564" y1="270" x2="824" y2="400" stroke="#EF4444" stroke-width="4" opacity="0.8"/>
  </svg>`
  await sharp(Buffer.from(laserSvg)).png().toFile(path.join(LAYERS_DIR, "3-eyes/eyes_laser.png"))
  console.log(`  ✓ 3-eyes/eyes_laser.png`)

  // Normal: white dots
  const normalSvg = `<svg width="${SIZE}" height="${SIZE}">
    <circle cx="460" cy="270" r="18" fill="white"/>
    <circle cx="564" cy="270" r="18" fill="white"/>
    <circle cx="460" cy="270" r="8" fill="#1F2937"/>
    <circle cx="564" cy="270" r="8" fill="#1F2937"/>
  </svg>`
  await sharp(Buffer.from(normalSvg)).png().toFile(path.join(LAYERS_DIR, "3-eyes/eyes_normal.png"))
  console.log(`  ✓ 3-eyes/eyes_normal.png`)

  // Layer 4 — Accessories
  console.log("\nLayer 4 — Accessories:")
  // Wings: two triangular shapes on sides
  const wingsSvg = `<svg width="${SIZE}" height="${SIZE}">
    <polygon points="200,400 50,500 200,650" fill="#60A5FA" opacity="0.8"/>
    <polygon points="824,400 974,500 824,650" fill="#60A5FA" opacity="0.8"/>
  </svg>`
  await sharp(Buffer.from(wingsSvg)).png().toFile(path.join(LAYERS_DIR, "4-accessories/acc_wings.png"))
  console.log(`  ✓ 4-accessories/acc_wings.png`)

  // Shield: shape on left side
  const shieldSvg = `<svg width="${SIZE}" height="${SIZE}">
    <rect x="180" y="450" width="120" height="160" rx="15" fill="#9CA3AF"/>
    <rect x="195" y="465" width="90" height="130" rx="10" fill="#D1D5DB"/>
  </svg>`
  await sharp(Buffer.from(shieldSvg)).png().toFile(path.join(LAYERS_DIR, "4-accessories/acc_shield.png"))
  console.log(`  ✓ 4-accessories/acc_shield.png`)

  // None: fully transparent
  await createTransparent(path.join(LAYERS_DIR, "4-accessories/acc_none.png"))

  // Layer 5 — Color overlay
  console.log("\nLayer 5 — Color overlay:")
  await createSemiTransparent("#F59E0B", 0.15, path.join(LAYERS_DIR, "5-color/color_gold.png"))
  await createSemiTransparent("#C0C0C0", 0.12, path.join(LAYERS_DIR, "5-color/color_silver.png"))
  await createTransparent(path.join(LAYERS_DIR, "5-color/color_none.png"))

  console.log("\n✅ All 15 placeholder PNGs generated!")
}

main().catch(console.error)
