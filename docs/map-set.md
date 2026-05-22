# Weltenbauer 2.5D Map Set

The **Export Map Set (2.5D)** action produces a set of co-registered data maps — the
terrain's fields packaged like a PBR material's channels — plus a `manifest.json`
that describes how to use each one. Everything is the **same resolution** and
**row-major** (`y * resolution + x`), so you can sample height, climate, and biome
at the same UV.

## Files

| File | What | Use |
|---|---|---|
| `manifest.json` | The contract (see below) | Read first |
| `height.bin` / `height.png` | Terrain height, metres | float16 data / 8-bit preview |
| `temperature.bin` / `temperature.png` | °C | float16 / preview |
| `humidity.bin` / `humidity.png` | 0..1 | float16 / preview |
| `biome-index.png` / `biome-index.bin` | top-4 biome ids per texel (RGBA) | **nearest** sampled |
| `biome-weights.png` / `biome-weights.bin` | top-4 blend weights (RGBA) | linear sampled |

The `biome-index` / `biome-weights` channels line up: channel *k* of the weights is
the blend weight for the biome id in channel *k* of the index. Map each id to your
own PBR material and blend by the weights — the maps are **texture-agnostic**.

## manifest.json

```jsonc
{
  "format": "weltenbauer-mapset",
  "version": 1,
  "resolution": 1024,
  "layout": "row-major (y * resolution + x); PNG origin top-left",
  "world": { "sizeKm": 1, "seaLevel": 0 },
  "seed": 123456,
  "maps": [
    {
      "semantic": "height",
      "channels": 1,
      "dataType": "float16", "glType": "HalfFloatType", "format": "RedFormat",
      "colorSpace": "NoColorSpace", "filter": "linear",
      "files": { "data": "height.bin", "preview": "height.png" },
      "range": { "min": -25, "max": 25, "units": "m" }
    }
    // ... temperature, humidity, biomeIndex, biomeWeights
  ],
  "biomes": [ { "id": 0, "key": "ocean", "name": "Ocean", "color": "#1a3373",
                "surface": "rock", "temperature": null, "humidity": null,
                "rule": "elevation < sea level" } /* ... */ ]
}
```

Each map entry tells you the three things that make data textures behave in
three.js: **`glType` + `format`** (how to build the `DataTexture`), **`colorSpace`**
(always `NoColorSpace` — these are data, not color), and **`filter`** (`nearest` for
the biome index — ids must never be interpolated; `linear` for everything else).

## Consuming it in three.js / TSL (WebGPU)

```js
import * as THREE from 'three/webgpu';
import { texture, textureLoad, uv, ivec2, positionLocal, normalLocal,
         mix, smoothstep, Fn, float, vec3 } from 'three/tsl';

const manifest = await (await fetch('manifest.json')).json();
const res = manifest.resolution;

// --- Build a float16 single-channel DataTexture from a .bin -------------------
async function loadScalar(file) {
  const buf = await (await fetch(file)).arrayBuffer();
  const tex = new THREE.DataTexture(
    new Uint16Array(buf), res, res, THREE.RedFormat, THREE.HalfFloatType
  );
  tex.colorSpace = THREE.NoColorSpace;          // data, not sRGB
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

const heightTex = await loadScalar('height.bin');
const tempTex   = await loadScalar('temperature.bin');
const humidTex  = await loadScalar('humidity.bin');

// --- Biome index: RGBA uint8, NEAREST (never interpolate ids) -----------------
const idxBuf = await (await fetch('biome-index.bin')).arrayBuffer();
const biomeIndexTex = new THREE.DataTexture(
  new Uint8Array(idxBuf), res, res, THREE.RGBAFormat, THREE.UnsignedByteType
);
biomeIndexTex.colorSpace = THREE.NoColorSpace;
biomeIndexTex.minFilter = biomeIndexTex.magFilter = THREE.NearestFilter;
biomeIndexTex.needsUpdate = true;

// --- Wire into a node material ------------------------------------------------
const material = new THREE.MeshStandardNodeMaterial();

// Height drives vertex displacement (real metres come straight out of float16).
const height = texture(heightTex, uv()).r;
material.positionNode = positionLocal.add(normalLocal.mul(height));

// Dominant biome id under the fragment (nearest texel fetch, no interpolation).
const dominantId = textureLoad(biomeIndexTex, ivec2(uv().mul(res))).r;

// Or: derive your OWN biome from the raw climate maps, ignoring the baked one.
const classify = Fn(([temp, humid]) => {
  const tropical = smoothstep(float(20), float(24), temp);
  const wet = smoothstep(float(0.5), float(0.8), humid);
  return mix(vec3(0.6, 0.7, 0.35), vec3(0.1, 0.45, 0.15), tropical.mul(wet)); // grassland → rainforest
});
material.colorNode = classify(texture(tempTex, uv()).r, texture(humidTex, uv()).r);
```

### Notes
- **Precision/filtering:** continuous fields ship as **float16** because float16
  `DataTexture`s are linearly filterable on all WebGPU targets and can hold
  negatives (height below sea level). float32 is exact but only linearly filterable
  when the `float32Filterable` feature is enabled.
- **8-bit PNGs are previews** (normalized by each map's `range`). For real values,
  use the `.bin`; to de-normalize a preview, `value = min + png * (max - min)`.
- **Per-biome PBR sets** scale cleanly with a `DataArrayTexture` (one biome per
  layer), sampled with `texture(arrayTex, uv).depth(layerId)` and blended by the
  weight channels.
