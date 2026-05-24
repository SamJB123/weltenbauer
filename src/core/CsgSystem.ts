import * as THREE from 'three/webgpu'
import { Brush, Evaluator, ADDITION, SUBTRACTION, INTERSECTION } from 'three-bvh-csg'

/**
 * Converts the terrain heightfield into a closed, watertight solid suitable for
 * CSG, and performs boolean operations (via three-bvh-csg) to carve caves/tunnels.
 *
 * This is intentionally a *separate* representation from the heightfield pipeline:
 * CSG produces overhangs and voids a heightmap can't represent, so the result is
 * an additional 3D mesh, not something the brush/climate/biome systems operate on.
 *
 * The solid is built in the same world layout as the display terrain (X right,
 * Y up = height, Z forward), so it overlays the terrain when given the same
 * position offset.
 */

export interface SolidOptions {
  size: number             // world extent in units (config.size * 1000)
  seaLevel: number         // height value of the water surface
  undergroundDepth: number // metres below sea level for the solid's floor (0 = sea level)
  // Per-top-vertex climate (n each) carried as a packed `surfData` vec3
  // (temperature, humidity, surfaceHeight) so the solid's material can classify
  // biomes per-fragment from the same inputs a consumer would use. All continuous
  // → safe to interpolate through CSG (unlike discrete biome ids). See docs/solid-export.md.
  topTemperature?: Float32Array
  topHumidity?: Float32Array
}

/**
 * Build a closed manifold solid from a heightfield: a top surface (the terrain),
 * a matching bottom grid at the floor, and skirt walls joining their edges. The
 * floor is clamped below the lowest terrain so the volume is always non-degenerate.
 */
export function buildSolidGeometry(
  heightData: Float32Array,
  resolution: number,
  opts: SolidOptions
): THREE.BufferGeometry {
  const res = resolution
  const step = opts.size / (res - 1)
  const half = opts.size / 2

  let minH = Infinity
  for (let i = 0; i < heightData.length; i++) if (heightData[i] < minH) minH = heightData[i]
  const floorY = Math.min(opts.seaLevel - opts.undergroundDepth, minH - 1)

  const gridCount = res * res
  const positions = new Float32Array(gridCount * 2 * 3)
  // Packed climate: x = temperature, y = humidity, z = surfaceHeight (the terrain
  // height of this column, so depth-below-surface = surfaceHeight − vertex.y).
  const surfData = new Float32Array(gridCount * 2 * 3)
  const topTemp = opts.topTemperature
  const topHum = opts.topHumidity

  // Top vertices (terrain surface) then bottom vertices (flat floor).
  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const i = iz * res + ix
      const x = ix * step - half
      const z = iz * step - half
      positions[i * 3] = x
      positions[i * 3 + 1] = heightData[i]
      positions[i * 3 + 2] = z
      const b = gridCount + i
      positions[b * 3] = x
      positions[b * 3 + 1] = floorY
      positions[b * 3 + 2] = z

      // Climate: both top and bottom of a column inherit the column's surface
      // climate; surfaceHeight is the same for both so depth grows downward.
      const t = topTemp ? topTemp[i] : 0
      const h = topHum ? topHum[i] : 0
      const sh = heightData[i]
      surfData[i * 3] = t;     surfData[i * 3 + 1] = h;     surfData[i * 3 + 2] = sh
      surfData[b * 3] = t;     surfData[b * 3 + 1] = h;     surfData[b * 3 + 2] = sh
    }
  }

  const top = (ix: number, iz: number) => iz * res + ix
  const bot = (ix: number, iz: number) => gridCount + iz * res + ix

  // Emit a quad (a→b→c→d around its perimeter) as two triangles, flipping the
  // winding so the face normal agrees with the desired outward direction. This
  // keeps the whole solid consistently outward-wound without hand-deriving each
  // face's order — which CSG relies on to tell solid from empty.
  const indices: number[] = []
  const pa = new THREE.Vector3(), pb = new THREE.Vector3(), pc = new THREE.Vector3()
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3()
  const getP = (idx: number, out: THREE.Vector3) =>
    out.set(positions[idx * 3], positions[idx * 3 + 1], positions[idx * 3 + 2])

  const addQuad = (a: number, b: number, c: number, d: number, ox: number, oy: number, oz: number) => {
    getP(a, pa); getP(b, pb); getP(c, pc)
    e1.subVectors(pb, pa); e2.subVectors(pc, pa); n.crossVectors(e1, e2)
    if (n.x * ox + n.y * oy + n.z * oz >= 0) {
      indices.push(a, b, c, a, c, d)
    } else {
      indices.push(a, c, b, a, d, c)
    }
  }

  // Top surface (outward +Y) and bottom surface (outward -Y).
  for (let iz = 0; iz < res - 1; iz++) {
    for (let ix = 0; ix < res - 1; ix++) {
      addQuad(top(ix, iz), top(ix + 1, iz), top(ix + 1, iz + 1), top(ix, iz + 1), 0, 1, 0)
      addQuad(bot(ix, iz), bot(ix + 1, iz), bot(ix + 1, iz + 1), bot(ix, iz + 1), 0, -1, 0)
    }
  }

  // Skirt walls along the four borders (outward = the border's facing direction).
  for (let ix = 0; ix < res - 1; ix++) {
    addQuad(top(ix, 0), top(ix + 1, 0), bot(ix + 1, 0), bot(ix, 0), 0, 0, -1)
    addQuad(top(ix, res - 1), top(ix + 1, res - 1), bot(ix + 1, res - 1), bot(ix, res - 1), 0, 0, 1)
  }
  for (let iz = 0; iz < res - 1; iz++) {
    addQuad(top(0, iz), top(0, iz + 1), bot(0, iz + 1), bot(0, iz), -1, 0, 0)
    addQuad(top(res - 1, iz), top(res - 1, iz + 1), bot(res - 1, iz + 1), bot(res - 1, iz), 1, 0, 0)
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('surfData', new THREE.BufferAttribute(surfData, 3))
  geometry.setIndex(indices) // three picks Uint16/Uint32 automatically
  geometry.computeVertexNormals()
  return geometry
}

