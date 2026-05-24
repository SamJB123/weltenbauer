import './styles.css'
import { TerrainBuilder, EditorMode, CsgTool } from '../../core/TerrainBuilder'
import { BrushMode } from '../../core/BrushSystem'
import { CsgOp } from '../../core/CsgSystem'
import { ClimateView } from '../../core/ClimateSystem'
import { ProgressOverlay } from '../ProgressOverlay'
import { zipSync, Zippable } from 'fflate'
import { h, slider, select, toggle, button, fileButton, group, hint } from './components'

type StageId = 'terrain' | 'sea' | 'climate' | 'biomes' | 'carve' | 'export'

const STAGES: { id: StageId; icon: string; label: string; title: string; sub: string }[] = [
  { id: 'terrain', icon: '⛰', label: 'Terrain', title: 'Terrain', sub: 'Shape the land' },
  { id: 'sea', icon: '🌊', label: 'Sea', title: 'Sea & Island', sub: 'Sea level + island mask' },
  { id: 'climate', icon: '🌡', label: 'Climate', title: 'Climate', sub: 'Temperature + humidity' },
  { id: 'biomes', icon: '🌿', label: 'Biomes', title: 'Biomes', sub: 'Whittaker classification' },
  { id: 'carve', icon: '⛏', label: 'Carve', title: 'Carve (3D)', sub: 'Caves, tunnels, overhangs' },
  { id: 'export', icon: '📦', label: 'Export', title: 'Export', sub: 'Take your world out' }
]

const VIEW_MODES: { label: string; value: ClimateView }[] = [
  { label: 'Normal', value: 'normal' },
  { label: 'Biome', value: 'biome' },
  { label: 'Temp', value: 'temperature' },
  { label: 'Humidity', value: 'humidity' },
  { label: 'Colors', value: 'biomeColor' }
]

/**
 * The Weltbuilder control surface: a full-bleed viewport with overlay panels —
 * a stage rail (Terrain → Sea → Climate → Biomes → Carve → Export), a contextual
 * inspector for the active stage, a persistent view-mode bar + cursor readout, and
 * modal carve tools whose selected cutter carries its own gizmo controls.
 */
export class WeltUI {
  private tb: TerrainBuilder
  private canvas: HTMLCanvasElement
  private progressOverlay: ProgressOverlay

  private root!: HTMLElement
  private bodyEl!: HTMLElement       // active stage's inspector body
  private titleEl!: HTMLElement
  private subEl!: HTMLElement
  private railButtons = new Map<StageId, HTMLElement>()
  private viewButtons = new Map<ClimateView, HTMLElement>()
  private modeButtons = new Map<EditorMode, HTMLElement>()
  private cursorVals!: { elevation: HTMLElement; temperature: HTMLElement; humidity: HTMLElement; biome: HTMLElement }
  private cutterListEl: HTMLElement | null = null

  private stage: StageId = 'terrain'
  private gizmoMode: 'translate' | 'rotate' | 'scale' = 'translate'

  // Pointer state (carve strokes vs orbit/brush)
  private isPointerDown = false
  private csgDownX = 0
  private csgDownY = 0
  private csgConsumed = false
  private pendingCursorEvent: MouseEvent | null = null
  private cursorRafScheduled = false
  private tileRefreshScheduled = false

  constructor(terrainBuilder: TerrainBuilder) {
    this.tb = terrainBuilder
    this.canvas = document.getElementById('canvas') as HTMLCanvasElement
    this.progressOverlay = new ProgressOverlay()
    this.buildShell()
    this.setupCanvasEvents()
    this.setStage('terrain')
  }

  // --- Engine → UI contract ------------------------------------------------
  public getProgressOverlay(): ProgressOverlay { return this.progressOverlay }
  public rebuildCsgOpsGui(): void { if (this.stage === 'carve') this.renderCutterList() }
  public updateNoiseLayersGUI(): void { if (this.stage === 'terrain') this.renderStage() }

