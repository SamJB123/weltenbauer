import * as THREE from 'three/webgpu'
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg'

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
  geometry.setIndex(indices) // three picks Uint16/Uint32 automatically
  geometry.computeVertexNormals()
  return geometry
}

/**
 * Subtract a sphere from the solid (the Stage-1 validation cut) and return a
 * fresh BufferGeometry. Rebuilt as native attribute arrays so the result is a
 * clean geometry regardless of which three build three-bvh-csg constructed.
 */
export function carveSphere(
  solidGeometry: THREE.BufferGeometry,
  center: THREE.Vector3,
  radius: number
): THREE.BufferGeometry {
  const material = new THREE.MeshStandardMaterial()

  const solid = new Brush(solidGeometry, material)
  solid.updateMatrixWorld()

  const cutterGeometry = new THREE.SphereGeometry(radius, 48, 32)
  const cutter = new Brush(cutterGeometry, material)
  cutter.position.copy(center)
  cutter.updateMatrixWorld()

  const evaluator = new Evaluator()
  evaluator.attributes = ['position', 'normal']
  const result = evaluator.evaluate(solid, cutter, SUBTRACTION)

  // Reconstruct as native arrays so the geometry is unambiguously our three build's.
  const out = new THREE.BufferGeometry()
  const pos = result.geometry.getAttribute('position')
  out.setAttribute('position', new THREE.BufferAttribute(pos.array as Float32Array, 3))
  const nrm = result.geometry.getAttribute('normal')
  if (nrm) out.setAttribute('normal', new THREE.BufferAttribute(nrm.array as Float32Array, 3))
  if (result.geometry.index) {
    out.setIndex(new THREE.BufferAttribute(result.geometry.index.array as Uint32Array, 1))
  }

  cutterGeometry.dispose()
  result.geometry.dispose()
  return out
}
