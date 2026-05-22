import * as THREE from 'three/webgpu'

export type BrushMode = 'raise' | 'lower' | 'smooth' | 'flatten' | 'mountain'

export interface MountainPreset {
  name: string
  size: number
  strength: number
  octaves: number
  persistence: number
  frequency: number
  ridgeSharpness: number
  type: 'alpine' | 'desert'
}

export interface BrushSettings {
  size: number
  strength: number
  mode: BrushMode
  mountainPreset?: MountainPreset
}

// Mountain presets for different mountain types
export const MOUNTAIN_PRESETS: { [key: string]: MountainPreset } = {
  alaskan: {
    name: 'Alaskan/Everest',
    size: 250,
    strength: 0.8,
    octaves: 8,
    persistence: 0.6,
    frequency: 0.004,
    ridgeSharpness: 2.4,
    type: 'alpine'
  },
  desert: {
    name: 'Nevada/New Mexico',
    size: 200,
    strength: 0.6,
    octaves: 6,
    persistence: 0.5,
    frequency: 0.006,
    ridgeSharpness: 1.8,
    type: 'desert'
  }
}

export class BrushSystem {
  private terrain: THREE.Mesh | null = null
  private heightData: Float32Array | null = null
  // @ts-ignore - Kept for potential undo functionality
  private _originalHeightData: Float32Array | null = null
  private resolution: number = 0
  private terrainSize: number = 1000
  
  private brushSettings: BrushSettings = {
    size: 10,
    strength: 0.5,
    mode: 'raise'
  }

  private raycaster = new THREE.Raycaster()
  private mouse = new THREE.Vector2()
  // Reused for cheap ray↔height-plane picking (avoids full-mesh raycasts).
  private pickPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  private pickPoint = new THREE.Vector3()
  private isMouseDown = false
  private isActive = false
  
  // Brush state for better flatten behavior
  private flattenHeight: number = 0
  // @ts-ignore - State tracking for future brush functionality  
  private _brushStarted = false

  // Brush preview
  private brushPreview: THREE.Mesh | null = null
  private scene: THREE.Scene | null = null

  // Affected region tracking for optimized updates
  private affectedRegion: { minX: number; maxX: number; minZ: number; maxZ: number } | null = null
  private isHighResolution: boolean = false

  public setTerrain(terrain: THREE.Mesh, heightData: Float32Array, resolution: number): void {
    this.terrain = terrain
    this.heightData = heightData.slice() // Make a copy
    this._originalHeightData = heightData.slice() // Keep original for reference
    this.resolution = resolution
    this.scene = terrain.parent as THREE.Scene
    
    // Detect high resolution for optimizations
    this.isHighResolution = resolution >= 512
    if (this.isHighResolution) {
      console.log(`High resolution terrain detected (${resolution}x${resolution}) - brush optimizations enabled`)
    }
    
    // Calculate terrain size from geometry
    const geometry = terrain.geometry as THREE.PlaneGeometry
    this.terrainSize = geometry.parameters.width
    
    this.createBrushPreview()
  }