  // --- Shell ---------------------------------------------------------------
  private buildShell(): void {
    this.root = h('div', { class: 'w-root' })

    // Persistent top view-mode bar.
    const topbar = h('div', { class: 'w-topbar' })
    const activeView = this.tb.getConfig().climate.viewMode as ClimateView
    for (const vm of VIEW_MODES) {
      const b = h('button', { class: 'w-seg', text: vm.label })
      if (vm.value === activeView) b.classList.add('w-active')
      b.addEventListener('click', () => this.setView(vm.value))
      this.viewButtons.set(vm.value, b)
      topbar.append(b)
    }

    // Stage rail.
    const rail = h('div', { class: 'w-rail' })
    for (const s of STAGES) {
      const b = h('button', { class: 'w-stage' }, [
        h('span', { class: 'w-stage-ico', text: s.icon }),
        h('span', { class: 'w-stage-lbl', text: s.label })
      ])
      b.addEventListener('click', () => this.setStage(s.id))
      this.railButtons.set(s.id, b)
      rail.append(b)
    }

    // Inspector.
    this.titleEl = h('div', { class: 'w-inspector-title' })
    this.subEl = h('div', { class: 'w-inspector-sub' })
    this.bodyEl = h('div', { class: 'w-inspector-body' })
    const inspector = h('div', { class: 'w-inspector' }, [
      h('div', { class: 'w-inspector-head' }, [this.titleEl, this.subEl]),
      this.bodyEl
    ])

    const left = h('div', { class: 'w-left' }, [rail, inspector])

    // Cursor readout.
    const mkRow = (label: string) => {
      const v = h('span', { class: 'v', text: '—' })
      return { row: h('div', { class: 'w-cursor-row' }, [h('span', { class: 'k', text: label }), v]), v }
    }
    const elevation = mkRow('Elevation'), temperature = mkRow('Temperature')
    const humidity = mkRow('Humidity'), biome = mkRow('Biome')
    this.cursorVals = { elevation: elevation.v, temperature: temperature.v, humidity: humidity.v, biome: biome.v }
    const cursor = h('div', { class: 'w-cursor' }, [
      h('div', { class: 'w-cursor-title', text: 'At cursor' }),
      elevation.row, temperature.row, humidity.row, biome.row
    ])

    // Orbit/Brush mode toggle.
    const modebar = h('div', { class: 'w-modebar' })
    for (const m of ['orbit', 'brush'] as EditorMode[]) {
      const b = h('button', { class: 'w-seg', text: m === 'orbit' ? '🔄 Orbit' : '🖌 Sculpt' })
      if (this.tb.getMode() === m) b.classList.add('w-active')
      b.addEventListener('click', () => this.setEditorMode(m))
      this.modeButtons.set(m, b)
      modebar.append(b)
    }

    this.root.append(topbar, left, cursor, modebar)
    document.body.append(this.root)
  }

  private setView(mode: ClimateView): void {
    this.tb.setClimateViewMode(mode)
    this.viewButtons.forEach((b, v) => b.classList.toggle('w-active', v === mode))
  }

  private setEditorMode(mode: EditorMode): void {
    this.tb.setMode(mode)
    this.modeButtons.forEach((b, m) => b.classList.toggle('w-active', m === mode))
  }

  private setStage(id: StageId): void {
    this.stage = id
    this.railButtons.forEach((b, s) => b.classList.toggle('w-active', s === id))
    const meta = STAGES.find(s => s.id === id)!
    this.titleEl.textContent = meta.title
    this.subEl.textContent = meta.sub
    this.renderStage()
  }

  private renderStage(): void {
    this.bodyEl.replaceChildren()
    this.cutterListEl = null
    switch (this.stage) {
      case 'terrain': return this.renderTerrain()
      case 'sea': return this.renderSea()
      case 'climate': return this.renderClimate()
      case 'biomes': return this.renderBiomes()
      case 'carve': return this.renderCarve()
      case 'export': return this.renderExport()
    }
  }

  private add(...els: HTMLElement[]): void { for (const e of els) this.bodyEl.append(e) }