/**
 * Subtract a sphere from the solid (the Stage-1 validation cut) and return a
 * fresh BufferGeometry. Rebuilt as native attribute arrays so the result is a
 * clean geometry regardless of which three build three-bvh-csg constructed.
 */
export type CsgShape = 'sphere' | 'box' | 'cylinder'
export type CsgOpShape = CsgShape | 'stroke' // 'stroke' = a path of sphere cuts (drag brush)
export type CsgOp = 'subtract' | 'add' | 'intersect'

/** One editable, non-destructive cutter in the operation stack. */
export interface CsgOperationDef {
  id: number
  shape: CsgOpShape
  position: [number, number, number] // in solid space (Y = terrain height units)
  rotation: [number, number, number] // radians
  scale: [number, number, number]    // world units (the unit primitive is scaled by this)
  operation: CsgOp
  enabled: boolean
  points?: [number, number, number][] // stroke path (solid space), used when shape === 'stroke'
}

const OP_CONST: Record<CsgOp, number> = {
  subtract: SUBTRACTION,
  add: ADDITION,
  intersect: INTERSECTION
}

/** Unit-sized cutter primitive, scaled/positioned per-operation by its transform. */
export function cutterGeometry(shape: CsgShape): THREE.BufferGeometry {
  switch (shape) {
    case 'box': return new THREE.BoxGeometry(1, 1, 1)
    case 'cylinder': return new THREE.CylinderGeometry(0.5, 0.5, 1, 48)
    case 'sphere':
    default: return new THREE.SphereGeometry(0.5, 48, 32)
  }
}

/** Copy a CSG result's geometry into a clean native BufferGeometry (build-agnostic). */
function reconstruct(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry()
  const pos = geometry.getAttribute('position')
  out.setAttribute('position', new THREE.BufferAttribute(pos.array as Float32Array, 3))
  const nrm = geometry.getAttribute('normal')
  if (nrm) out.setAttribute('normal', new THREE.BufferAttribute(nrm.array as Float32Array, 3))
  const sd = geometry.getAttribute('surfData')
  if (sd) out.setAttribute('surfData', new THREE.BufferAttribute(sd.array as Float32Array, 3))
  if (geometry.index) {
    out.setIndex(new THREE.BufferAttribute(geometry.index.array as Uint32Array, 1))
  }
  return out
}

/** Surface heightfield + climate + grid info, used to attribute cut faces by their world XZ. */
export interface SurfaceSampler {
  heightData: Float32Array
  resolution: number
  size: number
  temperature: Float32Array // same resolution as heightData
  humidity: Float32Array    // same resolution as heightData
}

