import sharp from "sharp"
import path from "path"
import { promises as fs } from "fs"
import { getLayers, getLayerFile, type TraitSelection } from "@/lib/traits"

/**
 * Layer PNGs live under public/layers/ (referenced by traits.json). Resolve
 * relative to this file so the watcher can run from any cwd.
 */
const LAYERS_DIR = path.resolve(__dirname, "..", "public", "layers")
const IMAGE_SIZE = 1024

/**
 * Composite the selected trait PNGs into a single 1024x1024 PNG buffer.
 * Layers are stacked in `traits.json` order (background first, accessories on top).
 * Each overlay is pre-resized to 1024x1024 because some source assets are
 * larger than the base, and sharp.composite() rejects oversized inputs.
 */
export async function composeImage(selection: TraitSelection): Promise<Buffer> {
  const files: string[] = []
  for (const layer of getLayers()) {
    const optionId = selection[layer.id]
    if (!optionId) continue
    const file = getLayerFile(layer.id, optionId)
    if (!file) continue
    const abs = path.join(LAYERS_DIR, file)
    // Fail loudly if a referenced asset is missing — better than silent ghost layers.
    await fs.access(abs)
    files.push(abs)
  }
  if (files.length === 0) throw new Error("composeImage: no layers selected")

  const [base, ...overlays] = files
  // Pre-normalize every overlay to exact base dims as a PNG buffer.
  const overlayBufs = await Promise.all(
    overlays.map((input) =>
      sharp(input)
        .resize(IMAGE_SIZE, IMAGE_SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer()
    )
  )

  let img = sharp(base).resize(IMAGE_SIZE, IMAGE_SIZE)
  if (overlayBufs.length > 0) {
    img = img.composite(overlayBufs.map((input) => ({ input })))
  }
  return img.png().toBuffer()
}
