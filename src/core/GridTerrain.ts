import * as THREE from 'three/webgpu'

/**
 * RollerCoaster-Tycoon-style square-grid heightfield: a coarse lattice of shared
 * corner vertices where each cell is two triangles whose tilt is defined purely by
 * its four corner heights. Because adjacent cells reference the SAME corner
 * vertices, seamless joins are an identity of the shared geometry — not a stitch.
 * A flat cell has four equal corners; differing corners tilt its triangles. Render
 * flat-shaded for the faceted low-poly look. Built in world space (X right, Y up =
 * height, Z forward), same convention as the CSG solid.
 */

export interface GridOptions {
  cells: number      // cells across; (cells + 1) shared vertices per side
  sizeUnits: number  // world extent (config.size * 1000)
  step: number       // height quantization step in metres (0 = continuous corners)
}

/** Bilinear sample of a square heightfield at fractional grid coordinates. */
function sampleBilinear(data: Float32Array, res: number, fx: number, fz: number): number {
  const x0 = Math.max(0, Math.min(res - 1, Math.floor(fx)))
  const z0 = Math.max(0, Math.min(res - 1, Math.floor(fz)))
  const x1 = Math.min(res - 1, x0 + 1)
  const z1 = Math.min(res - 1, z0 + 1)
  const tx = fx - Math.floor(fx)
  const tz = fz - Math.floor(fz)
  const h00 = data[z0 * res + x0], h10 = data[z0 * res + x1]
  const h01 = data[z1 * res + x0], h11 = data[z1 * res + x1]
  const a = h00 + (h10 - h00) * tx
  const b = h01 + (h11 - h01) * tx
  return a + (b - a) * tz
}

export function buildGridGeometry(
  heightData: Float32Array,
  srcRes: number,
  temperature: Float32Array | null, // srcRes*srcRes climate fields (or null = zeros)
  humidity: Float32Array | null,
  opts: GridOptions
): THREE.BufferGeometry {
  const cells = Math.max(1, Math.floor(opts.cells))
  const n = cells + 1
  const half = opts.sizeUnits / 2
  const cellSize = opts.sizeUnits / cells
  const positions = new Float32Array(n * n * 3)
  // Per-vertex continuous climate (x = temperature, y = humidity, z = surfaceHeight) —
  // the same data the carved solid carries, so biome is classified downstream from the
  // interpolated values (varying across a tile), never baked.
  const surf = new Float32Array(n * n * 3)
  const quant = (hgt: number) => opts.step > 0 ? Math.round(hgt / opts.step) * opts.step : hgt

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const fx = (i / cells) * (srcRes - 1)
      const fz = (j / cells) * (srcRes - 1)
      const vi = j * n + i
      const hgt = quant(sampleBilinear(heightData, srcRes, fx, fz))
      positions[vi * 3] = i * cellSize - half
      positions[vi * 3 + 1] = hgt
      positions[vi * 3 + 2] = j * cellSize - half
      surf[vi * 3] = temperature ? sampleBilinear(temperature, srcRes, fx, fz) : 0
      surf[vi * 3 + 1] = humidity ? sampleBilinear(humidity, srcRes, fx, fz) : 0
      surf[vi * 3 + 2] = hgt
    }
  }

  // Two triangles per cell, wound for upward (+Y) normals. The split diagonal runs
  // along the gentler corner-height difference, so the crease follows the terrain.
  const indices: number[] = []
  const H = (vi: number) => positions[vi * 3 + 1]
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const tl = j * n + i, tr = j * n + i + 1
      const bl = (j + 1) * n + i, br = (j + 1) * n + i + 1
      if (Math.abs(H(tl) - H(br)) <= Math.abs(H(tr) - H(bl))) {
        indices.push(tl, bl, br, tl, br, tr)
      } else {
        indices.push(tl, bl, tr, tr, bl, br)
      }
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('surfData', new THREE.BufferAttribute(surf, 3))
  geo.setIndex(indices)
  geo.computeVertexNormals()
  return geo
}

/**
 * Flat-top hex-tile version of the same idea: each hex is a centre vertex fanned to
 * its 6 corners (6 triangles). Corner heights are sampled from the heightfield at
 * their world position, so corners shared between adjacent hexes land at the same
 * height → seamless joins as an identity of the sampling. The centre sits at the
 * average of its 6 corners, so a hex is flat exactly when its corners are equal.
 * Each vertex carries continuous climate (temperature/humidity/height) — biome is
 * classified downstream from it, so it can vary across a tile and is never baked.
 */
