/**
 * Whittaker-style biome classification from elevation + temperature + humidity.
 *
 * The output is deliberately *texture-agnostic*: per cell we produce a dominant
 * biome id plus the top-4 biomes and their normalized blend weights. That data
 * (plus the legend below) is everything another engine needs to apply its own
 * PBR material per biome and blend between them — nothing about this app's
 * textures is baked into it.
 *
 * In-app we dogfood the same data by mapping each biome to one of the existing
 * terrain textures (a "surface") and blending those by the biome weights in the
 * TSL material; see `surfaceWeights()` / `paletteColors()`.
 *
 * Fields are indexed `y * resolution + x`, matching the heightmap, the climate
 * fields, and the terrain mesh vertices.
 */

import { ClimateFields } from './ClimateSystem'

/** Surface channel a biome maps to for in-app rendering (indexes the 4 textures). */
export const SURFACE = { SOIL: 0, GRASS: 1, ROCK: 2, SNOW: 3 } as const

export interface BiomeDef {
  id: number
  key: string
  name: string
  color: [number, number, number] // representative color, 0..1 (legend + tint + palette view)
  surface: number                 // SURFACE channel used to texture it in-app
  temperature: [number, number] | null // °C range (null = elevation-defined biome)
  humidity: [number, number] | null     // 0..1 range (null = any / elevation-defined)
  rule?: string                   // human-readable note for elevation-defined biomes
}

// Order is the biome id. Ocean is 0 so an empty/index map reads as ocean.
export const BIOMES: BiomeDef[] = [
  { id: 0, key: 'ocean', name: 'Ocean', color: [0.10, 0.20, 0.45], surface: SURFACE.ROCK, temperature: null, humidity: null, rule: 'elevation < sea level' },
  { id: 1, key: 'beach', name: 'Beach', color: [0.85, 0.78, 0.55], surface: SURFACE.SOIL, temperature: null, humidity: null, rule: 'just above sea level' },
  { id: 2, key: 'subtropical_desert', name: 'Subtropical Desert', color: [0.85, 0.72, 0.40], surface: SURFACE.SOIL, temperature: [20, 999], humidity: [0.0, 0.22] },
  { id: 3, key: 'savanna', name: 'Savanna', color: [0.78, 0.74, 0.38], surface: SURFACE.GRASS, temperature: [20, 999], humidity: [0.22, 0.5] },
  { id: 4, key: 'tropical_rainforest', name: 'Tropical Rainforest', color: [0.10, 0.45, 0.15], surface: SURFACE.GRASS, temperature: [21, 999], humidity: [0.5, 1.01] },
  { id: 5, key: 'temperate_grassland', name: 'Temperate Grassland', color: [0.62, 0.70, 0.35], surface: SURFACE.GRASS, temperature: [5, 20], humidity: [0.0, 0.25] },
  { id: 6, key: 'woodland_shrubland', name: 'Woodland / Shrubland', color: [0.55, 0.62, 0.30], surface: SURFACE.GRASS, temperature: [11, 21], humidity: [0.25, 0.5] },
  { id: 7, key: 'temperate_seasonal_forest', name: 'Temperate Seasonal Forest', color: [0.25, 0.55, 0.22], surface: SURFACE.GRASS, temperature: [7, 20], humidity: [0.45, 0.72] },
  { id: 8, key: 'temperate_rainforest', name: 'Temperate Rainforest', color: [0.13, 0.48, 0.30], surface: SURFACE.GRASS, temperature: [9, 21], humidity: [0.72, 1.01] },
  { id: 9, key: 'boreal_forest', name: 'Boreal Forest (Taiga)', color: [0.20, 0.42, 0.32], surface: SURFACE.GRASS, temperature: [0, 8], humidity: [0.25, 1.01] },
  { id: 10, key: 'tundra', name: 'Tundra', color: [0.55, 0.55, 0.48], surface: SURFACE.ROCK, temperature: [-6, 3], humidity: [0.0, 1.01] },
  { id: 11, key: 'snow', name: 'Snow / Ice', color: [0.95, 0.96, 0.98], surface: SURFACE.SNOW, temperature: [-999, -4], humidity: [0.0, 1.01] }
]

export const OCEAN_ID = 0
export const BEACH_ID = 1
const FIRST_CLIMATE_ID = 2 // ids >= this are classified by temperature x humidity
const HUMIDITY_MARGIN = 0.08
const NUM_BIOMES = BIOMES.length
const BLEND_K = 4 // biomes blended per cell