  // --- Stage: Terrain ------------------------------------------------------
  private renderTerrain(): void {
    const c = this.tb.getConfig()

    // Island size sits up top — it frames everything below (tiles, generation).
    this.add(slider({ label: 'Size', min: 0.1, max: 20, step: 0.1, value: c.size, unit: 'km', onChange: v => this.tb.updateConfig({ size: v }) }))

    // Representation: smooth mesh vs the coarse low-poly square grid or hex tiles.
    const style = this.tb.getTerrainStyle()
    this.add(select<'smooth' | 'grid' | 'hex'>({
      label: 'Representation', value: style,
      options: [
        { label: 'Smooth', value: 'smooth' },
        { label: 'Square grid', value: 'grid' },
        { label: 'Hex tiles', value: 'hex' }
      ],
      onChange: v => { this.tb.setTerrainStyle(v); this.renderStage() }
    }))
    if (style !== 'smooth') {
      const isHex = style === 'hex'
      const sizeMode = this.tb.getGridSizeMode()
      this.add(select<'count' | 'diameter'>({
        label: 'Tile sizing', value: sizeMode,
        options: [{ label: 'By count', value: 'count' }, { label: 'By size', value: 'diameter' }],
        onChange: v => { this.tb.setGridSizeMode(v); this.renderStage() }
      }))
      if (sizeMode === 'count') {
        this.add(slider({ label: 'Tiles across', min: 4, max: 400, step: 1, value: this.tb.getGridCells(), onChange: v => this.tb.setGridCells(v) }))
      } else {
        // 'By size': show what the target actually resolves to, flagging the tile cap.
        const note = hint('')
        const updateNote = () => {
          const info = this.tb.getTileSizingInfo()
          note.textContent = info.capped
            ? `⚠ Capped at 400 tiles — actual tile size ≈ ${Math.round(info.effectiveDiameter)} m (bigger than requested on an island this large).`
            : `→ ${info.cells} tiles across.`
        }
        this.add(slider({
          label: 'Tile size', min: 5, max: 500, step: 1, unit: 'm', value: this.tb.getGridTileDiameter(),
          onChange: v => { this.tb.setGridTileDiameter(v); updateNote() }
        }), note)
        updateNote()
      }
      this.add(
        slider({ label: 'Height step', min: 0, max: 50, step: 1, value: this.tb.getGridStep(), unit: 'm', onChange: v => this.tb.setGridStep(v) }),
        hint((isHex
          ? 'Hex tiles: each is a centre fanned to 6 corners; shared corners sample the same height, so joins are seamless. '
          : 'Square grid: each cell’s tilt comes from its 4 shared corner heights. ')
          + 'By size fixes the tile diameter (metres) so different islands share the same tile size. Height step = 0 is continuous; raise it for terraced steps.')
      )
    }

    this.add(
      button({ label: '🎲 Randomize seed', kind: 'primary', full: true, onClick: () => { this.tb.randomizeSeed(); this.renderStage() } }),
      fileButton({ label: '📁 Import heightmap (PNG)', accept: 'image/*', onFile: f => this.importHeightmap(f) }),
      fileButton({ label: '📂 Import island project', accept: 'application/json,.json', onFile: f => this.importIsland(f) }),
      button({ label: '🔄 Reset to procedural', kind: 'ghost', full: true, onClick: () => this.resetToNormal() })
    )

    // Sculpt brush — a modal tool (switch to Sculpt mode to use it).
    const sculpt = group('Sculpt brush', { open: true })
    const bs = this.tb.getBrushSystem().getBrushSettings()
    const brush = this.tb.getBrushSystem()
    const modeLabels: Record<BrushMode, string> = {
      raise: 'Raise', lower: 'Lower', smooth: 'Smooth', flatten: 'Flatten', level: 'Level (target)', mountain: 'Mountain'
    }
    sculpt.body.append(
      hint('Switch to 🖌 Sculpt (bottom bar) then drag on the terrain.'),
      select<BrushMode>({
        label: 'Brush', value: bs.mode,
        options: (['raise', 'lower', 'smooth', 'flatten', 'level', 'mountain'] as BrushMode[]).map(m => ({ label: modeLabels[m], value: m })),
        onChange: v => { brush.setBrushSettings({ mode: v }); this.renderStage() } // re-render to show/hide the target slider
      })
    )
    // 'Level' eases the terrain toward an absolute target elevation (shown relative
    // to sea level, like the cursor readout). Convert to/from heightfield units.
    if (bs.mode === 'level') {
      const seaLevel = this.tb.getConfig().island.seaLevel
      sculpt.body.append(slider({
        label: 'Target elevation', min: -200, max: 400, step: 1, unit: 'm',
        value: (bs.targetHeight ?? 0) - seaLevel,
        onChange: v => brush.setBrushSettings({ targetHeight: v + seaLevel })
      }))
    }
    sculpt.body.append(
      slider({ label: 'Size', min: 1, max: 500, step: 1, value: bs.size, unit: 'm', onChange: v => brush.setBrushSettings({ size: v }) }),
      slider({ label: 'Strength', min: 0.1, max: 2, step: 0.1, value: bs.strength, onChange: v => brush.setBrushSettings({ strength: v }) })
    )

    const presets = group('Presets', {})
    presets.body.append(
      button({ label: '🏔 Alaskan / Everest', full: true, onClick: () => this.applyMountainPreset('alaskan') }),
      button({ label: '🏜 Nevada / New Mexico', full: true, onClick: () => this.applyMountainPreset('desert') }),
      button({ label: '🌧 Gentle erosion', full: true, onClick: () => { this.tb.applyGentleErosion(); this.tb.refreshTileMesh() } }),
      button({ label: '🏞 Create river', full: true, onClick: () => this.createRiver() })
    )

    const adv = group('Generation parameters', {})
    adv.body.append(
      select<number>({
        label: 'Resolution', value: c.resolution,
        options: [64, 128, 256, 512, 1024, 2048, 4096].map(r => ({ label: `${r}×${r}`, value: r })),
        onChange: v => this.tb.setResolution(v)
      }),
      slider({ label: 'Geological complexity', min: 0, max: 2, step: 0.1, value: c.geologicalComplexity, onChange: v => this.tb.updateConfig({ geologicalComplexity: v }) }),
      slider({ label: 'Domain warping', min: 0, max: 1, step: 0.05, value: c.domainWarping, onChange: v => this.tb.updateConfig({ domainWarping: v }) }),
      slider({ label: 'Relief amplitude', min: 0.2, max: 4, step: 0.1, value: c.reliefAmplitude, onChange: v => this.tb.updateConfig({ reliefAmplitude: v }) }),
      slider({ label: 'Feature scale', min: 0.1, max: 3, step: 0.1, value: c.featureScale, onChange: v => this.tb.updateConfig({ featureScale: v }) }),
      slider({ label: 'Seed', min: 0, max: 999999, step: 1, value: c.seed, onChange: v => this.tb.updateConfig({ seed: v }) }),
      toggle({ label: 'Show grid', value: this.tb.isGridVisible(), onChange: v => this.tb.toggleGrid(v) })
    )

    const noise = group('Noise layers', {})
    this.renderNoiseLayers(noise.body)

    this.add(sculpt.root, presets.root, adv.root, noise.root)
  }

