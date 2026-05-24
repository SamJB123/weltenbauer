/**
 * Step-1 verification (CPU — three-bvh-csg's Evaluator needs no WebGPU): build a
 * solid carrying packed `surfData` (temperature, humidity, surfaceHeight), subtract
 * a sphere, and confirm the attribute survives the boolean with sane, in-range,
 * non-NaN values on the carved result (including freshly created cut-face verts).
 *
 * Run: npx tsx scripts/verify-csg-surfdata.ts
 */
import { buildSolidGeometry, evaluateOperations, SurfaceSampler, CsgOperationDef } from '../src/core/CsgSystem'

const res = 24
const size = 1000
const n = res * res

// Synthetic surface: a smooth hill; temperature falls with height, humidity rises.
const heightData = new Float32Array(n)
const temperature = new Float32Array(n)
const humidity = new Float32Array(n)
for (let iz = 0; iz < res; iz++) {
  for (let ix = 0; ix < res; ix++) {
    const i = iz * res + ix
    const dx = (ix / (res - 1)) - 0.5
    const dz = (iz / (res - 1)) - 0.5
    const h = 40 * Math.exp(-(dx * dx + dz * dz) * 8) // 0..40m hill
    heightData[i] = h
    temperature[i] = 25 - h * 0.3   // 25°C at coast → ~13°C on the peak
    humidity[i] = 0.3 + h * 0.01    // 0.3 → ~0.7
  }
}

const surface: SurfaceSampler = { heightData, resolution: res, size, temperature, humidity }

const solid = buildSolidGeometry(heightData, res, {
  size, seaLevel: 0, undergroundDepth: 20,
  topTemperature: temperature, topHumidity: humidity
})

// A sphere subtract biting into the top of the hill (carves new faces with depth).
const op: CsgOperationDef = {
  id: 1, shape: 'sphere',
  position: [0, 30, 0], rotation: [0, 0, 0], scale: [200, 200, 200],
  operation: 'subtract', enabled: true
}

const carved = evaluateOperations(solid, [op], surface)

const sd = carved.getAttribute('surfData')
const pos = carved.getAttribute('position')
let ok = true
function check(cond: boolean, msg: string) { if (!cond) { ok = false; console.log('  FAIL: ' + msg) } }

check(!!sd, 'carved geometry has a surfData attribute')
if (sd) {
  check(sd.itemSize === 3, `surfData itemSize is 3 (got ${sd.itemSize})`)
  check(sd.count === pos.count, `surfData count matches position count (${sd.count} vs ${pos.count})`)

  let tMin = Infinity, tMax = -Infinity, hMin = Infinity, hMax = -Infinity, shMin = Infinity, shMax = -Infinity
  let nan = 0
  for (let i = 0; i < sd.count; i++) {
    const t = sd.getX(i), h = sd.getY(i), sh = sd.getZ(i)
    if (Number.isNaN(t) || Number.isNaN(h) || Number.isNaN(sh)) nan++
    tMin = Math.min(tMin, t); tMax = Math.max(tMax, t)
    hMin = Math.min(hMin, h); hMax = Math.max(hMax, h)
    shMin = Math.min(shMin, sh); shMax = Math.max(shMax, sh)
  }
  console.log(`  surfData ranges  temp [${tMin.toFixed(2)}, ${tMax.toFixed(2)}]  hum [${hMin.toFixed(3)}, ${hMax.toFixed(3)}]  surfaceH [${shMin.toFixed(2)}, ${shMax.toFixed(2)}]`)
  console.log(`  NaN values: ${nan}`)
  check(nan === 0, 'no NaN surfData values')
  // Values must stay within the source field ranges (interpolation can't exceed them).
  check(tMin >= 12 && tMax <= 25.5, 'temperature within source range [~13, 25]')
  check(hMin >= 0.29 && hMax <= 0.71, 'humidity within source range [0.3, 0.7]')
  check(shMin >= -0.1 && shMax <= 40.5, 'surfaceHeight within source range [0, 40]')
}

console.log(`vertices: base solid had ${(solid.getAttribute('position').count)}, carved has ${pos.count}`)
console.log(ok ? '\nPASS — surfData carried through CSG with sane values.' : '\nFAIL — see above.')
process.exit(ok ? 0 : 1)
