/**
 * Lossless, self-contained island project file — the round-trippable counterpart
 * to the (lossy, interchange-oriented) map-set export. It carries the full editor
 * config + seed + the exact float32 heightfield (including brush edits), so a
 * previously-exported island can be re-imported and modified without any loss.
 *
 * One JSON file: the heightfield is stored as base64-encoded little-endian
 * Float32 (compact and exact, unlike a JSON number array).
 */

export const ISLAND_PROJECT_FORMAT = 'weltenbauer-island'
export const ISLAND_PROJECT_VERSION = 1

export interface IslandProjectFile {
  format: string
  version: number
  resolution: number
  seed: number
  config: unknown // opaque TerrainConfig (kept loose to avoid a circular import)
  heightData: string // base64 of little-endian Float32
}

export interface DecodedIslandProject {
  config: unknown
  seed: number
  resolution: number
  heightData: Float32Array
}

export function encodeIslandProject(
  config: unknown,
  seed: number,
  resolution: number,
  heightData: Float32Array
): string {
  const file: IslandProjectFile = {
    format: ISLAND_PROJECT_FORMAT,
    version: ISLAND_PROJECT_VERSION,
    resolution,
    seed,
    config,
    heightData: float32ToBase64(heightData)
  }
  return JSON.stringify(file)
}

export function decodeIslandProject(json: string): DecodedIslandProject {
  const file = JSON.parse(json) as IslandProjectFile
  if (file.format !== ISLAND_PROJECT_FORMAT) {
    throw new Error(`Not a ${ISLAND_PROJECT_FORMAT} file (got "${file.format}")`)
  }
  const heightData = base64ToFloat32(file.heightData)
  const expected = file.resolution * file.resolution
  if (heightData.length !== expected) {
    throw new Error(`Height data length ${heightData.length} != resolution² (${expected})`)
  }
  return { config: file.config, seed: file.seed, resolution: file.resolution, heightData }
}

// --- base64 <-> Float32 (chunked to avoid call-stack limits on large arrays) ---

function float32ToBase64(arr: Float32Array): string {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[])
  }
  return btoa(binary)
}

function base64ToFloat32(b64: string): Float32Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Float32Array(bytes.buffer)
}
