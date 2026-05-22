/**
 * Derives per-cell climate fields (temperature + humidity) from a finished
 * heightmap. These feed terrain visualization now and biome classification later.
 *
 * Temperature model: a sea-level baseline, a north-south latitude gradient, and
 * cooling with elevation (so peaks are cold), plus a little noise.
 *
 * Humidity model (0..1): a baseline, extra moisture near the coast (decaying
 * inland via a distance-to-ocean transform), drying with elevation, and a
 * rain-shadow term that dries the leeward side of upwind mountains.
 *
 * All fields are indexed `y * resolution + x`, matching the heightmap and the
 * terrain geometry's vertex order.
 */

// View modes for the terrain. 'biome' textures the mesh by biome (via the TSL
// material); 'biomeColor' shows flat biome palette colors (for verifying
// classification). Named ClimateView for historical reasons.
export type ClimateView = 'normal' | 'temperature' | 'humidity' | 'biome' | 'biomeColor'

/**
 * Fixed absolute °C range used to color the temperature map, so colors mean real
 * temperatures (like a thermometer) rather than being rescaled to each terrain's
 * own min/max. This keeps `baseTemperature` and the other knobs visible and
 * matches the temperature axis of a Whittaker biome chart. Values outside the
 * range are clamped.
 */
export const TEMPERATURE_DISPLAY_MIN = -10
export const TEMPERATURE_DISPLAY_MAX = 35

export interface ClimateOptions {
  seaLevel: number          // height of the water surface
  maxLandHeight: number     // highest terrain height, used to normalize elevation
  baseTemperature: number   // °C at sea level, mid-map
  latitudeRange: number     // °C spread from one edge of the map to the other
  elevationCooling: number  // °C lost from sea level up to the highest land
  temperatureNoise: number  // °C of random local variation
  humidityBase: number      // 0..1 baseline humidity
  coastalMoisture: number   // 0..1 extra humidity at the shoreline
  coastalFalloff: number    // 0..1 fraction of the map over which coastal moisture decays
  elevationDrying: number   // 0..1 humidity lost from sea level to the highest land
  rainShadowStrength: number// 0..1 leeward drying behind upwind ridges
  windDirection: number     // prevailing wind, degrees (0 = +x, 90 = +y)
  humidityNoise: number     // 0..1 random local variation
}

export interface ClimateFields {
  temperature: Float32Array
  humidity: Float32Array
  temperatureRange: { min: number; max: number }
}

type NoiseFn = (x: number, y: number) => number

export class ClimateSystem {
  /** Compute temperature + humidity fields for a heightmap. `noise` should return ~[-1, 1]. */
  static compute(
    heightData: Float32Array,
    resolution: number,
    opts: ClimateOptions,
    noise: NoiseFn
  ): ClimateFields {
    const n = resolution * resolution
    const temperature = new Float32Array(n)
    const humidity = new Float32Array(n)

    const { seaLevel } = opts
    const landRange = Math.max(1, opts.maxLandHeight - seaLevel)

    // Distance (in cells) from each cell to the nearest ocean cell.
    const oceanDist = this.distanceToOcean(heightData, resolution, seaLevel)
    const falloffCells = Math.max(1, opts.coastalFalloff * resolution)

    // Prevailing wind direction as a unit vector; "upwind" is the opposite way.
    const rad = (opts.windDirection * Math.PI) / 180
    const windX = Math.cos(rad)
    const windY = Math.sin(rad)

    let minT = Infinity
    let maxT = -Infinity

    for (let y = 0; y < resolution; y++) {
      for (let x = 0; x < resolution; x++) {
        const i = y * resolution + x
        const ny = (y / (resolution - 1)) * 2 - 1
        const nxn = (x / (resolution - 1)) * 2 - 1
        const h = heightData[i]
        const normElev = Math.max(0, Math.min(1, (h - seaLevel) / landRange))

        // --- Temperature ---
        let t = opts.baseTemperature
        t += -ny * (opts.latitudeRange * 0.5) // one edge warmer, the other cooler
        t -= normElev * opts.elevationCooling
        t += noise(nxn * 1.5 + 71.0, ny * 1.5 + 71.0) * opts.temperatureNoise
        temperature[i] = t
        if (t < minT) minT = t
        if (t > maxT) maxT = t

        // --- Humidity ---
        let hum = opts.humidityBase
        hum += Math.exp(-oceanDist[i] / falloffCells) * opts.coastalMoisture
        hum -= normElev * opts.elevationDrying
        if (opts.rainShadowStrength > 0) {
          hum -= this.rainShadow(heightData, resolution, x, y, windX, windY, h, landRange) *
            opts.rainShadowStrength
        }
        hum += noise(nxn * 2.0 + 311.0, ny * 2.0 + 311.0) * opts.humidityNoise
        humidity[i] = Math.max(0, Math.min(1, hum))
      }
    }

    return { temperature, humidity, temperatureRange: { min: minT, max: maxT } }
  }

