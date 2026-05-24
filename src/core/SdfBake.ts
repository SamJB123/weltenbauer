import * as THREE from 'three/webgpu'

/**
 * Bake a signed-distance volume from a (closed-ish) mesh using its three-mesh-bvh
 * BVH. For each voxel we query the nearest surface point (`closestPointToPoint`)
 * for the unsigned distance, and take the sign from the closest triangle's normal:
 * if (voxel − closestPoint) points against the outward face normal, the voxel is
 * inside the solid (negative distance).
 *
 * This gives a consumer engine a distance field for cheap distance-based soft
 * shadows / AO / collision. The volume is in the mesh's LOCAL space, so a consumer
 * transforms a world point into the mesh's frame to sample it.
 */

export interface SdfVolume {
  data: Uint16Array          // float16 signed distances, x-fastest
  dims: [number, number, number]
  min: [number, number, number]  // local-space bounds min (voxel grid origin)
  size: [number, number, number] // local-space bounds size
}

export async function bakeSdfVolume(
  mesh: THREE.Mesh,
  res: number,
  onProgress?: (fraction: number) => void
): Promise<SdfVolume> {
  const geom = mesh.geometry as THREE.BufferGeometry
  const bvh = (geom as any).boundsTree
  if (!bvh) throw new Error('Mesh has no BVH (boundsTree) to bake from.')

  geom.computeBoundingBox()
  const bb = geom.boundingBox!.clone()
  const size = new THREE.Vector3()
  bb.getSize(size)
  bb.min.sub(size.clone().multiplyScalar(0.04)) // small pad so the surface isn't on the edge
  bb.max.add(size.clone().multiplyScalar(0.04))
  const min = bb.min.clone()
  bb.getSize(size)

  const nx = res, ny = res, nz = res
  const data = new Uint16Array(nx * ny * nz)

  const posAttr = geom.attributes.position
  const index = geom.index
  const target: { point?: THREE.Vector3; distance: number; faceIndex: number } = { distance: 0, faceIndex: 0 }
  const p = new THREE.Vector3()
  const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3()
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nrm = new THREE.Vector3(), dlt = new THREE.Vector3()

  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        p.set(
          min.x + ((x + 0.5) / nx) * size.x,
          min.y + ((y + 0.5) / ny) * size.y,
          min.z + ((z + 0.5) / nz) * size.z
        )
        bvh.closestPointToPoint(p, target)
        let d = target.distance

        // Sign from the closest face's outward normal.
        const fi = target.faceIndex
        const i0 = index ? index.getX(fi * 3) : fi * 3
        const i1 = index ? index.getX(fi * 3 + 1) : fi * 3 + 1
        const i2 = index ? index.getX(fi * 3 + 2) : fi * 3 + 2
        va.fromBufferAttribute(posAttr, i0)
        vb.fromBufferAttribute(posAttr, i1)
        vc.fromBufferAttribute(posAttr, i2)
        e1.subVectors(vb, va); e2.subVectors(vc, va); nrm.crossVectors(e1, e2)
        if (target.point) dlt.copy(p).sub(target.point)
        if (dlt.dot(nrm) < 0) d = -d // inside the solid

        data[z * ny * nx + y * nx + x] = THREE.DataUtils.toHalfFloat(d)
      }
    }
    if (onProgress) onProgress((z + 1) / nz)
    await new Promise(r => setTimeout(r, 0)) // yield per slice so the tab stays responsive
  }

  return {
    data,
    dims: [nx, ny, nz],
    min: [min.x, min.y, min.z],
    size: [size.x, size.y, size.z]
  }
}
