/**
 * Step-0 verification: does the per-fragment-friendly `BiomeSystem.classifySample`
 * (all-12 accumulate, no top-K sort — the form we'll transcribe to TSL) reproduce
 * the canonical surface weights / tint that the flat terrain bakes via
 * `compute()` → `surfaceWeights()` / `paletteColors()` (the top-4 path)?
 *
 * Run: npx tsx scripts/verify-classifier.ts
 */
import { BiomeSystem, BiomeOptions, BiomeField } from '../src/core/BiomeSystem'
import type { ClimateFields } from '../src/core/ClimateSystem'

// Test several configs; a wide blendMargin maximizes band overlap (the case that
// could push >4 biomes non-zero and make the top-4 truncation diverge).
const CONFIGS: BiomeOptions[] = [
  { seaLevel: 0, beachHeight: 12, blendMargin: 2.5 }, // defaults
  { seaLevel: 0, beachHeight: 12, blendMargin: 8 },
  { seaLevel: 0, beachHeight: 2, blendMargin: 15 },   // extreme overlap stress
]

// Gate on the DEFAULT config only: it must match the canonical path ~exactly.
// The wide-margin configs are informational — we deliberately accept the tiny
// drift there (sort-free keeps all biomes; the RGBA export keeps only top-4).
const results = CONFIGS.map((opts, i) => {
  console.log(`\n=== opts ${JSON.stringify(opts)}${i === 0 ? ' [GATED: must be ~exact]' : ' [informational]'} ===`)
  return { i, maxSurfDiff: runConfig(opts) }
})
const defaultExact = results[0].maxSurfDiff < 0.001
console.log(defaultExact
  ? '\nPASS — default config matches canonical to within 0.001; wide-margin drift accepted by design.'
  : '\nFAIL — default config diverges from canonical.')
process.exit(defaultExact ? 0 : 1)

// Returns the max surface-weight |Δ| vs the canonical top-4 path for this config.
function runConfig(opts: BiomeOptions): number {
// Dense sweep over the whole (height, temperature, humidity) domain.
const R = 120 // R*R samples
const n = R * R
const height = new Float32Array(n)
const temperature = new Float32Array(n)
const humidity = new Float32Array(n)

const HMIN = opts.seaLevel - 30, HMAX = opts.seaLevel + 60
const TMIN = -20, TMAX = 45
const WMIN = 0, WMAX = 1

let i = 0
for (let a = 0; a < R; a++) {
  for (let b = 0; b < R; b++) {
    // Mix the three axes across the 2D grid so every combination is well covered.
    const fh = (a / (R - 1))
    const ft = (b / (R - 1))
    const fw = ((a + b) % R) / (R - 1)
    height[i] = HMIN + fh * (HMAX - HMIN)
    temperature[i] = TMIN + ft * (TMAX - TMIN)
    humidity[i] = WMIN + fw * (WMAX - WMIN)
    i++
  }
}

const climate: ClimateFields = { temperature, humidity } as ClimateFields

// Canonical (top-4) path.
const field: BiomeField = BiomeSystem.compute(height, climate, R, opts)
const canonSurface = BiomeSystem.surfaceWeights(field)   // n*4
const canonTint = BiomeSystem.paletteColors(field)       // n*3

// Per-sample (all-12) path.
let maxSurfDiff = 0, sumSurfDiff = 0
let maxTintDiff = 0, sumTintDiff = 0
let worstSurfAt = -1
let worst: { h: number; t: number; w: number; canon: number[]; mine: number[] } | null = null

for (let k = 0; k < n; k++) {
  const { surface, tint } = BiomeSystem.classifySample(height[k], temperature[k], humidity[k], opts)

  for (let c = 0; c < 4; c++) {
    const d = Math.abs(surface[c] - canonSurface[k * 4 + c])
    sumSurfDiff += d
    if (d > maxSurfDiff) {
      maxSurfDiff = d
      worstSurfAt = k
      worst = {
        h: height[k], t: temperature[k], w: humidity[k],
        canon: [0, 1, 2, 3].map(c2 => +canonSurface[k * 4 + c2].toFixed(4)),
        mine: surface.map(v => +v.toFixed(4))
      }
    }
  }
  for (let c = 0; c < 3; c++) {
    const d = Math.abs(tint[c] - canonTint[k * 3 + c])
    sumTintDiff += d
    if (d > maxTintDiff) maxTintDiff = d
  }
}

console.log(`samples: ${n}`)
console.log(`surface weights  max|Δ| = ${maxSurfDiff.toFixed(5)}   mean|Δ| = ${(sumSurfDiff / (n * 4)).toFixed(6)}`)
console.log(`tint (palette)   max|Δ| = ${maxTintDiff.toFixed(5)}   mean|Δ| = ${(sumTintDiff / (n * 3)).toFixed(6)}`)
if (worst) {
  console.log(`worst surface sample @${worstSurfAt}: h=${worst.h.toFixed(1)} t=${worst.t.toFixed(1)} w=${worst.w.toFixed(2)}`)
  console.log(`  canonical [soil,grass,rock,snow] = ${JSON.stringify(worst.canon)}`)
  console.log(`  classifySample                   = ${JSON.stringify(worst.mine)}`)
}

return maxSurfDiff
}