  private renderNoiseLayers(container: HTMLElement): void {
    const { layers, baseLayers } = this.tb.getNoiseLayersData()
    layers.forEach((layer: any, i: number) => {
      const custom = i >= baseLayers.length
      const card = h('div', { class: 'w-cutter' })
      card.append(h('div', { class: 'w-cutter-head' }, [
        h('span', { class: 'w-cutter-name', text: `${i + 1}. ${String(layer.type).toUpperCase()}${custom ? ' (custom)' : ''}` })
      ]))
      card.append(slider({
        label: 'Weight', min: 0, max: 100, step: 1, value: Math.round(layer.weight * 100), unit: '%', live: true,
        onChange: v => this.tb.updateLayerWeight(i, v / 100, false)
      }))
      const preview = h('canvas', { width: 120, height: 120, style: { width: '100%', height: '90px', borderRadius: '6px', border: '1px solid #333', background: '#222' } } as any)
      this.tb.generateLayerPreview(preview, layer)
      card.append(preview)
      if (custom) card.append(button({ label: '🗑 Remove layer', kind: 'danger', full: true, onClick: () => { this.tb.removeLayer(i); this.updateNoiseLayersGUI() } }))
      container.append(card)
    })
    container.append(button({ label: '➕ Add layer', full: true, onClick: () => this.tb.showAddLayerDialog() }))
  }

  // --- Stage: Sea ----------------------------------------------------------
  private renderSea(): void {
    const isl = this.tb.getConfig().island
    // Merge each change against the live island config so values never go stale.
    const set = (patch: Record<string, unknown>) => this.tb.updateConfig({ island: { ...this.tb.getConfig().island, ...patch } })
    this.add(
      toggle({ label: '🏝 Islandize (edges below sea)', value: isl.enabled, onChange: v => set({ enabled: v }) }),
      slider({ label: 'Sea level', min: -200, max: 200, step: 1, value: isl.seaLevel, onChange: v => set({ seaLevel: v }) }),
      slider({ label: 'Ocean depth', min: 0, max: 500, step: 5, value: isl.oceanDepth, unit: 'm', onChange: v => set({ oceanDepth: v }) }),
      slider({ label: 'Land elevation (peak)', min: 0, max: 400, step: 1, value: isl.landBias, unit: 'm', onChange: v => set({ landBias: v }) }),
      toggle({ label: 'Show water', value: isl.showWater, onChange: v => set({ showWater: v }) })
    )
    const adv = group('Coastline shape', {})
    adv.body.append(
      slider({ label: 'Coast start', min: 0, max: 1, step: 0.01, value: isl.falloffStart, onChange: v => set({ falloffStart: v }) }),
      slider({ label: 'Coast end', min: 0, max: 1, step: 0.01, value: isl.falloffEnd, onChange: v => set({ falloffEnd: v }) }),
      slider({ label: 'Shape (round→square)', min: 0, max: 1, step: 0.05, value: isl.shape, onChange: v => set({ shape: v }) }),
      slider({ label: 'Coast distortion', min: 0, max: 0.5, step: 0.01, value: isl.coastDistortion, onChange: v => set({ coastDistortion: v }) })
    )
    this.add(adv.root)
  }

  // --- Stage: Climate ------------------------------------------------------
  private renderClimate(): void {
    const cl = this.tb.getConfig().climate
    const set = (partial: any) => this.tb.setClimateConfig(partial)
    this.add(
      hint('Pick a view up top (Temp / Humidity / Biome) to see these take effect.'),
      slider({ label: 'Base temperature', min: -20, max: 40, step: 1, value: cl.baseTemperature, unit: '°C', onChange: v => set({ baseTemperature: v }) }),
      slider({ label: 'Base humidity', min: 0, max: 1, step: 0.05, value: cl.humidityBase, onChange: v => set({ humidityBase: v }) }),
      slider({ label: 'Latitude range', min: 0, max: 40, step: 1, value: cl.latitudeRange, unit: '°C', onChange: v => set({ latitudeRange: v }) }),
      slider({ label: 'Lapse rate', min: 0, max: 30, step: 0.5, value: cl.lapseRate, unit: '°C/km', onChange: v => set({ lapseRate: v }) })
    )
    const adv = group('Fine-tune', {})
    adv.body.append(
      slider({ label: 'Temp variation', min: 0, max: 10, step: 0.5, value: cl.temperatureNoise, unit: '°C', onChange: v => set({ temperatureNoise: v }) }),
      slider({ label: 'Coastal moisture', min: 0, max: 1, step: 0.05, value: cl.coastalMoisture, onChange: v => set({ coastalMoisture: v }) }),
      slider({ label: 'Coastal reach', min: 0.02, max: 1, step: 0.02, value: cl.coastalFalloff, onChange: v => set({ coastalFalloff: v }) }),
      slider({ label: 'Elevation drying', min: 0, max: 1, step: 0.05, value: cl.elevationDrying, onChange: v => set({ elevationDrying: v }) }),
      slider({ label: 'Rain shadow', min: 0, max: 1, step: 0.05, value: cl.rainShadowStrength, onChange: v => set({ rainShadowStrength: v }) }),
      slider({ label: 'Wind direction', min: 0, max: 360, step: 5, value: cl.windDirection, unit: '°', onChange: v => set({ windDirection: v }) }),
      slider({ label: 'Humidity variation', min: 0, max: 0.5, step: 0.02, value: cl.humidityNoise, onChange: v => set({ humidityNoise: v }) })
    )
    this.add(adv.root)
  }

