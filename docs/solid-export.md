# Weltenbauer Solid (CSG) — biome data & material spec

The carved 3D solid must give a consumer the **same texture-agnostic data and the
same freedom** as the [2.5D map set](./map-set.md): use our biomes, use their own
materials, re-classify from raw climate, or ignore biomes entirely. We dogfood the
data with our own TSL material; we never bake our textures into the export.

## The principle (same as 2.5D)

**Climate is the source of truth; biome is a derived convenience.** Biome =
`classify(height, temperature, humidity)` — a deterministic function (the Whittaker
rules in `BiomeSystem`). So we never need to transport the *discrete biome id*
through CSG (it can't be interpolated — it would smear across cut triangles). We
transport the **continuous climate inputs**, which interpolate cleanly, and the
biome is reconstructed wherever it's needed (our shader, or the consumer's).

## What the solid carries

The carved geometry carries **one packed per-vertex attribute** (continuous →
CSG-safe; exported by `GLTFExporter` as the custom glTF attribute `_SURFDATA`):

| `_SURFDATA` channel | Meaning |
|---|---|
| `.x` | temperature (°C) |
| `.y` | humidity (0..1) |
| `.z` | surfaceHeight (m) — the terrain height of this vertex's column |

Height of the point itself is its local `position.y`. **Depth below surface** is
therefore `_SURFDATA.z - position.y` (≈0 on the top surface, growing on cut cave
walls) — the interior/underground axis, handed over raw so a consumer applies
*their own* strata treatment. For new cut faces, the cutter's vertices sample the
climate of the surface directly above their world XZ, so `depth` distinguishes
"surface" from "deep" without baking any underground biome decision.

## The export (`island-carved.zip`)

The **📦 Commit → glTF + data** action produces a zip:

| File | What |
|---|---|
| `island-carved.glb` | the carved mesh; `POSITION`, `NORMAL`, `_SURFDATA` |
| `solid.json` | the contract: world info, classification params, the recipe, and the **biome legend** (identical rows to the 2.5D map-set `biomes` block) |

No baked colours or textures — `solid.json` + `_SURFDATA` are everything a consumer
needs to texture it however they like. (Our TSL material isn't a glTF material, so
nothing app-specific leaks into the file.)

## What the consumer does (identical to 2.5D)

1. Read `_SURFDATA` off the mesh; `depth = _SURFDATA.z - position.y`.
2. Either: run `classify(surfaceHeight, temperature, humidity)` with the params +
   legend in `solid.json` to get biome weights → apply their **own** PBR material
   per biome; **or** ignore biomes and shade straight from climate; **or** use
   `depth` to switch to their own subsurface materials on cave walls.

Delivery is the only thing that differs from 2.5D: the flat terrain samples maps by
UV; the solid carries the data as a **vertex attribute**, because a cave wall has no
(x,z) cell to sample. Same data, same legend, same freedom — different carrier.

## What we do in-app (the dogfood) — implemented

The solid renders with our TSL biome material (`TerrainMaterial`, constructed with
`{ classifyFromSurfData: true, doubleSide: true }`), **classifying from `_SURFDATA`
per-fragment** (crisp boundaries — classify the interpolated inputs, never
interpolate the classified output), blending the 4 surface textures by the result,
and shading cut faces toward rock/bedrock by `depth`. Same dogfooding stance as the
flat terrain, sourced from carried climate instead of a baked weight map. The
per-fragment classifier mirrors `BiomeSystem.classifySample` (verified to match the
canonical top-4 path; see `scripts/verify-classifier.ts`).

## Out of scope (deliberately)

- No discrete biome id baked onto the 3D mesh (reconstructed from climate instead).
- No per-mesh underground biome classification — `depth` is handed over raw.
- No baked vertex colour / textures in the `.glb` (consumer textures from the data).
