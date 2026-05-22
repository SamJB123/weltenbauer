import * as THREE from 'three/webgpu'
import { BIOMES, SURFACE, BiomeField, BiomeSystem } from './BiomeSystem'

/**
 * Standardized, co-registered 2.5D "map set" export — the terrain's data fields
 * packaged like a PBR material's channels, with a JSON manifest as the single
 * contract a consumer (especially three.js / TSL) reads.
 *
 * Every map is the same resolution and row-major (y*resolution + x), so a
 * consumer can sample height, climate, and biome at the same UV. Continuous
 * fields ship as float16 binary (linearly filterable as a HalfFloat DataTexture
 * and signed — height can go below sea level) plus an 8-bit PNG preview. The
 * biome index ships as a nearest-sampled map; weights as a filterable map. The
 * manifest records, per map, the GL type / format / colorSpace / filter / value
 * range needed to use it correctly — no guessing, no color-space traps.
 */

export interface MapDescriptor {
  semantic: 'height' | 'temperature' | 'humidity' | 'biomeIndex' | 'biomeWeights'
  channels: number
  dataType: 'float16' | 'uint8'
  glType: 'HalfFloatType' | 'UnsignedByteType' // three.js Texture `type`
  format: 'RedFormat' | 'RGBAFormat'           // three.js Texture `format`
  colorSpace: 'NoColorSpace'                   // data, never sRGB
  filter: 'linear' | 'nearest'                 // min/mag filter
  files: { data?: string; preview?: string }
  range?: { min: number; max: number; units: string } // de-normalizes the preview
  note?: string
}

export interface MapManifest {
  format: 'weltenbauer-mapset'
  version: 1
  resolution: number
  layout: string
  world: { sizeKm: number; seaLevel: number }
  seed: number
  maps: MapDescriptor[]
  biomes: object[]
}

export interface MapSetInput {
  resolution: number
  sizeKm: number
  seaLevel: number
  seed: number
  height: Float32Array
  temperature: Float32Array
  humidity: Float32Array
  biome: BiomeField
}

export interface MapSetFile {
  name: string
  /** Either a PNG data URL (preview/index/weights PNG) or a raw binary buffer (.bin). */
  dataUrl?: string
  bytes?: ArrayBuffer
  mime: string
}

export interface MapSetExport {
  manifestJson: string
  files: MapSetFile[]
}