  // --- Stage: Biomes -------------------------------------------------------
  private renderBiomes(): void {
    const b = this.tb.getConfig().biome
    const set = (partial: any) => this.tb.setBiomeConfig(partial)
    this.add(
      hint('Biomes come from height + temperature + humidity. Use the Biome / Biome-colors view up top to see them.'),
      slider({ label: 'Beach height', min: 0, max: 60, step: 1, value: b.beachHeight, unit: 'm', onChange: v => set({ beachHeight: v }) }),
      slider({ label: 'Blend width', min: 0.5, max: 8, step: 0.5, value: b.blendMargin, unit: '°C', onChange: v => set({ blendMargin: v }) })
    )
  }

  // --- Stage: Carve --------------------------------------------------------
  private renderCarve(): void {
    const active = this.tb.isCsgActive()
    if (!active) {
      const solidOpts = group('Solid options', {})
      solidOpts.body.append(
        slider({ label: 'Underground depth', min: 0, max: 300, step: 5, value: 60, unit: 'm', onChange: v => this.tb.setCsgUndergroundDepth(v) })
      )
      this.add(
        hint('Carving works on a solid 3D version of your island — caves, tunnels and overhangs a heightfield can\'t represent.'),
        button({ label: '⛏ Solidify & start carving', kind: 'primary', full: true, onClick: () => { this.tb.enterCsgMode(); this.renderStage() } }),
        solidOpts.root
      )
      return
    }

    this.add(button({ label: '✓ Exit CSG (back to terrain)', kind: 'ghost', full: true, onClick: () => { this.tb.exitCsgMode(); this.renderStage() } }))

    // Tool picker.
    const tool = this.tb.getCsgTool()
    const toolRow = h('div', { class: 'w-gizmo-modes' })
    const tools: { id: CsgTool; label: string }[] = [
      { id: 'none', label: 'Orbit' }, { id: 'dig', label: 'Dig' }, { id: 'chamber', label: 'Chamber' }, { id: 'tunnel', label: 'Tunnel' }
    ]
    for (const t of tools) {
      const b = button({ label: t.label, onClick: () => { this.tb.setCsgTool(t.id); this.renderStage() } })
      if (t.id === tool) b.classList.add('w-active')
      toolRow.append(b)
    }
    this.add(h('div', { class: 'w-field-label', text: 'Tool', style: { marginTop: '6px' } }), toolRow)

    this.add(
      select<CsgOp>({ label: 'Mode', value: 'subtract', options: [{ label: 'Subtract (dig)', value: 'subtract' }, { label: 'Add (build out)', value: 'add' }], onChange: v => this.tb.setCsgToolOperation(v) }),
      slider({ label: 'Carve size', min: 5, max: 200, step: 1, value: 40, onChange: v => this.tb.setCsgBrushSize(v) }),
      hint('Click the surface to carve into the face you point at. While editing a cutter: W/E/R = move/rotate/scale, Esc = stop. Rotation only shows on box/cylinder.')
    )

    const addRow = h('div', { class: 'w-gizmo-modes' })
    addRow.append(
      button({ label: '+ Sphere', onClick: () => this.addCsgCutter('sphere') }),
      button({ label: '+ Box', onClick: () => this.addCsgCutter('box') }),
      button({ label: '+ Cylinder', onClick: () => this.addCsgCutter('cylinder') })
    )
    this.add(addRow)

    this.cutterListEl = h('div', {})
    this.add(this.cutterListEl)
    this.renderCutterList()

    this.add(button({ label: '🗑 Clear all cutters', kind: 'danger', full: true, onClick: () => { this.tb.clearCsgOperations(); this.renderCutterList() } }))
  }