export interface BiomeOptions {
  seaLevel: number
  beachHeight: number  // height band above sea level classified as beach
  blendMargin: number  // °C of soft overlap between temperature bands (also scales humidity)
}

export interface BiomeField {
  resolution: number
  index: Uint8Array<ArrayBuffer>         // dominant biome id per cell (length n)
  topIndices: Uint8Array<ArrayBuffer>    // top-4 biome ids per cell (length n*4)
  topWeights: Float32Array<ArrayBuffer>  // matching normalized weights, sum to 1 (length n*4)
}

export class BiomeSystem {
  /** Classify a heightmap + climate into per-cell dominant biome and top-4 blend weights. */
  static compute(
    heightData: Float32Array,
    climate: ClimateFields,
    resolution: number,
    opts: BiomeOptions
  ): BiomeField {
    const n = resolution * resolution
    const index = new Uint8Array(n)
    const topIndices = new Uint8Array(n * BLEND_K)
    const topWeights = new Float32Array(n * BLEND_K)

    const { seaLevel, beachHeight } = opts
    const tMargin = Math.max(0.5, opts.blendMargin)
    const hMargin = HUMIDITY_MARGIN
    const beachMargin = Math.max(1, beachHeight * 0.5)

    const w = new Float64Array(NUM_BIOMES) // scratch, reused per cell

    for (let i = 0; i < n; i++) {
      const elev = heightData[i]
      const temp = climate.temperature[i]
      const hum = climate.humidity[i]

      // Elevation-defined biomes.
      const oceanW = 1 - smoothstep(seaLevel - beachMargin, seaLevel, elev)
      const beachW = softBand(elev, seaLevel, seaLevel + beachHeight, beachMargin) * (1 - oceanW)
      // 0 at/below the beach band, 1 once we're clearly on land.
      const landFactor = smoothstep(seaLevel + beachHeight * 0.5, seaLevel + beachHeight * 1.5, elev)

      w[OCEAN_ID] = oceanW
      w[BEACH_ID] = beachW

      // Climate-defined biomes (Whittaker grid), only on land.
      for (let b = FIRST_CLIMATE_ID; b < NUM_BIOMES; b++) {
        const def = BIOMES[b]
        const tBand = softBand(temp, def.temperature![0], def.temperature![1], tMargin)
        const hBand = softBand(hum, def.humidity![0], def.humidity![1], hMargin)
        w[b] = tBand * hBand * landFactor
      }

      this.selectTopK(w, i, topIndices, topWeights)
      index[i] = topIndices[i * BLEND_K] // strongest after selection
    }

    return { resolution, index, topIndices, topWeights }
  }

  /** Pick the BLEND_K strongest biomes for a cell, normalize their weights, write them out. */
  private static selectTopK(
    w: Float64Array,
    cell: number,
    topIndices: Uint8Array,
    topWeights: Float32Array
  ): void {
    const base = cell * BLEND_K
    // Reset slots.
    for (let k = 0; k < BLEND_K; k++) {
      topIndices[base + k] = 0
      topWeights[base + k] = 0
    }

    // Simple selection of the top BLEND_K (NUM_BIOMES is small, so this is cheap).
    for (let b = 0; b < NUM_BIOMES; b++) {
      const weight = w[b]
      if (weight <= 0) continue
      // Find the smallest currently-stored slot to potentially replace.
      let minK = 0
      for (let k = 1; k < BLEND_K; k++) {
        if (topWeights[base + k] < topWeights[base + minK]) minK = k
      }
      if (weight > topWeights[base + minK]) {
        topWeights[base + minK] = weight
        topIndices[base + minK] = b
      }
    }

    // Sort the K slots by weight descending (so slot 0 is dominant).
    for (let a = 0; a < BLEND_K; a++) {
      for (let b = a + 1; b < BLEND_K; b++) {
        if (topWeights[base + b] > topWeights[base + a]) {
          const tw = topWeights[base + a]; topWeights[base + a] = topWeights[base + b]; topWeights[base + b] = tw
          const ti = topIndices[base + a]; topIndices[base + a] = topIndices[base + b]; topIndices[base + b] = ti
        }
      }
    }

    // Normalize. If everything was zero (a gap in the Whittaker grid), fall back
    // to the single nearest biome at full weight so a cell is never undefined.
    let sum = 0
    for (let k = 0; k < BLEND_K; k++) sum += topWeights[base + k]
    if (sum > 1e-6) {
      for (let k = 0; k < BLEND_K; k++) topWeights[base + k] /= sum
    } else {
      let best = 0
      for (let b = 1; b < NUM_BIOMES; b++) if (w[b] > w[best]) best = b
      topIndices[base] = best
      topWeights[base] = 1
    }
  }