/** Build the full co-registered map set + manifest. */
export function buildMapSet(input: MapSetInput): MapSetExport {
  const { resolution: res } = input
  const files: MapSetFile[] = []
  const maps: MapDescriptor[] = []

  // --- Continuous scalar fields: float16 .bin (GPU-ready) + 8-bit PNG preview ---
  const addScalarField = (
    semantic: 'height' | 'temperature' | 'humidity',
    field: Float32Array,
    units: string
  ) => {
    const { min, max } = minMax(field)
    const base = semantic
    files.push({ name: `${base}.bin`, bytes: halfFloatBuffer(field), mime: 'application/octet-stream' })
    files.push({ name: `${base}.png`, dataUrl: scalarFieldToPNG(field, res, min, max), mime: 'image/png' })
    maps.push({
      semantic,
      channels: 1,
      dataType: 'float16',
      glType: 'HalfFloatType',
      format: 'RedFormat',
      colorSpace: 'NoColorSpace',
      filter: 'linear',
      files: { data: `${base}.bin`, preview: `${base}.png` },
      range: { min, max, units },
      note: '.bin = raw float16 (use as HalfFloat DataTexture, real values). .png = 8-bit preview, de-normalize with range.'
    })
  }

  addScalarField('height', input.height, 'm')
  addScalarField('temperature', input.temperature, '°C')
  addScalarField('humidity', input.humidity, '0..1')

  // --- Biome index: nearest-sampled top-4 ids (RGBA PNG + uint8 .bin) ---
  const indicesRGBA = BiomeSystem.encodeIndicesRGBA(input.biome)
  files.push({ name: 'biome-index.png', dataUrl: rgbaToPNG(indicesRGBA, res), mime: 'image/png' })
  files.push({ name: 'biome-index.bin', bytes: copyBuffer(input.biome.topIndices), mime: 'application/octet-stream' })
  maps.push({
    semantic: 'biomeIndex',
    channels: 4,
    dataType: 'uint8',
    glType: 'UnsignedByteType',
    format: 'RGBAFormat',
    colorSpace: 'NoColorSpace',
    filter: 'nearest', // ids must NOT be interpolated
    files: { data: 'biome-index.bin', preview: 'biome-index.png' },
    note: 'RGBA = the 4 strongest biome ids per texel. Sample with NEAREST / textureLoad.'
  })

  // --- Biome weights: filterable top-4 blend weights (RGBA PNG + float16 .bin) ---
  const weightsRGBA = BiomeSystem.encodeWeightsRGBA(input.biome)
  files.push({ name: 'biome-weights.png', dataUrl: rgbaToPNG(weightsRGBA, res), mime: 'image/png' })
  files.push({ name: 'biome-weights.bin', bytes: halfFloatBuffer(input.biome.topWeights), mime: 'application/octet-stream' })
  maps.push({
    semantic: 'biomeWeights',
    channels: 4,
    dataType: 'float16',
    glType: 'HalfFloatType',
    format: 'RGBAFormat',
    colorSpace: 'NoColorSpace',
    filter: 'linear',
    files: { data: 'biome-weights.bin', preview: 'biome-weights.png' },
    note: 'RGBA = normalized blend weights matching biome-index channels (sum to 1).'
  })

  const manifest: MapManifest = {
    format: 'weltenbauer-mapset',
    version: 1,
    resolution: res,
    layout: 'row-major (y * resolution + x); PNG origin top-left',
    world: { sizeKm: input.sizeKm, seaLevel: input.seaLevel },
    seed: input.seed,
    maps,
    biomes: BIOMES.map(b => ({
      id: b.id,
      key: b.key,
      name: b.name,
      color: rgbToHex(b.color),
      surface: surfaceName(b.surface),
      temperature: b.temperature,
      humidity: b.humidity,
      rule: b.rule ?? null
    }))
  }

  return { manifestJson: JSON.stringify(manifest, null, 2), files }
}

// --- helpers ----------------------------------------------------------------

function minMax(field: Float32Array): { min: number; max: number } {
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < field.length; i++) {
    const v = field[i]
    if (v < min) min = v
    if (v > max) max = v
  }
  return { min, max }
}

/** Pack a float array into IEEE half-float (Uint16) and return its ArrayBuffer. */
function halfFloatBuffer(field: Float32Array): ArrayBuffer {
  const half = new Uint16Array(field.length)
  for (let i = 0; i < field.length; i++) {
    half[i] = THREE.DataUtils.toHalfFloat(field[i])
  }
  return half.buffer
}

/** Copy a typed array's bytes into a standalone ArrayBuffer (for a Blob). */
function copyBuffer(arr: Uint8Array): ArrayBuffer {
  return arr.slice().buffer
}

/** 8-bit grayscale PNG preview of a scalar field, normalized by [min,max]. */
function scalarFieldToPNG(field: Float32Array, res: number, min: number, max: number): string {
  const range = max - min
  const rgba = new Uint8ClampedArray(res * res * 4)
  for (let i = 0; i < field.length; i++) {
    const g = range > 0 ? Math.round(((field[i] - min) / range) * 255) : 0
    rgba[i * 4] = g
    rgba[i * 4 + 1] = g
    rgba[i * 4 + 2] = g
    rgba[i * 4 + 3] = 255
  }
  return rgbaToPNG(rgba, res)
}

function rgbaToPNG(rgba: Uint8ClampedArray, res: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = res
  canvas.height = res
  const ctx = canvas.getContext('2d')!
  const imageData = ctx.createImageData(res, res)
  imageData.data.set(rgba)
  ctx.putImageData(imageData, 0, 0)
  return canvas.toDataURL('image/png')
}

function surfaceName(surface: number): string {
  return (Object.keys(SURFACE)[surface] ?? 'soil').toLowerCase()
}

function rgbToHex(c: [number, number, number]): string {
  const h = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`
}