  private renderCutterList(): void {
    if (!this.cutterListEl) return
    this.cutterListEl.replaceChildren()
    const ops = this.tb.getCsgOperations()
    if (ops.length === 0) { this.cutterListEl.append(hint('No cutters yet — pick a tool and click the surface, or add one above.')); return }

    const bounds = this.tb.getCsgBounds()
    const posRange = bounds.size / 2
    const scaleMax = Math.max(10, bounds.size)
    const selected = this.tb.getCsgSelectedOpId()

    for (const op of ops) {
      const isStroke = op.shape === 'stroke'
      const editing = selected === op.id
      const card = h('div', { class: `w-cutter${editing ? ' w-editing' : ''}` })
      card.append(h('div', { class: 'w-cutter-head' }, [
        h('span', { class: 'w-cutter-name', text: isStroke ? `#${op.id} stroke (${op.points?.length ?? 0})` : `#${op.id} ${op.shape}` }),
        button({ label: '🗑', kind: 'danger', onClick: () => { this.tb.removeCsgOperation(op.id); this.renderCutterList() } })
      ]))
      card.append(
        select<CsgOp>({ label: 'Op', value: op.operation, options: [{ label: 'Subtract', value: 'subtract' }, { label: 'Add', value: 'add' }, { label: 'Intersect', value: 'intersect' }], onChange: v => this.tb.updateCsgOperation(op.id, { operation: v }) }),
        toggle({ label: 'Enabled', value: op.enabled, onChange: v => this.tb.updateCsgOperation(op.id, { enabled: v }) })
      )

      if (!isStroke) {
        card.append(button({
          label: editing ? '🛑 Stop editing' : '🎯 Edit (gizmo)', kind: editing ? 'primary' : 'ghost', full: true,
          onClick: () => { editing ? this.tb.deselectCsgGizmo() : this.selectForGizmo(op.id); this.renderCutterList() }
        }))
        if (editing) {
          const modes = h('div', { class: 'w-gizmo-modes' })
          ;(['translate', 'rotate', 'scale'] as const).forEach(m => {
            const b = button({ label: m === 'translate' ? 'Move' : m === 'rotate' ? 'Rotate' : 'Scale', onClick: () => { this.gizmoMode = m; this.tb.setGizmoMode(m); this.renderCutterList() } })
            if (this.gizmoMode === m) b.classList.add('w-active')
            modes.append(b)
          })
          card.append(modes)
          card.append(
            slider({ label: 'Pos X', min: -posRange, max: posRange, step: 1, value: op.position[0], onChange: v => this.tb.updateCsgOperation(op.id, { position: [v, op.position[1], op.position[2]] }) }),
            slider({ label: 'Pos Y', min: bounds.minHeight - 100, max: bounds.maxHeight + 100, step: 1, value: op.position[1], onChange: v => this.tb.updateCsgOperation(op.id, { position: [op.position[0], v, op.position[2]] }) }),
            slider({ label: 'Pos Z', min: -posRange, max: posRange, step: 1, value: op.position[2], onChange: v => this.tb.updateCsgOperation(op.id, { position: [op.position[0], op.position[1], v] }) }),
            slider({ label: 'Yaw', min: 0, max: 360, step: 1, value: (op.rotation[1] * 180) / Math.PI, unit: '°', onChange: v => this.tb.updateCsgOperation(op.id, { rotation: [0, (v * Math.PI) / 180, 0] }) }),
            slider({ label: 'Scale X', min: 1, max: scaleMax, step: 1, value: op.scale[0], onChange: v => this.tb.updateCsgOperation(op.id, { scale: [v, op.scale[1], op.scale[2]] }) }),
            slider({ label: 'Scale Y', min: 1, max: scaleMax, step: 1, value: op.scale[1], onChange: v => this.tb.updateCsgOperation(op.id, { scale: [op.scale[0], v, op.scale[2]] }) }),
            slider({ label: 'Scale Z', min: 1, max: scaleMax, step: 1, value: op.scale[2], onChange: v => this.tb.updateCsgOperation(op.id, { scale: [op.scale[0], op.scale[1], v] }) })
          )
        }
      }
      this.cutterListEl.append(card)
    }
  }

  private selectForGizmo(id: number): void {
    this.gizmoMode = 'translate'
    this.tb.selectCsgOperation(id)
  }

  private addCsgCutter(shape: 'sphere' | 'box' | 'cylinder'): void {
    try { this.tb.addCsgOperation(shape); this.renderCutterList() }
    catch (e) { console.error('Add cutter failed:', e); alert('Add cutter failed — see console.') }
  }

  // --- Stage: Export -------------------------------------------------------
  private renderExport(): void {
    this.add(
      hint('Texture-agnostic data for any engine — sample the maps, classify biomes, bring your own materials.'),
      button({ label: '🗺 Map set (2.5D) — .zip', kind: 'primary', full: true, onClick: () => this.exportMapSet() }),
      hint('height + temperature + humidity + biome maps + manifest + re-importable project.'),
      button({ label: '💾 Island project (lossless) — .json', full: true, onClick: () => this.exportIsland() }),
      hint('Exact heightfield + config; re-import to keep editing.'),
      button({ label: '📦 Carved solid — .zip (glTF + data)', full: true, onClick: () => this.exportCarvedMeshGLB() }),
      hint('The 3D carved mesh with _SURFDATA + the biome contract. Carve something first.'),
      button({ label: '🧩 Tile solid — .zip (glTF + data)', full: true, onClick: () => this.exportTileSolid() }),
      hint('The low-poly square/hex tiles as a closed, flat-bottomed solid (tiny files). Switch the Terrain representation to a tile mode first.'),
      button({ label: '🌿 Biome data — files', full: true, onClick: () => this.exportBiomes() }),
      button({ label: 'Heightmap PNG (legacy)', kind: 'ghost', full: true, onClick: () => this.exportHeightmap() })
    )

    const sdf = group('SDF volume (distance field)', {})
    let sdfRes = 128
    sdf.body.append(
      hint('Signed-distance volume for cheap distance shadows / AO / collision in a consumer scene.'),
      select<number>({ label: 'Resolution', value: 128, options: [64, 128, 256].map(r => ({ label: `${r}³`, value: r })), onChange: v => { sdfRes = v } }),
      button({ label: '🧊 Export SDF — .zip', full: true, onClick: () => this.exportSdf(sdfRes) })
    )
    this.add(sdf.root)
  }

