import { TerrainBuilder } from './core/TerrainBuilder'
import { WeltUI } from './ui/welt/WeltUI'

class App {
  private terrainBuilder: TerrainBuilder
  // @ts-ignore - UI instance needed for initialization
  private _ui: WeltUI // control surface for terrain manipulation

  constructor() {
    const canvas = document.getElementById('canvas') as HTMLCanvasElement
    if (!canvas) {
      throw new Error('Canvas element not found')
    }

    this.terrainBuilder = new TerrainBuilder(canvas)
    this._ui = new WeltUI(this.terrainBuilder)

    // Connect UI to terrain builder (progress overlay, noise-layer + cutter refresh)
    this.terrainBuilder.setUIController(this._ui)

    this.init()
  }

  private init(): void {
    // Handle window resize
    window.addEventListener('resize', () => {
      this.terrainBuilder.resize()
    })

    // Initial terrain generation
    this.terrainBuilder.generateTerrain()
      .then(() => console.log('Weltbuilder initialized with terrain'))
      .catch(error => console.error('Failed to initialize terrain:', error))
  }
}

// Initialize the application when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  new App()
}) 