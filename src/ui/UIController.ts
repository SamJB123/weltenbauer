import { GUI } from 'lil-gui'
import { TerrainBuilder, EditorMode } from '../core/TerrainBuilder'
import { BrushMode } from '../core/BrushSystem'
import { ClimateView } from '../core/ClimateSystem'
import { ProgressOverlay } from './ProgressOverlay'
import { zipSync, Zippable } from 'fflate'

/** Decode a `data:...;base64,...` URL into raw bytes (for zipping canvas PNGs). */
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export class UIController {
  private terrainBuilder: TerrainBuilder
  private canvas: HTMLCanvasElement
  private gui!: GUI
  private modeToggleButton!: HTMLButtonElement
  private noiseLayersFolder: any = null
  private updateTimeout: number | null = null
  private progressOverlay: ProgressOverlay
  private cursorPanelValues!: { elevation: HTMLSpanElement; temperature: HTMLSpanElement; humidity: HTMLSpanElement; biome: HTMLSpanElement }
  private isPointerDown = false
  private pendingCursorEvent: MouseEvent | null = null
  private cursorRafScheduled = false

  // UI state objects for lil-gui
  private terrainParams = {
    size: 5,
    resolution: 256,
    geologicalComplexity: 1.0,
    domainWarping: 0.5,
    reliefAmplitude: 2.0,
    featureScale: 1.5,
    seed: 123456,
    showGrid: true,
    // Island & sea level
    islandEnabled: true,
    seaLevel: 0,
    oceanDepth: 25,
    landElevation: 25,
    falloffStart: 0.45,
    falloffEnd: 0.92,
    islandShape: 0.15,
    coastDistortion: 0.1,
    showWater: true,
    randomizeSeed: () => this.randomizeSeed(),
    testHighRes: () => this.testHighResolution(),
    importHeightmap: () => this.importHeightmap(),
    importIsland: () => this.importIsland(),
    resetToNormal: () => this.resetToNormalTerrain()
  }

  private climateParams = {
    viewMode: 'normal',
    baseTemperature: 22,
    latitudeRange: 12,
    lapseRate: 6.5,
    temperatureNoise: 2,
    humidityBase: 0.35,
    coastalMoisture: 0.5,
    coastalFalloff: 0.25,
    elevationDrying: 0.35,
    rainShadowStrength: 0.4,
    windDirection: 270,
    humidityNoise: 0.12
  }

  private biomeParams = {
    beachHeight: 12,
    blendMargin: 2.5
  }

  private csgParams = {
    undergroundDepth: 60,
    runDemo: () => this.runCsgDemo()
  }

  private brushParams = {
    mode: 'raise' as BrushMode,
    size: 10,
    strength: 0.5
  }

  private mountainPresets = {
    alaskanEverest: () => this.applyMountainPreset('alaskan'),
    nevadaNewMexico: () => this.applyMountainPreset('desert')
  }

  private erosionPresets = {
    gentleRain: () => this.applyGentleErosion(),
    strongErosion: () => this.applyStrongErosion(),
    dramaticErosion: () => this.applyDramaticErosion(),
    createRiver: () => this.createRiver()
  }

  private exportActions = {
    exportMapSet: () => this.exportMapSet(),
    exportIsland: () => this.exportIsland(),
    exportHeightmap: () => this.exportHeightmap()
  }



  private guideInfo = {
    orbitControls: "Drag to rotate, wheel to zoom",
    brushControls: "Click and drag to sculpt terrain",
    modeSwitch: "Use the Mode button (top-left) to switch between Orbit and Brush modes",
    terrainTips: "Adjust geological parameters for different terrain types",
    brushTips: "Different brush modes: Raise/Lower for height, Smooth for blending, Flatten for plateaus",
    presetTips: "Mountain presets apply specialized large-scale brushes - switch to Brush mode first"
  }

  constructor(terrainBuilder: TerrainBuilder) {
    this.terrainBuilder = terrainBuilder
    this.canvas = document.getElementById('canvas') as HTMLCanvasElement
    this.progressOverlay = new ProgressOverlay()
    
    this.setupModeToggle()
    this.setupGUI()
    this.setupCursorPanel()
    this.setupCanvasEvents()
    this.syncUIWithTerrain()
  }

  /** Bottom-left readout of elevation/temperature/humidity under the cursor. */
  private setupCursorPanel(): void {
    const panel = document.createElement('div')
    panel.style.position = 'absolute'
    panel.style.bottom = '10px'
    panel.style.left = '10px'
    panel.style.zIndex = '1000'
    panel.style.minWidth = '180px'
    panel.style.padding = '12px 14px'
    panel.style.background = 'rgba(26, 26, 26, 0.9)'
    panel.style.border = '2px solid #555'
    panel.style.borderRadius = '10px'
    panel.style.backdropFilter = 'blur(10px)'
    panel.style.boxShadow = '0 8px 32px rgba(0, 0, 0, 0.4)'
    panel.style.color = '#eee'
    panel.style.fontFamily = 'system-ui, -apple-system, sans-serif'
    panel.style.fontSize = '13px'
    panel.style.pointerEvents = 'none' // never intercept terrain mouse events

    const title = document.createElement('div')
    title.textContent = 'At Cursor'
    title.style.fontWeight = '600'
    title.style.fontSize = '12px'
    title.style.textTransform = 'uppercase'
    title.style.letterSpacing = '0.05em'
    title.style.color = '#9ab'
    title.style.marginBottom = '8px'
    panel.appendChild(title)

    const makeRow = (label: string): HTMLSpanElement => {
      const row = document.createElement('div')
      row.style.display = 'flex'
      row.style.justifyContent = 'space-between'
      row.style.gap = '16px'
      row.style.lineHeight = '1.6'

      const name = document.createElement('span')
      name.textContent = label
      name.style.color = '#aaa'

      const value = document.createElement('span')
      value.textContent = '—'
      value.style.fontVariantNumeric = 'tabular-nums'
      value.style.fontWeight = '500'

      row.appendChild(name)
      row.appendChild(value)
      panel.appendChild(row)
      return value
    }

    this.cursorPanelValues = {
      elevation: makeRow('Elevation'),
      temperature: makeRow('Temperature'),
      humidity: makeRow('Humidity'),
      biome: makeRow('Biome')
    }

    document.body.appendChild(panel)
  }

  /** Update the cursor readout from a mouse event, or blank it when off-terrain. */
  private updateCursorPanel(event: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect()
    const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1
    const ndcY = -((event.clientY - rect.top) / rect.height) * 2 + 1

    const sample = this.terrainBuilder.sampleAtNDC(ndcX, ndcY)
    const v = this.cursorPanelValues

    if (!sample) {
      v.elevation.textContent = '—'
      v.temperature.textContent = '—'
      v.humidity.textContent = '—'
      v.biome.textContent = '—'
      return
    }

    const relative = sample.elevation - sample.seaLevel
    const suffix = sample.underwater ? ' (underwater)' : ''
    v.elevation.textContent = `${relative.toFixed(0)} m${suffix}`
    v.temperature.textContent = sample.temperature === null ? '—' : `${sample.temperature.toFixed(1)} °C`
    v.humidity.textContent = sample.humidity === null ? '—' : `${Math.round(sample.humidity * 100)} %`
    v.biome.textContent = sample.biome ?? '—'
  }

  private setupModeToggle(): void {
    this.modeToggleButton = document.createElement('button')
    this.modeToggleButton.style.position = 'absolute'
    this.modeToggleButton.style.top = '50px'
    this.modeToggleButton.style.left = '10px'
    this.modeToggleButton.style.padding = '10px 20px'
    this.modeToggleButton.style.background = '#0066cc'
    this.modeToggleButton.style.color = 'white'
    this.modeToggleButton.style.border = 'none'
    this.modeToggleButton.style.borderRadius = '6px'
    this.modeToggleButton.style.cursor = 'pointer'
    this.modeToggleButton.style.fontSize = '14px'
    this.modeToggleButton.style.fontWeight = 'bold'
    this.modeToggleButton.style.zIndex = '1000'
    this.modeToggleButton.textContent = 'Mode: Orbit'
    
    document.body.appendChild(this.modeToggleButton)

    this.modeToggleButton.addEventListener('click', () => {
      const currentMode = this.terrainBuilder.getMode()
      const newMode: EditorMode = currentMode === 'orbit' ? 'brush' : 'orbit'
      
      this.terrainBuilder.setMode(newMode)
      this.modeToggleButton.textContent = `Mode: ${newMode.charAt(0).toUpperCase() + newMode.slice(1)}`
      
      if (newMode === 'orbit') {
        this.modeToggleButton.style.background = '#0066cc'
      } else {
        this.modeToggleButton.style.background = '#cc6600'
      }
    })
  }

  private setupGUI(): void {
    this.gui = new GUI({ title: 'Weltbuilder Controls', width: 320 })
    
    // Position GUI flush with right edge
    this.gui.domElement.style.position = 'fixed'
    this.gui.domElement.style.top = '0px'
    this.gui.domElement.style.right = '0px'
    
    // Terrain Generation folder
    const terrainFolder = this.gui.addFolder('Terrain Generation')
    
    terrainFolder.add(this.terrainParams, 'size', 1, 20, 1)
      .name('Size (km)')
      .onChange((value: number) => {
        this.terrainBuilder.updateConfig({ size: value })
      })

    // Resolution controls with performance info
    const resolutionOptions = {
      '64x64 (4K vertices)': 64,
      '128x128 (16K vertices)': 128,
      '256x256 (66K vertices)': 256,
      '512x512 (262K vertices)': 512,
      '1024x1024 (1M vertices)': 1024,
      '1025x1025 (1M vertices)': 1025,
      '1536x1536 (2.4M vertices)': 1536,
      '2048x2048 (4.2M vertices)': 2048,
      '2049x2049 (4.2M vertices)': 2049,
      '3072x3072 (9.4M vertices)': 3072,
      '4096x4096 (16.8M vertices)': 4096,
      '4097x4097 (16.8M vertices)': 4097
    }

    terrainFolder.add(this.terrainParams, 'resolution', resolutionOptions)
      .name('🔧 Resolution')
      .onChange((value: number) => {
        console.log(`Setting resolution to ${value}x${value}`)
        this.terrainBuilder.setResolution(value)
        this.updateResolutionInfo(value)
      })

    // Test high resolution button
    terrainFolder.add(this.terrainParams, 'testHighRes')
      .name('🧪 Test High Resolution')

    // Import heightmap button
    terrainFolder.add(this.terrainParams, 'importHeightmap')
      .name('📁 Import Heightmap')

    // Import a previously-exported island (lossless) to keep editing
    terrainFolder.add(this.terrainParams, 'importIsland')
      .name('📂 Import Island')

    // Reset to normal terrain button
    terrainFolder.add(this.terrainParams, 'resetToNormal')
      .name('🔄 Reset to Normal')

    terrainFolder.add(this.terrainParams, 'geologicalComplexity', 0.0, 2.0, 0.1)
      .name('Geological Complexity')
      .onChange((value: number) => {
        this.terrainBuilder.updateConfig({ geologicalComplexity: value })
      })

    terrainFolder.add(this.terrainParams, 'domainWarping', 0.0, 1.0, 0.05)
      .name('Domain Warping')
      .onChange((value: number) => {
        this.terrainBuilder.updateConfig({ domainWarping: value })
      })

    terrainFolder.add(this.terrainParams, 'reliefAmplitude', 0.2, 4.0, 0.1)
      .name('Relief Amplitude')
      .onChange((value: number) => {
        this.terrainBuilder.updateConfig({ reliefAmplitude: value })
      })

    terrainFolder.add(this.terrainParams, 'featureScale', 0.1, 3.0, 0.1)
      .name('Feature Scale')
      .onChange((value: number) => {
        this.terrainBuilder.updateConfig({ featureScale: value })
      })

    terrainFolder.add(this.terrainParams, 'seed')
      .name('Seed')
      .onChange((value: number) => {
        this.terrainBuilder.updateConfig({ seed: value })
      })

    terrainFolder.add(this.terrainParams, 'randomizeSeed')
      .name('🎲 Randomize Seed')

    terrainFolder.add(this.terrainParams, 'showGrid')
      .name('Show Grid')
      .onChange((value: boolean) => {
        this.terrainBuilder.toggleGrid(value)
      })

    terrainFolder.open()

    // Island & Sea Level folder
    const islandFolder = this.gui.addFolder('Island & Sea Level')

    islandFolder.add(this.terrainParams, 'islandEnabled')
      .name('🏝️ Islandize')
      .onChange(() => this.pushIslandConfig())

    islandFolder.add(this.terrainParams, 'seaLevel', -200, 200, 1)
      .name('Sea Level')
      .onChange(() => this.pushIslandConfig())

    islandFolder.add(this.terrainParams, 'oceanDepth', 0, 500, 5)
      .name('Ocean Depth')
      .onChange(() => this.pushIslandConfig())

    islandFolder.add(this.terrainParams, 'landElevation', 0, 400, 1)
      .name('Land Elevation (peak m)')
      .onChange(() => this.pushIslandConfig())

    islandFolder.add(this.terrainParams, 'falloffStart', 0.0, 1.0, 0.01)
      .name('Coast Start')
      .onChange(() => this.pushIslandConfig())

    islandFolder.add(this.terrainParams, 'falloffEnd', 0.0, 1.0, 0.01)
      .name('Coast End')
      .onChange(() => this.pushIslandConfig())

    islandFolder.add(this.terrainParams, 'islandShape', 0.0, 1.0, 0.05)
      .name('Shape (round→square)')
      .onChange(() => this.pushIslandConfig())

    islandFolder.add(this.terrainParams, 'coastDistortion', 0.0, 0.5, 0.01)
      .name('Coast Distortion')
      .onChange(() => this.pushIslandConfig())

    islandFolder.add(this.terrainParams, 'showWater')
      .name('Show Water')
      .onChange(() => this.pushIslandConfig())

    islandFolder.open()

    // Climate folder (temperature + humidity)
    const climateFolder = this.gui.addFolder('Climate')

    climateFolder.add(this.climateParams, 'viewMode', {
      'Normal (textured)': 'normal',
      'Biome (textured)': 'biome',
      'Biome colors': 'biomeColor',
      'Temperature map': 'temperature',
      'Humidity map': 'humidity'
    })
      .name('🌡️ View')
      .onChange((value: ClimateView) => this.terrainBuilder.setClimateViewMode(value))

    climateFolder.add(this.climateParams, 'baseTemperature', -20, 40, 1)
      .name('Base Temp (°C)')
      .onChange(() => this.pushClimateConfig())

    climateFolder.add(this.climateParams, 'latitudeRange', 0, 40, 1)
      .name('Latitude Range (°C)')
      .onChange(() => this.pushClimateConfig())

    climateFolder.add(this.climateParams, 'lapseRate', 0, 30, 0.5)
      .name('Lapse Rate (°C/1000m)')
      .onChange(() => this.pushClimateConfig())

    climateFolder.add(this.climateParams, 'temperatureNoise', 0, 10, 0.5)
      .name('Temp Variation (°C)')
      .onChange(() => this.pushClimateConfig())

    climateFolder.add(this.climateParams, 'humidityBase', 0, 1, 0.05)
      .name('Base Humidity')
      .onChange(() => this.pushClimateConfig())

    climateFolder.add(this.climateParams, 'coastalMoisture', 0, 1, 0.05)
      .name('Coastal Moisture')
      .onChange(() => this.pushClimateConfig())

    climateFolder.add(this.climateParams, 'coastalFalloff', 0.02, 1, 0.02)
      .name('Coastal Reach')
      .onChange(() => this.pushClimateConfig())

    climateFolder.add(this.climateParams, 'elevationDrying', 0, 1, 0.05)
      .name('Elevation Drying (/1000m)')
      .onChange(() => this.pushClimateConfig())

    climateFolder.add(this.climateParams, 'rainShadowStrength', 0, 1, 0.05)
      .name('Rain Shadow')
      .onChange(() => this.pushClimateConfig())

    climateFolder.add(this.climateParams, 'windDirection', 0, 360, 5)
      .name('Wind Direction (°)')
      .onChange(() => this.pushClimateConfig())

    climateFolder.add(this.climateParams, 'humidityNoise', 0, 0.5, 0.02)
      .name('Humidity Variation')
      .onChange(() => this.pushClimateConfig())

    // Biome folder (Whittaker classification)
    const biomeFolder = this.gui.addFolder('Biomes')

    biomeFolder.add(this.biomeParams, 'beachHeight', 0, 60, 1)
      .name('Beach Height')
      .onChange(() => this.pushBiomeConfig())

    biomeFolder.add(this.biomeParams, 'blendMargin', 0.5, 8, 0.5)
      .name('Blend Width (°C)')
      .onChange(() => this.pushBiomeConfig())

    biomeFolder.add({ exportBiomes: () => this.exportBiomes() }, 'exportBiomes')
      .name('📦 Export Biome Data')

    // CSG (experimental) folder — heightfield → solid + boolean carving
    const csgFolder = this.gui.addFolder('CSG (experimental)')

    csgFolder.add(this.csgParams, 'undergroundDepth', 0, 300, 5)
      .name('Underground Depth (m)')

    csgFolder.add(this.csgParams, 'runDemo')
      .name('🧱 Solidify + Carve (demo)')

    // Brush Tools folder
    const brushFolder = this.gui.addFolder('Brush Tools')
    
    brushFolder.add(this.brushParams, 'mode', ['raise', 'lower', 'smooth', 'flatten', 'mountain'])
      .name('Brush Mode')
      .onChange((value: BrushMode) => {
        this.terrainBuilder.getBrushSystem().setBrushSettings({ mode: value })
      })

    brushFolder.add(this.brushParams, 'size', 1, 500, 1)
      .name('Brush Size (m)')
      .onChange((value: number) => {
        this.terrainBuilder.getBrushSystem().setBrushSettings({ size: value })
      })

    brushFolder.add(this.brushParams, 'strength', 0.1, 2.0, 0.1)
      .name('Brush Strength')
      .onChange((value: number) => {
        this.terrainBuilder.getBrushSystem().setBrushSettings({ strength: value })
      })

    brushFolder.open()

    // Mountain Presets folder
    const mountainFolder = this.gui.addFolder('Mountain Presets')
    
    mountainFolder.add(this.mountainPresets, 'alaskanEverest')
      .name('🏔️ Alaskan/Everest')
    
    mountainFolder.add(this.mountainPresets, 'nevadaNewMexico')
      .name('🏜️ Nevada/New Mexico')

    // Erosion Presets folder
    const erosionFolder = this.gui.addFolder('Erosion Presets')
    
    erosionFolder.add(this.erosionPresets, 'gentleRain')
      .name('🌧️ Gentle Rain')
    
    erosionFolder.add(this.erosionPresets, 'createRiver')
      .name('🏞️ Create River')

    // Export folder
    const exportFolder = this.gui.addFolder('Export')

    exportFolder.add(this.exportActions, 'exportMapSet')
      .name('🗺️ Export Map Set (2.5D)')

    exportFolder.add(this.exportActions, 'exportIsland')
      .name('💾 Export Island (lossless)')

    exportFolder.add(this.exportActions, 'exportHeightmap')
      .name('Export Heightmap (legacy)')

    // Guide folder (collapsed by default)
    const guideFolder = this.gui.addFolder('Guide')
    
    // Add guide items as read-only text controllers
    guideFolder.add(this.guideInfo, 'orbitControls')
      .name('🔄 Orbit Mode')
      .disable()
    
    guideFolder.add(this.guideInfo, 'brushControls')
      .name('🖌️ Brush Mode')
      .disable()
    
    guideFolder.add(this.guideInfo, 'modeSwitch')
      .name('🔀 Mode Switching')
      .disable()
    
    guideFolder.add(this.guideInfo, 'terrainTips')
      .name('🏔️ Terrain Tips')
      .disable()
    
    guideFolder.add(this.guideInfo, 'brushTips')
      .name('🎨 Brush Tips')
      .disable()
    
    guideFolder.add(this.guideInfo, 'presetTips')
      .name('📦 Preset Tips')
      .disable()
    
    // Keep guide folder closed by default
    guideFolder.close()
    
    // Setup noise layers folder
    this.setupNoiseLayersFolder()
  }

  private setupNoiseLayersFolder(): void {
    // Only create if it doesn't exist
    if (!this.noiseLayersFolder) {
      this.noiseLayersFolder = this.gui.addFolder('Noise Layers')
      // Populate it with initial data
      this.populateNoiseLayersFolder()
    }
  }

  private populateNoiseLayersFolder(): void {
    if (!this.noiseLayersFolder) return
    
    // Get layers data from terrain builder
    const layersData = this.terrainBuilder.getNoiseLayersData()
    const { layers, baseLayers } = layersData
    
    // Create controls for each layer
    this.createLayerControls(layers, baseLayers)
    
    // Add management controls
    this.addLayerManagementControls(layers)
    
    this.noiseLayersFolder.open()
  }

  private updateNoiseLayersFolder(): void {
    // Destroy and recreate the entire folder to avoid duplicates
    if (this.noiseLayersFolder) {
      try {
        // Try to destroy the folder completely
        this.noiseLayersFolder.destroy()
      } catch (e) {
        // If destroy doesn't work, try to clear manually
        console.log('Manual cleanup of noise layers folder')
      }
    }
    
    // Always recreate the folder fresh
    this.noiseLayersFolder = this.gui.addFolder('Noise Layers')
    
    // Get fresh layers data
    const layersData = this.terrainBuilder.getNoiseLayersData()
    const { layers, baseLayers } = layersData
    
    // Create controls for each layer
    this.createLayerControls(layers, baseLayers)
    
    // Add management controls
    this.addLayerManagementControls(layers)
    
    this.noiseLayersFolder.open()
  }

  private createLayerControls(layers: any[], baseLayers: any[]): void {
    layers.forEach((layer: any, index: number) => {
      const isCustomLayer = index >= baseLayers.length
      const layerName = `${index + 1}. ${layer.type.toUpperCase()}${isCustomLayer ? ' (Custom)' : ''}`
      
      const folder = this.noiseLayersFolder.addFolder(layerName)
      
      // Weight controller
      const weightControl = {
        weight: Math.round(layer.weight * 100)
      }
      
      folder.add(weightControl, 'weight', 0, 100, 1)
        .name('Weight %')
        .onChange((value: number) => {
          console.log(`Layer ${index} weight changed to ${value}%`)
          this.terrainBuilder.updateLayerWeight(index, value / 100, false)
        })
      
      // Add preview canvas to folder
      const previewContainer = document.createElement('div')
      previewContainer.style.padding = '8px'
      
      const canvas = document.createElement('canvas')
      canvas.width = 120
      canvas.height = 120
      canvas.style.width = '120px'
      canvas.style.height = '120px'
      canvas.style.border = '1px solid #666'
      canvas.style.borderRadius = '4px'
      canvas.style.background = '#222'
      canvas.style.display = 'block'
      canvas.style.margin = '0 auto'
      
      this.terrainBuilder.generateLayerPreview(canvas, layer)
      
      previewContainer.appendChild(canvas)
      folder.domElement.appendChild(previewContainer)
      
      // Remove button for custom layers
      if (isCustomLayer) {
        const removeControl = {
          remove: () => {
            this.terrainBuilder.removeLayer(index)
            this.updateNoiseLayersGUI() // Use the debounced version
          }
        }
        folder.add(removeControl, 'remove').name('🗑️ Remove Layer')
      }
      
      folder.open()
    })
  }

  private addLayerManagementControls(layers: any[]): void {
    // Add layer button
    const addLayerControl = {
      addLayer: () => this.terrainBuilder.showAddLayerDialog()
    }
    this.noiseLayersFolder.add(addLayerControl, 'addLayer').name('➕ Add Layer')
    
    // Weight summary
    const totalWeight = layers.reduce((sum: number, layer: any) => sum + layer.weight, 0)
    const summaryControl = {
      totalWeight: `${(totalWeight * 100).toFixed(1)}%`
    }
    this.noiseLayersFolder.add(summaryControl, 'totalWeight').name('Total Weight').disable()
  }

  public updateNoiseLayersGUI(): void {
    // Debounce multiple rapid calls to prevent duplicates
    if (this.updateTimeout) {
      clearTimeout(this.updateTimeout)
    }
    
    this.updateTimeout = setTimeout(() => {
      this.updateNoiseLayersFolder()
      this.updateTimeout = null
    }, 50) // Small delay to batch updates
  }

  private setupCanvasEvents(): void {
    this.canvas.addEventListener('mousedown', (event) => {
      this.isPointerDown = true
      this.terrainBuilder.getBrushSystem().handleMouseDown(
        event,
        this.terrainBuilder.getCamera(),
        this.canvas
      )
    })

    this.canvas.addEventListener('mousemove', (event) => {
      this.terrainBuilder.getBrushSystem().handleMouseMove(
        event,
        this.terrainBuilder.getCamera(),
        this.canvas
      )
      this.scheduleCursorUpdate(event)
    })

    this.canvas.addEventListener('mouseup', (event) => {
      this.isPointerDown = false
      this.terrainBuilder.getBrushSystem().handleMouseUp()
      this.scheduleCursorUpdate(event) // refresh once after the drag ends
    })

    // Catch releases outside the canvas so the pointer-down state can't get stuck.
    window.addEventListener('mouseup', () => {
      this.isPointerDown = false
    })
  }

  /**
   * Throttle cursor sampling to at most one raycast per animation frame, and skip
   * it entirely while dragging (orbit/brush) — raycasting the high-res terrain on
   * every mousemove during a rotate is what tanks the frame rate.
   */
  private scheduleCursorUpdate(event: MouseEvent): void {
    this.pendingCursorEvent = event
    if (this.cursorRafScheduled) return

    this.cursorRafScheduled = true
    requestAnimationFrame(() => {
      this.cursorRafScheduled = false
      const pending = this.pendingCursorEvent
      this.pendingCursorEvent = null
      if (pending && !this.isPointerDown) {
        this.updateCursorPanel(pending)
      }
    })
  }

  private syncUIWithTerrain(): void {
    const config = this.terrainBuilder.getConfig()
    
    // Update terrain params
    this.terrainParams.size = config.size
    this.terrainParams.resolution = config.resolution
    this.terrainParams.geologicalComplexity = config.geologicalComplexity
    this.terrainParams.domainWarping = config.domainWarping
    this.terrainParams.reliefAmplitude = config.reliefAmplitude
    this.terrainParams.featureScale = config.featureScale
    this.terrainParams.seed = config.seed
    this.terrainParams.showGrid = this.terrainBuilder.isGridVisible()

    // Island & sea level
    this.terrainParams.islandEnabled = config.island.enabled
    this.terrainParams.seaLevel = config.island.seaLevel
    this.terrainParams.oceanDepth = config.island.oceanDepth
    this.terrainParams.landElevation = config.island.landBias
    this.terrainParams.falloffStart = config.island.falloffStart
    this.terrainParams.falloffEnd = config.island.falloffEnd
    this.terrainParams.islandShape = config.island.shape
    this.terrainParams.coastDistortion = config.island.coastDistortion
    this.terrainParams.showWater = config.island.showWater

    // Climate
    this.climateParams.viewMode = config.climate.viewMode
    this.climateParams.baseTemperature = config.climate.baseTemperature
    this.climateParams.latitudeRange = config.climate.latitudeRange
    this.climateParams.lapseRate = config.climate.lapseRate
    this.climateParams.temperatureNoise = config.climate.temperatureNoise
    this.climateParams.humidityBase = config.climate.humidityBase
    this.climateParams.coastalMoisture = config.climate.coastalMoisture
    this.climateParams.coastalFalloff = config.climate.coastalFalloff
    this.climateParams.elevationDrying = config.climate.elevationDrying
    this.climateParams.rainShadowStrength = config.climate.rainShadowStrength
    this.climateParams.windDirection = config.climate.windDirection
    this.climateParams.humidityNoise = config.climate.humidityNoise

    // Biomes
    this.biomeParams.beachHeight = config.biome.beachHeight
    this.biomeParams.blendMargin = config.biome.blendMargin

    // Update brush params
    const brushSettings = this.terrainBuilder.getBrushSystem().getBrushSettings()
    this.brushParams.mode = brushSettings.mode
    this.brushParams.size = brushSettings.size
    this.brushParams.strength = brushSettings.strength

    // Refresh GUI to show updated values
    this.updateGUIDisplay()
  }

  /** Send the current island/sea-level params to the terrain builder as one config update. */
  private pushIslandConfig(): void {
    this.terrainBuilder.updateConfig({
      island: {
        enabled: this.terrainParams.islandEnabled,
        seaLevel: this.terrainParams.seaLevel,
        oceanDepth: this.terrainParams.oceanDepth,
        landBias: this.terrainParams.landElevation,
        falloffStart: this.terrainParams.falloffStart,
        falloffEnd: this.terrainParams.falloffEnd,
        shape: this.terrainParams.islandShape,
        coastDistortion: this.terrainParams.coastDistortion,
        showWater: this.terrainParams.showWater
      }
    })
  }

  /** Send the current climate params to the terrain builder (no terrain regeneration). */
  private pushClimateConfig(): void {
    this.terrainBuilder.setClimateConfig({
      baseTemperature: this.climateParams.baseTemperature,
      latitudeRange: this.climateParams.latitudeRange,
      lapseRate: this.climateParams.lapseRate,
      temperatureNoise: this.climateParams.temperatureNoise,
      humidityBase: this.climateParams.humidityBase,
      coastalMoisture: this.climateParams.coastalMoisture,
      coastalFalloff: this.climateParams.coastalFalloff,
      elevationDrying: this.climateParams.elevationDrying,
      rainShadowStrength: this.climateParams.rainShadowStrength,
      windDirection: this.climateParams.windDirection,
      humidityNoise: this.climateParams.humidityNoise
    })
  }

  /** Send the current biome params to the terrain builder (no terrain regeneration). */
  private pushBiomeConfig(): void {
    this.terrainBuilder.setBiomeConfig({
      beachHeight: this.biomeParams.beachHeight,
      blendMargin: this.biomeParams.blendMargin
    })
  }

  /** Download the texture-agnostic biome dataset: legend JSON, PNG control maps, raw binary. */
  private exportBiomes(): void {
    try {
      const data = this.terrainBuilder.getBiomeExport()
      if (!data) {
        alert('Generate terrain before exporting biome data.')
        return
      }

      const jsonUrl = URL.createObjectURL(new Blob([data.legendJson], { type: 'application/json' }))
      this.downloadFile(jsonUrl, 'biomes-legend.json')
      URL.revokeObjectURL(jsonUrl)

      this.downloadFile(data.indicesPng, 'biome-indices.png')
      this.downloadFile(data.weightsPng, 'biome-weights.png')

      const idxUrl = URL.createObjectURL(new Blob([data.indicesBin], { type: 'application/octet-stream' }))
      this.downloadFile(idxUrl, 'biome-indices.bin')
      URL.revokeObjectURL(idxUrl)

      const wUrl = URL.createObjectURL(new Blob([data.weightsBin.buffer], { type: 'application/octet-stream' }))
      this.downloadFile(wUrl, 'biome-weights.bin')
      URL.revokeObjectURL(wUrl)
    } catch (error) {
      console.error('Failed to export biome data:', error)
      alert('Failed to export biome data. Please try again.')
    }
  }

  /** Run (or toggle off) the Stage-1 CSG solidify + carve demo. */
  private runCsgDemo(): void {
    try {
      const showing = this.terrainBuilder.runCsgDemo(this.csgParams.undergroundDepth)
      console.log(showing ? 'CSG demo: showing carved solid' : 'CSG demo: restored terrain')
    } catch (error) {
      console.error('CSG demo failed:', error)
      alert('CSG demo failed — see console for details.')
    }
  }

  private randomizeSeed(): void {
    this.terrainBuilder.randomizeSeed()
    const newSeed = this.terrainBuilder.getConfig().seed
    this.terrainParams.seed = newSeed
    this.updateGUIDisplay()
  }

  private applyMountainPreset(preset: 'alaskan' | 'desert'): void {
    this.terrainBuilder.getBrushSystem().applyMountainPreset(preset)
    this.syncBrushUI()
  }

  private applyGentleErosion(): void {
    this.terrainBuilder.applyGentleErosion()
  }

  private applyStrongErosion(): void {
    this.terrainBuilder.applyStrongErosion()
  }

  private applyDramaticErosion(): void {
    this.terrainBuilder.applyDramaticErosion()
  }

  private createRiver(): void {
    const size = this.terrainBuilder.getConfig().size * 1000
    const startX = -size * 0.3
    const startY = size * 0.2
    const endX = size * 0.3
    const endY = -size * 0.2
    
    this.terrainBuilder.createRiver(startX, startY, endX, endY)
  }

  private syncBrushUI(): void {
    const settings = this.terrainBuilder.getBrushSystem().getBrushSettings()
    this.brushParams.mode = settings.mode
    this.brushParams.size = settings.size
    this.brushParams.strength = settings.strength
    this.updateGUIDisplay()
  }

  /** Download the standardized 2.5D map set as a single zip: manifest.json + per-map PNG previews + raw .bin. */
  private exportMapSet(): void {
    try {
      const result = this.terrainBuilder.getMapSetExport()
      if (!result) {
        alert('Generate terrain before exporting the map set.')
        return
      }

      // Collect everything into one archive instead of N separate downloads.
      const entries: Zippable = {}
      entries['manifest.json'] = new TextEncoder().encode(result.manifestJson)

      for (const file of result.files) {
        const bytes = file.dataUrl ? dataUrlToBytes(file.dataUrl) : new Uint8Array(file.bytes!)
        // PNGs are already compressed — store them; deflate the raw .bin/.json.
        entries[file.name] = file.name.endsWith('.png') ? [bytes, { level: 0 }] : bytes
      }

      // Include the lossless project so the zip can be re-imported and edited.
      const island = this.terrainBuilder.exportIslandProject()
      if (island) entries['island.weltenbauer.json'] = new TextEncoder().encode(island)

      const zipped = zipSync(entries)
      const url = URL.createObjectURL(new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' }))
      this.downloadFile(url, 'weltenbauer-mapset.zip')
      URL.revokeObjectURL(url)
    } catch (error) {
      console.error('Failed to export map set:', error)
      alert('Failed to export map set. See console for details.')
    }
  }

  /** Download the lossless, self-contained island project (re-importable). */
  private exportIsland(): void {
    try {
      const json = this.terrainBuilder.exportIslandProject()
      if (!json) {
        alert('Generate terrain before exporting the island.')
        return
      }
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
      this.downloadFile(url, 'island.weltenbauer.json')
      URL.revokeObjectURL(url)
    } catch (error) {
      console.error('Failed to export island:', error)
      alert('Failed to export island. See console for details.')
    }
  }

  /** Import a previously-exported island project (.weltenbauer.json) and keep editing it. */
  private importIsland(): void {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json,.json'
    input.style.display = 'none'

    input.onchange = async (event) => {
      const file = (event.target as HTMLInputElement).files?.[0]
      if (!file) return
      try {
        const text = await file.text()
        await this.terrainBuilder.loadIslandProject(text)
        this.syncUIWithTerrain() // reflect the loaded config in the GUI
        console.log('✅ Island imported:', file.name)
      } catch (error) {
        console.error('❌ Failed to import island:', error)
        alert('Failed to import island — is this a weltenbauer island file? See console for details.')
      } finally {
        document.body.removeChild(input)
      }
    }

    document.body.appendChild(input)
    input.click()
  }

  private exportHeightmap(): void {
    try {
      const dataUrl = this.terrainBuilder.exportHeightmap()
      this.downloadFile(dataUrl, 'heightmap.png')
    } catch (error) {
      console.error('Failed to export heightmap:', error)
      alert('Failed to export heightmap. Please try again.')
    }
  }

  private downloadFile(url: string, filename: string): void {
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  private updateGUIDisplay(): void {
    // Update all controllers in all folders
    this.gui.controllersRecursive().forEach(controller => {
      controller.updateDisplay()
    })
  }

  private updateResolutionInfo(resolution: number): void {
    // Calculate performance estimates
    const vertices = resolution * resolution
    let memoryMB: string
    let timeEstimate: string
    let chunkSize: number

    if (resolution <= 256) {
      memoryMB = "~1MB"
      timeEstimate = "<1s"
      chunkSize = 256
    } else if (resolution <= 512) {
      memoryMB = "~4MB"
      timeEstimate = "1-3s"
      chunkSize = 128
    } else if (resolution <= 1024) {
      memoryMB = "~16MB"
      timeEstimate = "3-8s"
      chunkSize = 64
    } else if (resolution <= 2048) {
      memoryMB = "~64MB"
      timeEstimate = "10-25s"
      chunkSize = 32
    } else {
      memoryMB = "~256MB"
      timeEstimate = "30-90s"
      chunkSize = 32
    }

    console.log(`Resolution ${resolution}x${resolution}:`)
    console.log(`- Vertices: ${vertices.toLocaleString()}`)
    console.log(`- Memory: ${memoryMB}`)
    console.log(`- Generation time: ${timeEstimate}`)
    console.log(`- Chunk size: ${chunkSize}x${chunkSize}`)
    
    // Show warning for very high resolutions
    if (resolution >= 2048) {
      console.warn(`⚠️ High resolution detected! This may take ${timeEstimate} to generate.`)
    }
  }

  private async testHighResolution(): Promise<void> {
    console.log('🧪 Testing high resolution terrain generation...')
    
    try {
      // Test with 1024x1024 resolution
      const success = await this.terrainBuilder.testHighResolution(1024)
      
      if (success) {
        console.log('✅ High resolution test passed! You can safely use higher resolutions.')
        alert('✅ High resolution test passed!\n\nYour system can handle high resolution terrain generation without stack overflow errors.')
      } else {
        console.log('❌ High resolution test failed.')
        alert('❌ High resolution test failed.\n\nPlease check the console for error details.')
      }
    } catch (error) {
      console.error('Test failed with error:', error)
      alert('❌ Test failed with error. Check console for details.')
    }
  }

  public getProgressOverlay(): ProgressOverlay {
    return this.progressOverlay
  }

  private importHeightmap(): void {
    // Create file input element
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.style.display = 'none'
    
    input.onchange = async (event) => {
      const file = (event.target as HTMLInputElement).files?.[0]
      if (!file) return
      
      try {
        console.log('📁 Processing heightmap:', file.name)
        
        // Create image element to load the file
        const img = new Image()
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')!
        
        img.onload = async () => {
          // Use source image resolution
          const sourceWidth = img.width
          const sourceHeight = img.height
          const resolution = Math.max(sourceWidth, sourceHeight)
          
          // Use original resolution (capped at 4096 for performance)
          const finalResolution = Math.min(resolution, 4096)
          
          console.log(`Source: ${sourceWidth}x${sourceHeight}, Using resolution: ${finalResolution}x${finalResolution}`)
          
          // Set canvas to final resolution
          canvas.width = finalResolution
          canvas.height = finalResolution
          
          // Draw image scaled to fit canvas
          ctx.fillStyle = '#000000'
          ctx.fillRect(0, 0, finalResolution, finalResolution)
          
          const scale = Math.min(finalResolution / sourceWidth, finalResolution / sourceHeight)
          const scaledWidth = sourceWidth * scale
          const scaledHeight = sourceHeight * scale
          const offsetX = (finalResolution - scaledWidth) / 2
          const offsetY = (finalResolution - scaledHeight) / 2
          
          ctx.drawImage(img, offsetX, offsetY, scaledWidth, scaledHeight)
          
          // Extract height data from canvas
          const imageData = ctx.getImageData(0, 0, finalResolution, finalResolution)
          const heightData = new Float32Array(finalResolution * finalResolution)
          
          // Convert RGB to height values (preserving original grayscale range)
          for (let i = 0; i < heightData.length; i++) {
            const pixelIndex = i * 4
            const r = imageData.data[pixelIndex]
            const g = imageData.data[pixelIndex + 1]  
            const b = imageData.data[pixelIndex + 2]
            
            // Convert to grayscale but preserve original range instead of forcing -200 to +200
            const gray = (r + g + b) / 3
            heightData[i] = gray // Keep original 0-255 range, convert to height scale later
          }
          
          // Update resolution if different
          if (finalResolution !== this.terrainParams.resolution) {
            this.terrainParams.resolution = finalResolution
            this.terrainBuilder.setResolution(finalResolution)
            this.updateResolutionInfo(finalResolution)
          }
          
          // Update size to 1km as requested (but don't trigger regeneration during import)
          this.terrainParams.size = 1
          // Note: Not calling updateConfig here to avoid triggering generateTerrain() during import
          // The size is already set in the TerrainBuilder.importHeightmap() method
          
          // Import the heightmap into terrain builder
          await this.terrainBuilder.importHeightmap(heightData, finalResolution, file.name)
          
          console.log('✅ Heightmap imported successfully!')
        }
        
        // Load the image
        img.src = URL.createObjectURL(file)
        
      } catch (error) {
        console.error('❌ Failed to import heightmap:', error)
        alert('Failed to import heightmap. Please check the console for details.')
      }
    }
    
    // Trigger file selection
    document.body.appendChild(input)
    input.click()
    document.body.removeChild(input)
  }

  private resetToNormalTerrain(): void {
    const confirmReset = confirm('Reset to normal terrain generation? This will remove the imported heightmap and restore the default noise layers.')
    
    if (confirmReset) {
      this.terrainBuilder.resetToNormalTerrain()
      console.log('🔄 Reset to normal terrain generation mode')
    }
  }
} 