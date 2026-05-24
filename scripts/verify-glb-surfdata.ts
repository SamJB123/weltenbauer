/**
 * Step-3 verification (CPU): the carved geometry carries `surfData` and NO longer
 * carries `color` (the dead path removed in Step 3). GLTFExporter renames custom
 * attributes to `_<UPPER>` → `_SURFDATA`; that emission + the zip are browser-only
 * (GLTFExporter's Blob/FileReader buffer pipeline doesn't complete under Node), so
 * they're verified in-browser, not here.
 *
 * Run: npx tsx scripts/verify-glb-surfdata.ts
 */
import { buildSolidGeometry, evaluateOperations, SurfaceSampler, CsgOperationDef } from '../src/core/CsgSystem'

async function main() {
  const res = 20, size = 1000, n = res * res
  const heightData = new Float32Array(n)
  const temperature = new Float32Array(n)
  const humidity = new Float32Array(n)
  for (let i = 0; i < n; i++) { heightData[i] = 20; temperature[i] = 18; humidity[i] = 0.5 }
  const surface: SurfaceSampler = { heightData, resolution: res, size, temperature, humidity }

  const solid = buildSolidGeometry(heightData, res, { size, seaLevel: 0, undergroundDepth: 20, topTemperature: temperature, topHumidity: humidity })
  const op: CsgOperationDef = { id: 1, shape: 'sphere', position: [0, 25, 0], rotation: [0, 0, 0], scale: [200, 200, 200], operation: 'subtract', enabled: true }
  const carved = evaluateOperations(solid, [op], surface)

  // Step-3 cleanup: geometry carries surfData (a vec3) and no longer carries color.
  const surf = carved.getAttribute('surfData')
  const hasColor = !!carved.getAttribute('color')
  const okSurf = !!surf && surf.itemSize === 3
  console.log(`geometry: surfData=${okSurf} (itemSize ${surf?.itemSize}) color=${hasColor}`)
  console.log('(GLTFExporter renames surfData → _SURFDATA; verified in-browser.)')

  const pass = okSurf && !hasColor
  console.log(pass ? '\nPASS' : '\nFAIL')
  process.exit(pass ? 0 : 1)
}
main()