  /** Per-vertex vec4 of texture-channel weights (soil, grass, rock, snow) for the TSL material. */
  static surfaceWeights(field: BiomeField): Float32Array {
    const n = field.resolution * field.resolution
    const out = new Float32Array(n * 4)
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < BLEND_K; k++) {
        const id = field.topIndices[i * BLEND_K + k]
        const weight = field.topWeights[i * BLEND_K + k]
        out[i * 4 + BIOMES[id].surface] += weight
      }
    }
    return out
  }

  /** Per-vertex blended representative color (legend palette), for tinting / the color view. */
  static paletteColors(field: BiomeField): Float32Array {
    const n = field.resolution * field.resolution
    const out = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      let r = 0, g = 0, b = 0
      for (let k = 0; k < BLEND_K; k++) {
        const def = BIOMES[field.topIndices[i * BLEND_K + k]]
        const weight = field.topWeights[i * BLEND_K + k]
        r += def.color[0] * weight
        g += def.color[1] * weight
        b += def.color[2] * weight
      }
      out[i * 3] = r
      out[i * 3 + 1] = g
      out[i * 3 + 2] = b
    }
    return out
  }

  // --- Export helpers -------------------------------------------------------

  /** JSON-serializable legend + metadata: the contract a consuming engine reads. */
  static legend(opts: BiomeOptions, meta: Record<string, unknown>): object {
    return {
      format: 'weltenbauer-biomes',
      version: 1,
      blendChannels: BLEND_K,
      encoding: {
        biome_indices_png: 'RGBA = top-4 biome ids (0-255)',
        biome_weights_png: 'RGBA = top-4 normalized weights (0-255 → 0..1)',
        biome_indices_bin: `Uint8 [n*${BLEND_K}], row-major y*res+x`,
        biome_weights_bin: `Float32 [n*${BLEND_K}], normalized, matches indices`
      },
      classification: { seaLevel: opts.seaLevel, beachHeight: opts.beachHeight, blendMargin: opts.blendMargin },
      meta,
      biomes: BIOMES.map(b => ({
        id: b.id,
        key: b.key,
        name: b.name,
        color: rgbToHex(b.color),
        surface: Object.keys(SURFACE)[b.surface].toLowerCase(),
        temperature: b.temperature,
        humidity: b.humidity,
        rule: b.rule ?? null
      }))
    }
  }

  /** RGBA bytes encoding the top-4 biome ids per texel (for a PNG). */
  static encodeIndicesRGBA(field: BiomeField): Uint8ClampedArray {
    const n = field.resolution * field.resolution
    const rgba = new Uint8ClampedArray(n * 4)
    for (let i = 0; i < n; i++) {
      rgba[i * 4] = field.topIndices[i * BLEND_K]
      rgba[i * 4 + 1] = field.topIndices[i * BLEND_K + 1]
      rgba[i * 4 + 2] = field.topIndices[i * BLEND_K + 2]
      rgba[i * 4 + 3] = field.topIndices[i * BLEND_K + 3]
    }
    return rgba
  }

  /** RGBA bytes encoding the top-4 blend weights per texel (for a PNG). */
  static encodeWeightsRGBA(field: BiomeField): Uint8ClampedArray {
    const n = field.resolution * field.resolution
    const rgba = new Uint8ClampedArray(n * 4)
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 4; k++) {
        rgba[i * 4 + k] = Math.round(field.topWeights[i * BLEND_K + k] * 255)
      }
    }
    return rgba
  }

  /** Encode RGBA bytes as a PNG data URL. */
  static rgbaToDataURL(rgba: Uint8ClampedArray, resolution: number): string {
    const canvas = document.createElement('canvas')
    canvas.width = resolution
    canvas.height = resolution
    const ctx = canvas.getContext('2d')!
    const imageData = ctx.createImageData(resolution, resolution)
    imageData.data.set(rgba)
    ctx.putImageData(imageData, 0, 0)
    return canvas.toDataURL('image/png')
  }
}

function rgbToHex(c: [number, number, number]): string {
  const h = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** Trapezoidal membership: ~1 inside [lo,hi], ramping to 0 over margin m on each side. */
function softBand(v: number, lo: number, hi: number, m: number): number {
  const rise = smoothstep(lo - m, lo, v)
  const fall = 1 - smoothstep(hi, hi + m, v)
  return Math.max(0, Math.min(1, rise * fall))
}