  private createBrushPreview(): void {
    if (this.brushPreview) {
      this.scene?.remove(this.brushPreview)
      this.brushPreview.geometry.dispose()
      ;(this.brushPreview.material as THREE.Material).dispose()
    }

    const geometry = new THREE.RingGeometry(0, this.brushSettings.size, 32)
    
    // Different color for mountain mode
    const color = this.brushSettings.mode === 'mountain' ? 0x8B4513 : 0xff6600
    const material = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.4,
      side: THREE.DoubleSide
    })

    this.brushPreview = new THREE.Mesh(geometry, material)
    this.brushPreview.rotation.x = -Math.PI / 2
    this.brushPreview.visible = false
    
    if (this.scene) {
      this.scene.add(this.brushPreview)
    }
  }

  public setBrushSettings(settings: Partial<BrushSettings>): void {
    this.brushSettings = { ...this.brushSettings, ...settings }
    
    if ((settings.size || settings.mode) && this.brushPreview) {
      this.createBrushPreview()
    }
  }

  public getBrushSettings(): BrushSettings {
    return { ...this.brushSettings }
  }

  public applyMountainPreset(presetKey: string): void {
    const preset = MOUNTAIN_PRESETS[presetKey]
    if (preset) {
      this.setBrushSettings({
        mode: 'mountain',
        size: preset.size,
        strength: preset.strength,
        mountainPreset: preset
      })
    }
  }

  public getHeightData(): Float32Array {
    return this.heightData || new Float32Array(0)
  }

  public setActive(active: boolean): void {
    this.isActive = active
    if (this.brushPreview) {
      this.brushPreview.visible = active
    }
  }

  public handleMouseDown(event: MouseEvent, camera: THREE.Camera, canvas: HTMLCanvasElement): void {
    if (!this.isActive) return
    
    this.isMouseDown = true
    this._brushStarted = true
    this.updateMousePosition(event, canvas)
    
    // For flatten mode, set the target height based on the center point
    if (this.brushSettings.mode === 'flatten') {
      this.setFlattenHeight(camera)
    }
    
    this.applyBrush(camera)
  }

  public handleMouseMove(event: MouseEvent, camera: THREE.Camera, canvas: HTMLCanvasElement): void {
    if (!this.isActive) return
    
    this.updateMousePosition(event, canvas)
    this.updateBrushPreview(camera)
    
    if (this.isMouseDown) {
      this.applyBrush(camera)
    }
  }

  public handleMouseUp(): void {
    this.isMouseDown = false
    this._brushStarted = false
    // Normals are maintained per-region during the stroke (recomputeNormalsInRegion),
    // so no full-mesh recompute is needed here.
  }

  private updateMousePosition(event: MouseEvent, canvas: HTMLCanvasElement): void {
    const rect = canvas.getBoundingClientRect()
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
  }

  /**
   * Find the terrain point under the cursor without a full-mesh raycast. The
   * terrain is a heightfield, so we intersect the camera ray with a horizontal
   * plane and refine it once against the sampled surface height — O(1) instead of
   * testing every triangle.
   */
  private getSurfacePoint(camera: THREE.Camera): THREE.Vector3 | null {
    if (!this.terrain || !this.heightData) return null

    this.raycaster.setFromCamera(this.mouse, camera)
    const ray = this.raycaster.ray
    const baseY = this.terrain.position.y

    this.pickPlane.normal.set(0, 1, 0)
    this.pickPlane.constant = -baseY
    if (!ray.intersectPlane(this.pickPlane, this.pickPoint)) return null

    // Refine: re-intersect against a plane at the actual surface height there.
    for (let iter = 0; iter < 2; iter++) {
      const { index } = this.worldToCell(this.pickPoint)
      this.pickPlane.constant = -(this.heightData[index] + baseY)
      if (!ray.intersectPlane(this.pickPlane, this.pickPoint)) break
    }
    return this.pickPoint
  }

  /** Map a world-space point to the nearest heightmap cell (clamped to bounds). */
  private worldToCell(world: THREE.Vector3): { x: number; z: number; index: number } {
    const halfSize = this.terrainSize / 2
    const res = this.resolution
    const x = Math.max(0, Math.min(res - 1, Math.floor(((world.x + halfSize) / this.terrainSize) * res)))
    const z = Math.max(0, Math.min(res - 1, Math.floor(((world.z + halfSize) / this.terrainSize) * res)))
    return { x, z, index: z * res + x }
  }

  private updateBrushPreview(camera: THREE.Camera): void {
    if (!this.terrain || !this.brushPreview) return

    const point = this.getSurfacePoint(camera)
    if (point) {
      this.brushPreview.position.copy(point)
      this.brushPreview.position.y += 0.5 // Slightly above terrain
      this.brushPreview.visible = true
    } else {
      this.brushPreview.visible = false
    }
  }

  private setFlattenHeight(camera: THREE.Camera): void {
    if (!this.terrain || !this.heightData) return

    const point = this.getSurfacePoint(camera)
    if (!point) return

    // Set flatten height to the height at the center point where the mouse clicked
    this.flattenHeight = this.heightData[this.worldToCell(point).index]
  }

  private applyBrush(camera: THREE.Camera): void {
    if (!this.terrain || !this.heightData) return

    const point = this.getSurfacePoint(camera)
    if (!point) return

    const { x, z } = this.worldToCell(point)
    this.modifyHeightmap(x, z)
    this.updateTerrainMesh()
  }

  private modifyHeightmap(centerX: number, centerZ: number): void {
    if (!this.heightData) return

    const brushRadius = (this.brushSettings.size / this.terrainSize) * this.resolution
    const baseStrength = this.brushSettings.strength * 1.5 // Base strength multiplier

    // Track affected region for optimized mesh updates
    const minX = Math.max(0, centerX - Math.ceil(brushRadius))
    const maxX = Math.min(this.resolution - 1, centerX + Math.ceil(brushRadius))
    const minZ = Math.max(0, centerZ - Math.ceil(brushRadius))
    const maxZ = Math.min(this.resolution - 1, centerZ + Math.ceil(brushRadius))

    // Store affected region for selective mesh updates
    if (this.isHighResolution) {
      this.affectedRegion = { minX, maxX, minZ, maxZ }
    }

    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        
        const distance = Math.sqrt((x - centerX) ** 2 + (z - centerZ) ** 2)
        if (distance > brushRadius) continue

        // Improved falloff with smoother curve
        const normalizedDistance = distance / brushRadius
        const falloff = Math.pow(1 - normalizedDistance, 2.2) // Smooth, more natural falloff
        const effectiveStrength = baseStrength * falloff

        const index = z * this.resolution + x
        const currentHeight = this.heightData[index]

        switch (this.brushSettings.mode) {
          case 'raise':
            this.heightData[index] = currentHeight + effectiveStrength
            break
            
          case 'lower':
            this.heightData[index] = currentHeight - effectiveStrength
            break
            
          case 'smooth':
            const smoothedHeight = this.getSmoothedHeight(x, z)
            this.heightData[index] = this.lerp(currentHeight, smoothedHeight, effectiveStrength * 0.3)
            break
            
          case 'flatten':
            // Move towards the flatten height with improved interpolation
            const heightDiff = this.flattenHeight - currentHeight
            this.heightData[index] = currentHeight + heightDiff * effectiveStrength * 0.4
            break

          case 'mountain':
            if (this.brushSettings.mountainPreset) {
              const mountainHeight = this.generateMountainHeight(x, z, centerX, centerZ, distance, brushRadius)
              // Gentle mountain building with proper scaling
              if (mountainHeight > 0.1) { // Only apply if meaningful height
                const blendFactor = effectiveStrength * 0.4 // Reduced blend factor
                const newHeight = currentHeight + mountainHeight * blendFactor
                // Smooth blending - allow small decreases for natural terrain flow
                const heightDifference = newHeight - currentHeight
                if (heightDifference > -2) { // Prevent major lowering, allow minor adjustments
                  this.heightData[index] = newHeight
                } else {
                  this.heightData[index] = currentHeight // Keep original if too much lowering
                }
              }
            }
            break
        }

        // Clamp height values to reasonable bounds - greatly increased range
        this.heightData[index] = Math.max(-2000, Math.min(5000, this.heightData[index]))
      }
    }
  }

  private generateMountainHeight(x: number, z: number, _centerX: number, _centerZ: number, distance: number, brushRadius: number): number {
    if (!this.brushSettings.mountainPreset) return 0

    const preset = this.brushSettings.mountainPreset
    const normalizedDistance = distance / brushRadius

    // Convert to world coordinates for consistent noise
    const worldX = (x / this.resolution) * 2.0 - 1.0
    const worldZ = (z / this.resolution) * 2.0 - 1.0

    // Base mountain height using multiple noise layers
    let mountainHeight = 0
    let amplitude = preset.strength * 60
    let frequency = preset.frequency

    for (let i = 0; i < preset.octaves; i++) {
      // Use proper sine/cosine noise for mountain generation
      const nx = worldX * frequency * 10
      const nz = worldZ * frequency * 10
      
      let noise = 0
      if (preset.type === 'alpine') {
        // Sharp alpine ridges
        const ridge1 = Math.abs(Math.sin(nx) * Math.cos(nz * 0.7))
        const ridge2 = Math.abs(Math.cos(nx * 1.3) * Math.sin(nz * 1.1))
        noise = Math.pow(1.0 - (ridge1 + ridge2) * 0.5, preset.ridgeSharpness)
      } else {
        // Desert mesa formations
        const base = Math.sin(nx) * Math.cos(nz) + Math.cos(nx * 0.7) * Math.sin(nz * 1.2)
        noise = Math.abs(base)
      }
      
      mountainHeight += noise * amplitude
      amplitude *= preset.persistence
      frequency *= 2.0
    }

    // Apply smooth distance falloff
    const falloff = Math.pow(1.0 - Math.min(1.0, normalizedDistance), 2.0)
    
    return mountainHeight * falloff
  }

  private getSmoothedHeight(x: number, z: number): number {
    if (!this.heightData) return 0

    let totalHeight = 0
    let totalWeight = 0

    // Sample a 5x5 neighborhood with gaussian-like weighting
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx
        const nz = z + dz
        
        if (nx >= 0 && nx < this.resolution && nz >= 0 && nz < this.resolution) {
          const distance = Math.sqrt(dx * dx + dz * dz)
          const weight = Math.exp(-distance * distance * 0.3) // Gaussian-like weight
          
          totalHeight += this.heightData[nz * this.resolution + nx] * weight
          totalWeight += weight
        }
      }
    }

    return totalWeight > 0 ? totalHeight / totalWeight : this.heightData[z * this.resolution + x]
  }

  private lerp(a: number, b: number, t: number): number {
    return a + (b - a) * Math.max(0, Math.min(1, t))
  }

  private updateTerrainMesh(): void {
    if (!this.terrain || !this.heightData) return

    if (this.isHighResolution) {
      // Use optimized update for high resolution
      this.updateTerrainMeshOptimized()
    } else {
      // Use standard update for lower resolution
      this.updateTerrainMeshStandard()
    }
  }

  private updateTerrainMeshStandard(): void {
    if (!this.terrain || !this.heightData) return

    const geometry = this.terrain.geometry as THREE.PlaneGeometry
    const vertices = geometry.attributes.position.array as Float32Array

    // Update vertex heights (Z coordinate before rotation)
    for (let i = 0; i < this.heightData.length; i++) {
      vertices[i * 3 + 2] = this.heightData[i]
    }

    geometry.attributes.position.needsUpdate = true
    geometry.computeVertexNormals()
    
    this.updateMaterialHeightRange()
  }

  private updateTerrainMeshOptimized(): void {
    if (!this.terrain || !this.heightData) return

    const geometry = this.terrain.geometry as THREE.PlaneGeometry
    const positionAttr = geometry.attributes.position
    const normalAttr = geometry.attributes.normal
    const vertices = positionAttr.array as Float32Array

    if (this.affectedRegion) {
      const region = this.affectedRegion
      this.updateVerticesInRegion(vertices, region)

      // Recompute normals analytically for just the brushed band — cheap enough to
      // do live every frame, so lighting stays correct without a full recompute.
      this.recomputeNormalsInRegion(normalAttr.array as Float32Array, region)

      // Only re-upload the affected band of rows instead of the whole buffer.
      const z0 = Math.max(0, region.minZ - 1)
      const z1 = Math.min(this.resolution - 1, region.maxZ + 1)
      this.setBandUpdateRange(positionAttr, z0, z1)
      this.setBandUpdateRange(normalAttr, z0, z1)
      normalAttr.needsUpdate = true

      this.affectedRegion = null
    } else {
      // Fallback: full update (e.g. mountain preset without a tracked region).
      this.updateVerticesChunked(vertices)
      geometry.computeVertexNormals()
    }

    positionAttr.needsUpdate = true
    this.updateMaterialHeightRange()
  }

  private updateVerticesInRegion(vertices: Float32Array, region: { minX: number; maxX: number; minZ: number; maxZ: number }): void {
    if (!this.heightData) return

    const { minX, maxX, minZ, maxZ } = region

    for (let z = Math.max(0, minZ); z <= Math.min(this.resolution - 1, maxZ); z++) {
      for (let x = Math.max(0, minX); x <= Math.min(this.resolution - 1, maxX); x++) {
        const index = z * this.resolution + x
        vertices[index * 3 + 2] = this.heightData[index]
      }
    }
  }

  /**
   * Recompute vertex normals for the brushed region (plus a 1-cell border) from
   * the heightfield gradient, in the geometry's local space. Much cheaper than a
   * full computeVertexNormals() and scales with brush size, not terrain size.
   */
  private recomputeNormalsInRegion(normals: Float32Array, region: { minX: number; maxX: number; minZ: number; maxZ: number }): void {
    if (!this.heightData) return

    const res = this.resolution
    const h = this.heightData
    const step = this.terrainSize / (res - 1)

    const x0 = Math.max(0, region.minX - 1)
    const x1 = Math.min(res - 1, region.maxX + 1)
    const z0 = Math.max(0, region.minZ - 1)
    const z1 = Math.min(res - 1, region.maxZ + 1)

    for (let z = z0; z <= z1; z++) {
      const zu = z > 0 ? z - 1 : z
      const zd = z < res - 1 ? z + 1 : z
      const dz = (zd - zu) * step
      for (let x = x0; x <= x1; x++) {
        const xl = x > 0 ? x - 1 : x
        const xr = x < res - 1 ? x + 1 : x
        const dx = (xr - xl) * step

        const dhdx = dx > 0 ? (h[z * res + xr] - h[z * res + xl]) / dx : 0
        const dhdz = dz > 0 ? (h[zd * res + x] - h[zu * res + x]) / dz : 0

        // Local heightfield normal (the plane's local Y runs opposite grid Z).
        let nx = -dhdx
        let ny = dhdz
        let nz = 1
        const inv = 1 / Math.hypot(nx, ny, nz)
        nx *= inv; ny *= inv; nz *= inv

        const i = (z * res + x) * 3
        normals[i] = nx
        normals[i + 1] = ny
        normals[i + 2] = nz
      }
    }
  }

  /** Flag only the given band of rows for GPU re-upload (falls back to full upload if unsupported). */
  private setBandUpdateRange(attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, z0: number, z1: number): void {
    const anyAttr = attr as any
    if (typeof anyAttr.clearUpdateRanges !== 'function' || typeof anyAttr.addUpdateRange !== 'function') return
    const itemSize = attr.itemSize
    const start = z0 * this.resolution * itemSize
    const count = ((z1 + 1) * this.resolution - z0 * this.resolution) * itemSize
    anyAttr.clearUpdateRanges()
    anyAttr.addUpdateRange(start, count)
  }

  private updateVerticesChunked(vertices: Float32Array): void {
    if (!this.heightData) return

    // Process in chunks to avoid blocking the main thread
    const chunkSize = 4096
    let processed = 0

    const processChunk = () => {
      const end = Math.min(processed + chunkSize, this.heightData!.length)
      
      for (let i = processed; i < end; i++) {
        vertices[i * 3 + 2] = this.heightData![i]
      }
      
      processed = end
      
      if (processed < this.heightData!.length) {
        // Continue processing in next frame
        requestAnimationFrame(processChunk)
      }
    }

    processChunk()
  }

  private updateMaterialHeightRange(): void {
    if (!this.terrain || !this.heightData) return

    // Update material height range for texture splatting (avoid spread operator for large arrays)
    if (this.terrain.material && 'uniforms' in this.terrain.material) {
      const { minHeight, maxHeight } = this.calculateHeightRange()
      const material = this.terrain.material as THREE.ShaderMaterial
      if (material.uniforms.minHeight && material.uniforms.maxHeight) {
        material.uniforms.minHeight.value = minHeight
        material.uniforms.maxHeight.value = maxHeight
      }
    }
  }

  private calculateHeightRange(): { minHeight: number; maxHeight: number } {
    if (!this.heightData || this.heightData.length === 0) {
      return { minHeight: 0, maxHeight: 0 }
    }

    let minHeight = Infinity
    let maxHeight = -Infinity

    // Process in chunks to avoid blocking on very large arrays
    const chunkSize = 8192
    for (let start = 0; start < this.heightData.length; start += chunkSize) {
      const end = Math.min(start + chunkSize, this.heightData.length)
      
      for (let i = start; i < end; i++) {
        const height = this.heightData[i]
        if (height < minHeight) minHeight = height
        if (height > maxHeight) maxHeight = height
      }
    }

    return { minHeight, maxHeight }
  }

  public updateTerrainColors(): void {
    if (!this.terrain || !this.heightData) return

    const geometry = this.terrain.geometry as THREE.PlaneGeometry
    
    // Update vertex colors based on new heights (avoid spread operator for large arrays)
    const colors = geometry.attributes.color.array as Float32Array
    const { minHeight, maxHeight } = this.calculateHeightRange()
    
    for (let i = 0; i < this.heightData.length; i++) {
      const normalizedHeight = maxHeight > minHeight ? 
        (this.heightData[i] - minHeight) / (maxHeight - minHeight) : 0.5
      const color = this.calculateTerrainColor(normalizedHeight, this.heightData[i])
      
      colors[i * 3] = color.r     // R
      colors[i * 3 + 1] = color.g // G
      colors[i * 3 + 2] = color.b // B
    }

    geometry.attributes.color.needsUpdate = true
  }

  private calculateTerrainColor(normalizedHeight: number, _height: number): { r: number, g: number, b: number } {
    // Define terrain height thresholds and colors
    const soilColor = { r: 0.4, g: 0.3, b: 0.15 }    // Brown soil
    const grassColor = { r: 0.3, g: 0.6, b: 0.2 }    // Green grass
    const rockColor = { r: 0.5, g: 0.45, b: 0.4 }    // Gray rock
    const snowColor = { r: 0.9, g: 0.95, b: 1.0 }    // White snow
    
    // Height thresholds (normalized 0-1)
    const grassStart = 0.1   // Grass starts above soil level
    const rockStart = 0.6    // Rock starts at higher elevations
    const snowStart = 0.85   // Snow appears at highest peaks
    
    // Transition smoothness
    const transitionWidth = 0.08
    
    let finalColor = { ...soilColor }
    
    // Soil to Grass transition
    if (normalizedHeight > grassStart - transitionWidth) {
      const grassBlend = this.smoothstep(grassStart - transitionWidth, grassStart + transitionWidth, normalizedHeight)
      finalColor = this.mixColors(soilColor, grassColor, grassBlend)
    }
    
    // Grass to Rock transition
    if (normalizedHeight > rockStart - transitionWidth) {
      const rockBlend = this.smoothstep(rockStart - transitionWidth, rockStart + transitionWidth, normalizedHeight)
      finalColor = this.mixColors(finalColor, rockColor, rockBlend)
    }
    
    // Rock to Snow transition
    if (normalizedHeight > snowStart - transitionWidth) {
      const snowBlend = this.smoothstep(snowStart - transitionWidth, snowStart + transitionWidth, normalizedHeight)
      finalColor = this.mixColors(finalColor, snowColor, snowBlend)
    }
    
    // Add slight height-based lighting variation
    const lightingFactor = 0.85 + normalizedHeight * 0.3
    
    return {
      r: Math.min(1.0, finalColor.r * lightingFactor),
      g: Math.min(1.0, finalColor.g * lightingFactor),
      b: Math.min(1.0, finalColor.b * lightingFactor)
    }
  }
  
  private smoothstep(edge0: number, edge1: number, x: number): number {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
    return t * t * (3 - 2 * t)
  }
  
  private mixColors(
    color1: { r: number, g: number, b: number }, 
    color2: { r: number, g: number, b: number }, 
    factor: number
  ): { r: number, g: number, b: number } {
    return {
      r: color1.r + (color2.r - color1.r) * factor,
      g: color1.g + (color2.g - color1.g) * factor,
      b: color1.b + (color2.b - color1.b) * factor
    }
  }

  public update(camera: THREE.Camera): void {
    // Update brush preview if active but not brushing
    if (this.isActive && !this.isMouseDown) {
      this.updateBrushPreview(camera)
    }
  }

  /**
   * Get performance info for the current terrain
   */
  public getPerformanceInfo(): { isHighResolution: boolean; resolution: number } {
    return {
      isHighResolution: this.isHighResolution,
      resolution: this.resolution
    }
  }
} 