export function buildHexGeometry(
  heightData: Float32Array,
  srcRes: number,
  temperature: Float32Array | null,
  humidity: Float32Array | null,
  opts: GridOptions
): THREE.BufferGeometry {
  const cells = Math.max(2, Math.floor(opts.cells))
  const size = opts.sizeUnits
  const half = size / 2
  const R = size / (1.5 * cells)          // circumradius so ~`cells` columns span the width
  const horiz = 1.5 * R                   // flat-top column spacing
  const vert = Math.sqrt(3) * R           // row spacing; odd columns offset by vert/2
  const quant = (hgt: number) => opts.step > 0 ? Math.round(hgt / opts.step) * opts.step : hgt
  const angles = [0, 1, 2, 3, 4, 5].map(k => (k * Math.PI) / 3)

  const cols = Math.ceil(size / horiz) + 1
  const rows = Math.ceil(size / vert) + 1
  const positions: number[] = []
  const surf: number[] = []
  const indices: number[] = []
  let base = 0

  const sample = (field: Float32Array, x: number, z: number) =>
    sampleBilinear(field, srcRes, ((x + half) / size) * (srcRes - 1), ((z + half) / size) * (srcRes - 1))
  const heightAt = (x: number, z: number) => quant(sample(heightData, x, z))
  const tempAt = (x: number, z: number) => temperature ? sample(temperature, x, z) : 0
  const humAt = (x: number, z: number) => humidity ? sample(humidity, x, z) : 0

  for (let q = 0; q <= cols; q++) {
    for (let r = 0; r <= rows; r++) {
      const cx = -half + q * horiz
      const cz = -half + r * vert + (q % 2 ? vert / 2 : 0)
      if (cx < -half - R || cx > half + R || cz < -half - R || cz > half + R) continue

      const cornerX: number[] = [], cornerZ: number[] = [], cornerH: number[] = []
      for (let k = 0; k < 6; k++) {
        cornerX[k] = cx + R * Math.cos(angles[k])
        cornerZ[k] = cz + R * Math.sin(angles[k])
        cornerH[k] = heightAt(cornerX[k], cornerZ[k])
      }
      const centerH = quant((cornerH[0] + cornerH[1] + cornerH[2] + cornerH[3] + cornerH[4] + cornerH[5]) / 6)

      positions.push(cx, centerH, cz); surf.push(tempAt(cx, cz), humAt(cx, cz), centerH)
      for (let k = 0; k < 6; k++) {
        positions.push(cornerX[k], cornerH[k], cornerZ[k])
        surf.push(tempAt(cornerX[k], cornerZ[k]), humAt(cornerX[k], cornerZ[k]), cornerH[k])
      }
      // Fan: (centre, next corner, this corner) → +Y normals.
      for (let k = 0; k < 6; k++) indices.push(base, base + 1 + ((k + 1) % 6), base + 1 + k)
      base += 7
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
  geo.setAttribute('surfData', new THREE.BufferAttribute(new Float32Array(surf), 3))
  geo.setIndex(indices)
  geo.computeVertexNormals()
  return geo
}

/**
 * Close a tile *top* (square grid or hex) into a watertight, flat-bottomed solid for
 * export — additive: the top is untouched. The floor reuses the top's own triangle
 * connectivity projected to a single base height (so it follows the exact silhouette,
 * no polygon triangulation — works for the hex's jagged edge too), and each boundary
 * edge is extruded down into a wall. `surfData` is carried onto the floor/walls with
 * the column's surfaceHeight preserved, so depth (= surfaceHeight − y) grows downward
 * and the consumer/our material reads strata on the sides — same scheme as the CSG solid.
 */
export function solidifyTileGeometry(top: THREE.BufferGeometry, baseDepth: number): THREE.BufferGeometry {
  const pos = top.getAttribute('position') as THREE.BufferAttribute
  const sd = top.getAttribute('surfData') as THREE.BufferAttribute | undefined
  const idx = top.getIndex()
  if (!idx) throw new Error('solidifyTileGeometry: top geometry must be indexed.')
  const V = pos.count

  let minY = Infinity
  for (let i = 0; i < V; i++) minY = Math.min(minY, pos.getY(i))
  const baseY = minY - Math.max(0, baseDepth)

  const positions = new Float32Array(V * 2 * 3)
  const surf = sd ? new Float32Array(V * 2 * 3) : null
  for (let i = 0; i < V; i++) {
    const b = V + i
    positions[i * 3] = pos.getX(i); positions[i * 3 + 1] = pos.getY(i); positions[i * 3 + 2] = pos.getZ(i)
    positions[b * 3] = pos.getX(i); positions[b * 3 + 1] = baseY; positions[b * 3 + 2] = pos.getZ(i)
    if (sd && surf) {
      surf[i * 3] = sd.getX(i); surf[i * 3 + 1] = sd.getY(i); surf[i * 3 + 2] = sd.getZ(i)
      surf[b * 3] = sd.getX(i); surf[b * 3 + 1] = sd.getY(i); surf[b * 3 + 2] = sd.getZ(i)
    }
  }

  const indices: number[] = []
  for (let t = 0; t < idx.count; t += 3) {
    const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2)
    indices.push(a, b, c)              // top (unchanged)
    indices.push(a + V, c + V, b + V)  // floor (reversed → faces down)
  }

  // Boundary edges (used by exactly one triangle) → vertical walls. The stored
  // direction is the one from its single triangle, so walls wind outward.
  const seen = new Map<number, { a: number; b: number; count: number }>()
  const note = (a: number, b: number) => {
    const k = a < b ? a * V + b : b * V + a
    const e = seen.get(k)
    if (e) e.count++; else seen.set(k, { a, b, count: 1 })
  }
  for (let t = 0; t < idx.count; t += 3) {
    const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2)
    note(a, b); note(b, c); note(c, a)
  }
  for (const e of seen.values()) {
    if (e.count !== 1) continue
    const { a, b } = e
    indices.push(a, a + V, b + V)
    indices.push(a, b + V, b)
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  if (surf) geo.setAttribute('surfData', new THREE.BufferAttribute(surf, 3))
  geo.setIndex(indices)
  geo.computeVertexNormals()
  return geo
}
