/**
 * Verify the tile representations + solidify (CPU-only geometry):
 *  - both square grid and hex tops carry `surfData` (continuous climate), no `color`.
 *  - solidifyTileGeometry closes them into a watertight manifold (every edge shared by
 *    exactly 2 triangles), carries surfData onto floor/walls, and has no NaNs.
 *
 * Run: npx tsx scripts/verify-tile-solid.ts
 */
import { buildGridGeometry, buildHexGeometry, solidifyTileGeometry } from '../src/core/GridTerrain'
import * as THREE from 'three/webgpu'

const res = 16, n = res * res
const height = new Float32Array(n), temp = new Float32Array(n), hum = new Float32Array(n)
for (let z = 0; z < res; z++) for (let x = 0; x < res; x++) {
  const i = z * res + x
  const dx = x / (res - 1) - 0.5, dz = z / (res - 1) - 0.5
  height[i] = 40 * Math.exp(-(dx * dx + dz * dz) * 6)
  temp[i] = 25 - height[i] * 0.3
  hum[i] = 0.3 + height[i] * 0.01
}
const opts = { cells: 24, sizeUnits: 1000, step: 0 }

let ok = true
const check = (c: boolean, m: string) => { if (!c) { ok = false; console.log('  FAIL: ' + m) } }

function audit(label: string, top: THREE.BufferGeometry) {
  check(!!top.getAttribute('surfData'), `${label}: top has surfData`)
  check(!top.getAttribute('color'), `${label}: top has NO baked color`)

  const solid = solidifyTileGeometry(top, 20)
  const pos = solid.getAttribute('position')
  const sd = solid.getAttribute('surfData')
  const idx = solid.getIndex()!

  // NaN scan.
  let nan = 0
  for (let i = 0; i < pos.count; i++) {
    if (Number.isNaN(pos.getX(i)) || Number.isNaN(pos.getY(i)) || Number.isNaN(pos.getZ(i))) nan++
    if (sd && (Number.isNaN(sd.getX(i)) || Number.isNaN(sd.getY(i)) || Number.isNaN(sd.getZ(i)))) nan++
  }
  check(nan === 0, `${label}: no NaN in solid`)
  check(!!sd && sd.count === pos.count, `${label}: solid carries surfData on every vertex`)

  // Closed manifold: every undirected edge used by exactly 2 triangles.
  const edges = new Map<string, number>()
  for (let t = 0; t < idx.count; t += 3) {
    const tri = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)]
    for (let e = 0; e < 3; e++) {
      const a = tri[e], b = tri[(e + 1) % 3]
      const k = a < b ? `${a}_${b}` : `${b}_${a}`
      edges.set(k, (edges.get(k) ?? 0) + 1)
    }
  }
  let boundary = 0, nonmanifold = 0
  for (const c of edges.values()) { if (c === 1) boundary++; else if (c > 2) nonmanifold++ }
  check(boundary === 0, `${label}: no boundary (open) edges — got ${boundary}`)
  check(nonmanifold === 0, `${label}: no non-manifold edges — got ${nonmanifold}`)
  console.log(`  ${label}: top ${top.getAttribute('position').count} verts → solid ${pos.count} verts, ${idx.count / 3} tris`)
}

audit('square grid', buildGridGeometry(height, res, temp, hum, opts))
audit('hex tiles', buildHexGeometry(height, res, temp, hum, opts))

console.log(ok ? '\nPASS' : '\nFAIL')
process.exit(ok ? 0 : 1)