  // --- Ported actions ------------------------------------------------------
  private applyMountainPreset(preset: 'alaskan' | 'desert'): void {
    this.tb.getBrushSystem().applyMountainPreset(preset)
    if (this.stage === 'terrain') this.renderStage()
  }

  private createRiver(): void {
    const size = this.tb.getConfig().size * 1000
    this.tb.createRiver(-size * 0.3, size * 0.2, size * 0.3, -size * 0.2)
    this.tb.refreshTileMesh()
  }

  private importHeightmap(file: File): void {
    const img = new Image()
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!
    img.onload = async () => {
      const res = Math.min(Math.max(img.width, img.height), 4096)
      canvas.width = res; canvas.height = res
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, res, res)
      const scale = Math.min(res / img.width, res / img.height)
      const w = img.width * scale, hgt = img.height * scale
      ctx.drawImage(img, (res - w) / 2, (res - hgt) / 2, w, hgt)
      const data = ctx.getImageData(0, 0, res, res).data
      const heightData = new Float32Array(res * res)
      for (let i = 0; i < heightData.length; i++) {
        const p = i * 4
        heightData[i] = (data[p] + data[p + 1] + data[p + 2]) / 3
      }
      try {
        await this.tb.importHeightmap(heightData, res, file.name)
        this.renderStage()
        console.log('✅ Heightmap imported:', file.name)
      } catch (e) { console.error('❌ Import failed:', e); alert('Failed to import heightmap. See console.') }
    }
    img.src = URL.createObjectURL(file)
  }

  private async importIsland(file: File): Promise<void> {
    try {
      await this.tb.loadIslandProject(await file.text())
      this.renderStage()
      this.viewButtons.forEach((b, v) => b.classList.toggle('w-active', v === this.tb.getConfig().climate.viewMode))
      console.log('✅ Island imported:', file.name)
    } catch (e) { console.error('❌ Failed to import island:', e); alert('Failed to import island — is this a weltenbauer island file? See console.') }
  }

  private resetToNormal(): void {
    if (confirm('Reset to procedural terrain? This removes the imported heightmap and restores default noise layers.')) {
      this.tb.resetToNormalTerrain()
      this.renderStage()
    }
  }

  private exportMapSet(): void {
    try {
      const result = this.tb.getMapSetExport()
      if (!result) { alert('Generate terrain before exporting the map set.'); return }
      const entries: Zippable = { 'manifest.json': new TextEncoder().encode(result.manifestJson) }
      for (const f of result.files) {
        const bytes = f.dataUrl ? dataUrlToBytes(f.dataUrl) : new Uint8Array(f.bytes!)
        entries[f.name] = f.name.endsWith('.png') ? [bytes, { level: 0 }] : bytes
      }
      const island = this.tb.exportIslandProject()
      if (island) entries['island.weltenbauer.json'] = new TextEncoder().encode(island)
      this.downloadBlob(zipSync(entries), 'weltenbauer-mapset.zip', 'application/zip')
    } catch (e) { console.error('Map set export failed:', e); alert('Failed to export map set. See console.') }
  }

  private exportIsland(): void {
    try {
      const json = this.tb.exportIslandProject()
      if (!json) { alert('Generate terrain before exporting the island.'); return }
      this.download(new Blob([json], { type: 'application/json' }), 'island.weltenbauer.json')
    } catch (e) { console.error('Island export failed:', e); alert('Failed to export island. See console.') }
  }

  private async exportCarvedMeshGLB(): Promise<void> {
    try {
      const result = await this.tb.exportCarvedSolid()
      if (!result) { alert('Enter Carve mode and carve something before committing to glTF.'); return }
      this.downloadBlob(zipSync({
        'island-carved.glb': new Uint8Array(result.glb),
        'solid.json': new TextEncoder().encode(result.manifestJson)
      }), 'island-carved.zip', 'application/zip')
    } catch (e) { console.error('Carved export failed:', e); alert('Failed to export carved mesh. See console.') }
  }

  private async exportTileSolid(): Promise<void> {
    try {
      const result = await this.tb.exportTileSolid()
      if (!result) {
        alert('Switch the Terrain representation to Square grid or Hex tiles first.')
        return
      }
      this.downloadBlob(zipSync({
        'island-tiles.glb': new Uint8Array(result.glb),
        'solid.json': new TextEncoder().encode(result.manifestJson)
      }), 'island-tiles.zip', 'application/zip')
    } catch (e) { console.error('Tile solid export failed:', e); alert('Failed to export tile solid. See console.') }
  }

  private async exportSdf(res: number): Promise<void> {
    const po = this.progressOverlay
    try {
      po.startTask('sdf-bake', 'Baking SDF volume', 'Sampling distances…')
      const result = await this.tb.exportSdfVolume(res, f => po.updateTask('sdf-bake', Math.round(f * 100), `Sampling… ${Math.round(f * 100)}%`))
      po.completeTask('sdf-bake')
      if (!result) { alert('Enter Carve mode and carve something before exporting an SDF.'); return }
      this.downloadBlob(zipSync({ 'sdf.json': new TextEncoder().encode(result.json), 'sdf.bin': new Uint8Array(result.bin) }), 'island-sdf.zip', 'application/zip')
    } catch (e) { po.completeTask('sdf-bake'); console.error('SDF export failed:', e); alert('Failed to export SDF. See console.') }
  }

  private exportBiomes(): void {
    try {
      const data = this.tb.getBiomeExport()
      if (!data) { alert('Generate terrain before exporting biome data.'); return }
      this.download(new Blob([data.legendJson], { type: 'application/json' }), 'biomes-legend.json')
      this.download(data.indicesPng, 'biome-indices.png')
      this.download(data.weightsPng, 'biome-weights.png')
      this.download(new Blob([data.indicesBin], { type: 'application/octet-stream' }), 'biome-indices.bin')
      this.download(new Blob([data.weightsBin.buffer], { type: 'application/octet-stream' }), 'biome-weights.bin')
    } catch (e) { console.error('Biome export failed:', e); alert('Failed to export biome data. See console.') }
  }

  private exportHeightmap(): void {
    try { this.download(this.tb.exportHeightmap(), 'heightmap.png') }
    catch (e) { console.error('Heightmap export failed:', e); alert('Failed to export heightmap. See console.') }
  }

  // --- Download helpers ----------------------------------------------------
  private download(src: string | Blob, filename: string): void {
    const url = typeof src === 'string' ? src : URL.createObjectURL(src)
    const a = h('a', { href: url, download: filename } as any)
    document.body.append(a); a.click(); a.remove()
    if (typeof src !== 'string') URL.revokeObjectURL(url)
  }
  private downloadBlob(bytes: Uint8Array, filename: string, type: string): void {
    this.download(new Blob([bytes.buffer as ArrayBuffer], { type }), filename)
  }

  // --- Cursor readout + canvas events (ported) -----------------------------
  private setupCanvasEvents(): void {
    this.canvas.addEventListener('mousedown', (e) => {
      this.isPointerDown = true; this.csgDownX = e.clientX; this.csgDownY = e.clientY
      if (this.tb.getCsgTool() !== 'none') {
        if (e.button === 0) { const n = this.ndc(e); this.csgConsumed = this.tb.csgPointerDown(n.x, n.y) }
        return
      }
      this.tb.getBrushSystem().handleMouseDown(e, this.tb.getCamera(), this.canvas)
    })
    this.canvas.addEventListener('mousemove', (e) => {
      if (this.tb.getCsgTool() !== 'none') { const n = this.ndc(e); this.tb.csgPointerMove(n.x, n.y); return }
      this.tb.getBrushSystem().handleMouseMove(e, this.tb.getCamera(), this.canvas)
      this.scheduleCursorUpdate(e)
      if (this.isPointerDown) this.scheduleTileRefresh() // live tile update while sculpting
    })
    this.canvas.addEventListener('mouseup', (e) => {
      this.isPointerDown = false
      if (this.tb.getCsgTool() !== 'none') {
        if (e.button === 0) {
          if (this.csgConsumed) this.tb.csgPointerUp()
          else if (Math.hypot(e.clientX - this.csgDownX, e.clientY - this.csgDownY) < 5) { const n = this.ndc(e); this.tb.csgPointerCarve(n.x, n.y) }
          this.csgConsumed = false
        }
        return
      }
      this.tb.getBrushSystem().handleMouseUp()
      this.scheduleCursorUpdate(e)
      this.tb.refreshTileMesh(false) // stroke end: full refresh (re-derives climate → correct colours)
    })
    window.addEventListener('mouseup', () => { this.isPointerDown = false })
  }

  /** Live tile rebuild during a sculpt stroke, throttled to one per animation frame. */
  private scheduleTileRefresh(): void {
    if (this.tileRefreshScheduled) return
    this.tileRefreshScheduled = true
    requestAnimationFrame(() => {
      this.tileRefreshScheduled = false
      this.tb.refreshTileMesh(true) // live: geometry from latest heights, climate reused
    })
  }

  private ndc(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 }
  }

  private scheduleCursorUpdate(e: MouseEvent): void {
    this.pendingCursorEvent = e
    if (this.cursorRafScheduled) return
    this.cursorRafScheduled = true
    requestAnimationFrame(() => {
      this.cursorRafScheduled = false
      const pending = this.pendingCursorEvent; this.pendingCursorEvent = null
      if (pending && !this.isPointerDown) this.updateCursor(pending)
    })
  }

  private updateCursor(e: MouseEvent): void {
    const n = this.ndc(e)
    const s = this.tb.sampleAtNDC(n.x, n.y)
    const v = this.cursorVals
    if (!s) { v.elevation.textContent = v.temperature.textContent = v.humidity.textContent = v.biome.textContent = '—'; return }
    v.elevation.textContent = `${(s.elevation - s.seaLevel).toFixed(0)} m${s.underwater ? ' (underwater)' : ''}`
    v.temperature.textContent = s.temperature === null ? '—' : `${s.temperature.toFixed(1)} °C`
    v.humidity.textContent = s.humidity === null ? '—' : `${Math.round(s.humidity * 100)} %`
    v.biome.textContent = s.biome ?? '—'
  }
}

/** Decode a `data:...;base64,...` URL into raw bytes (for zipping canvas PNGs). */
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
