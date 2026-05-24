/**
 * Verify CSG works on a solidified tile (the carve-the-tiles path): build a hex top,
 * solidify it, subtract a sphere, and confirm the boolean succeeds and the result
 * still carries surfData with no NaNs.
 *
 * Run: npx tsx scripts/verify-tile-carve.ts
 */
import { buildHexGeometry, solidifyTileGeometry } from '../src/core/GridTerrain'
import { evaluateOperations, SurfaceSampler, CsgOperationDef } from '../src/core/CsgSystem'

const res = 16, n = res * res
const height = new Float32Array(n), temp = new Float32Array(n), hum = new Float32Array(n)
for (let z = 0; z < res; z++) for (let x = 0; x < res; x++) {
  const i = z * res + x
  const dx = x / (res - 1) - 0.5, dz = z / (res - 1) - 0.5
  height[i] = 40 * Math.exp(-(dx * dx + dz * dz) * 6)
  temp[i] = 25 - height[i] * 0.3
  hum[i] = 0.3 + height[i] * 0.01
}

const top = buildHexGeometry(height, res, temp, hum, { cells: 20, sizeUnits: 1000, step: 0 })
const base = solidifyTileGeometry(top, 30)
const surface: SurfaceSampler = { heightData: height, resolution: res, size: 1000, temperature: temp, humidity: hum }
const op: CsgOperationDef = { id: 1, shape: 'sphere', position: [0, 30, 0], rotation: [0, 0, 0], scale: [200, 200, 200], operation: 'subtract', enabled: true }

const carved = evaluateOperations(base, [op], surface)
const sd = carved.getAttribute('surfData')
const pos = carved.getAttribute('position')

let ok = true
const check = (c: boolean, m: string) => { if (!c) { ok = false; console.log('  FAIL: ' + m) } }
check(!!sd, 'carved tile solid has surfData')
check(pos.count > 0, 'carved tile solid has geometry')
let nan = 0
if (sd) for (let i = 0; i < sd.count; i++) if (Number.isNaN(sd.getX(i)) || Number.isNaN(sd.getY(i)) || Number.isNaN(sd.getZ(i))) nan++
check(nan === 0, 'no NaN surfData after carve')
console.log(`  base ${base.getAttribute('position').count} verts → carved ${pos.count} verts, ${carved.index ? carved.index.count / 3 : '?'} tris`)

console.log(ok ? '\nPASS' : '\nFAIL')
process.exit(ok ? 0 : 1)