  /**
   * Two-pass chamfer distance transform: distance in cells from each cell to the
   * nearest ocean cell (height <= seaLevel). Ocean cells are 0. If there is no
   * ocean at all, every cell stays effectively infinite (no coastal moisture).
   */
  private static distanceToOcean(
    heightData: Float32Array,
    resolution: number,
    seaLevel: number
  ): Float32Array {
    const INF = 1e9
    const DIAG = Math.SQRT2
    const d = new Float32Array(resolution * resolution)

    for (let i = 0; i < d.length; i++) {
      d[i] = heightData[i] <= seaLevel ? 0 : INF
    }

    // Forward pass: top-left to bottom-right.
    for (let y = 0; y < resolution; y++) {
      for (let x = 0; x < resolution; x++) {
        const i = y * resolution + x
        if (d[i] === 0) continue
        let m = d[i]
        if (x > 0) m = Math.min(m, d[i - 1] + 1)
        if (y > 0) m = Math.min(m, d[i - resolution] + 1)
        if (x > 0 && y > 0) m = Math.min(m, d[i - resolution - 1] + DIAG)
        if (x < resolution - 1 && y > 0) m = Math.min(m, d[i - resolution + 1] + DIAG)
        d[i] = m
      }
    }

    // Backward pass: bottom-right to top-left.
    for (let y = resolution - 1; y >= 0; y--) {
      for (let x = resolution - 1; x >= 0; x--) {
        const i = y * resolution + x
        let m = d[i]
        if (x < resolution - 1) m = Math.min(m, d[i + 1] + 1)
        if (y < resolution - 1) m = Math.min(m, d[i + resolution] + 1)
        if (x < resolution - 1 && y < resolution - 1) m = Math.min(m, d[i + resolution + 1] + DIAG)
        if (x > 0 && y < resolution - 1) m = Math.min(m, d[i + resolution - 1] + DIAG)
        d[i] = m
      }
    }

    return d
  }

  /**
   * March a few steps upwind and return how much higher the tallest upwind ridge
   * is than the current cell, normalized to [0, 1]. Cells sheltered behind tall
   * upwind terrain get a high value (drier).
   */
  private static rainShadow(
    heightData: Float32Array,
    resolution: number,
    x: number,
    y: number,
    windX: number,
    windY: number,
    currentHeight: number,
    landRange: number
  ): number {
    const steps = 8
    const spacing = Math.max(1, resolution * 0.02)
    let maxUpwind = currentHeight

    for (let s = 1; s <= steps; s++) {
      const sx = Math.round(x - windX * spacing * s)
      const sy = Math.round(y - windY * spacing * s)
      if (sx < 0 || sy < 0 || sx >= resolution || sy >= resolution) break
      const hh = heightData[sy * resolution + sx]
      if (hh > maxUpwind) maxUpwind = hh
    }

    return Math.max(0, Math.min(1, (maxUpwind - currentHeight) / landRange))
  }

  /**
   * Build a per-vertex RGB color array (length n*3) that visualizes a field with
   * a perceptual ramp: temperature cold→hot (blue→red), humidity dry→wet
   * (tan→teal). `range` rescales the field into [0, 1] before ramping.
   */
  static fieldToColors(
    field: Float32Array,
    view: ClimateView,
    range: { min: number; max: number }
  ): Float32Array {
    const colors = new Float32Array(field.length * 3)
    const span = Math.max(1e-6, range.max - range.min)
    const ramp = view === 'humidity' ? HUMIDITY_RAMP : TEMPERATURE_RAMP

    for (let i = 0; i < field.length; i++) {
      const t = Math.max(0, Math.min(1, (field[i] - range.min) / span))
      const c = sampleRamp(ramp, t)
      colors[i * 3] = c[0]
      colors[i * 3 + 1] = c[1]
      colors[i * 3 + 2] = c[2]
    }

    return colors
  }
}

type RampStop = [number, [number, number, number]]

const TEMPERATURE_RAMP: RampStop[] = [
  [0.0, [0.23, 0.30, 0.75]], // cold deep blue
  [0.25, [0.30, 0.65, 0.90]], // cool cyan
  [0.5, [0.45, 0.78, 0.40]], // mild green
  [0.75, [0.95, 0.80, 0.30]], // warm yellow
  [1.0, [0.85, 0.23, 0.18]] // hot red
]

const HUMIDITY_RAMP: RampStop[] = [
  [0.0, [0.80, 0.70, 0.45]], // arid tan
  [0.5, [0.55, 0.70, 0.40]], // semi-humid khaki-green
  [1.0, [0.15, 0.45, 0.65]] // wet teal
]

function sampleRamp(ramp: RampStop[], t: number): [number, number, number] {
  if (t <= ramp[0][0]) return ramp[0][1]
  if (t >= ramp[ramp.length - 1][0]) return ramp[ramp.length - 1][1]

  for (let i = 1; i < ramp.length; i++) {
    if (t <= ramp[i][0]) {
      const [t0, c0] = ramp[i - 1]
      const [t1, c1] = ramp[i]
      const f = (t - t0) / (t1 - t0)
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f]
    }
  }
  return ramp[ramp.length - 1][1]
}