/**
 * Build a per-vertex packed `surfData` (temperature, humidity, surfaceHeight) for a
 * positioned cutter: each vertex samples the surface climate + terrain height at its
 * world XZ. Depth-below-surface is recovered in the shader as surfaceHeight − vertex.y,
 * so a fresh cut face carries the surface climate up top and reads as deep underground
 * lower down (the same scheme the solid's columns use).
 */
function cutterSurfData(geo: THREE.BufferGeometry, matrixWorld: THREE.Matrix4, surface: SurfaceSampler): Float32Array {
  const pos = geo.getAttribute('position')
  const count = pos.count
  const out = new Float32Array(count * 3)
  const v = new THREE.Vector3()
  const { heightData, temperature, humidity, resolution: res, size } = surface
  const step = size / (res - 1)
  const half = size / 2

  for (let i = 0; i < count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(matrixWorld)
    const ix = Math.max(0, Math.min(res - 1, Math.round((v.x + half) / step)))
    const iz = Math.max(0, Math.min(res - 1, Math.round((v.z + half) / step)))
    const idx = iz * res + ix
    out[i * 3] = temperature[idx]
    out[i * 3 + 1] = humidity[idx]
    out[i * 3 + 2] = heightData[idx]
  }
  return out
}

/**
 * Cut a single primitive into a geometry and return a fresh result. `current` is
 * read, not modified or disposed (caller owns it). Carries `surfData` through so the
 * surface climate stays on top faces and is sampled per-vertex onto the new cut faces
 * (the solid's material classifies biome + depth-strata from it per-fragment).
 */
function evalCut(
  current: THREE.BufferGeometry,
  shape: CsgShape,
  position: [number, number, number],
  rotation: [number, number, number],
  scale: [number, number, number],
  operation: CsgOp,
  surface: SurfaceSampler
): THREE.BufferGeometry {
  const material = new THREE.MeshStandardMaterial()
  const evaluator = new Evaluator()
  evaluator.attributes = ['position', 'normal', 'surfData']
  evaluator.useGroups = false // single material; skip group/material bookkeeping

  const base = new Brush(current, material)
  base.updateMatrixWorld()

  const geo = cutterGeometry(shape)
  const cutter = new Brush(geo, material)
  cutter.position.set(position[0], position[1], position[2])
  cutter.rotation.set(rotation[0], rotation[1], rotation[2])
  cutter.scale.set(scale[0], scale[1], scale[2])
  cutter.updateMatrixWorld()
  geo.setAttribute('surfData', new THREE.BufferAttribute(cutterSurfData(geo, cutter.matrixWorld, surface), 3))

  const result = evaluator.evaluate(base, cutter, OP_CONST[operation])
  const out = reconstruct(result.geometry)
  geo.dispose()
  result.geometry.dispose()
  return out
}

/**
 * Apply one operation to a geometry and return the new result (O(1) for the
 * incremental click-to-dab/stroke path). A 'stroke' op is a path of sphere cuts —
 * each a manifold cut, so we avoid building a non-manifold union. `currentGeometry`
 * is read, not modified or disposed.
 */
export function applyOperation(
  currentGeometry: THREE.BufferGeometry,
  op: CsgOperationDef,
  surface: SurfaceSampler
): THREE.BufferGeometry {
  if (op.shape === 'stroke') {
    const pts = op.points ?? []
    if (pts.length === 0) return reconstruct(currentGeometry)
    let geo = currentGeometry
    let owned = false
    for (const p of pts) {
      const next = evalCut(geo, 'sphere', p, [0, 0, 0], op.scale, op.operation, surface)
      if (owned) geo.dispose()
      geo = next
      owned = true
    }
    return geo
  }
  return evalCut(currentGeometry, op.shape, op.position, op.rotation, op.scale, op.operation, surface)
}

/**
 * Replay the whole stack against the solid (for edits/deletes). Skips disabled
 * ops. Returns a clean copy of the solid if nothing is enabled. Never disposes
 * the caller's solid geometry.
 */
export function evaluateOperations(
  solidGeometry: THREE.BufferGeometry,
  operations: CsgOperationDef[],
  surface: SurfaceSampler
): THREE.BufferGeometry {
  let current = solidGeometry
  let owned = false
  for (const op of operations) {
    if (!op.enabled) continue
    const next = applyOperation(current, op, surface)
    if (owned) current.dispose()
    current = next
    owned = true
  }
  return owned ? current : reconstruct(solidGeometry)
}
