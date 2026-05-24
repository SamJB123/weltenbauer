import * as THREE from 'three/webgpu'
import { storage, wgslFn, instanceIndex, uniform } from 'three/tsl'

// `storage(attr, type, count)` accepts a type string at runtime (incl. custom WGSL
// struct names like 'BVHNode' and 'uvec4'), but the TS types only allow a fixed
// type union / Struct object — so we call it through a loosened signature. Runtime
// behaviour matches three-mesh-bvh's official webgpu_sdfGeneration example.
const storageBuf = storage as unknown as (attr: unknown, type: string, count: number) => any
// three-mesh-bvh's WebGPU BVH closest-point query (wgslFn). Pulling it in as a
// dependency also makes the BVHNode struct + helper fns available in the kernel.
import { closestPointToPoint } from 'three-mesh-bvh/webgpu'

/**
 * GPU signed-distance bake from a mesh's three-mesh-bvh BVH, modeled on the
 * library's official `webgpu_sdfGeneration` example — but writing into a storage
 * buffer (not a 3D texture) so we can read it back to the CPU and export it.
 *
 * Per voxel a compute invocation queries the nearest surface point via
 * `bvhClosestPointToPoint`; signed distance = side * sqrt(distanceSq) (the sign
 * comes from the closest face's normal, built into the query result).
 */

export interface SdfVolume {
  data: Uint16Array              // float16 signed distances, x-fastest (negative = inside)
  dims: [number, number, number]
  min: [number, number, number]  // mesh-local bounds min
  size: [number, number, number] // mesh-local bounds size
}

// Compute kernel: one invocation per voxel, indexed by the global invocation id.
const sdfKernel = wgslFn(/* wgsl */`
  fn computeSdf(
    bvh_index: ptr<storage, array<vec4u>, read>,
    bvh_position: ptr<storage, array<vec4f>, read>,
    bvh: ptr<storage, array<BVHNode>, read>,
    output: ptr<storage, array<f32>, read_write>,
    dims: vec3f,
    boundsMin: vec3f,
    boundsSize: vec3f,
    index: u32
  ) -> void {

    let nx = u32( dims.x );
    let ny = u32( dims.y );
    let nz = u32( dims.z );
    if ( index >= nx * ny * nz ) { return; }

    let x = index % nx;
    let y = ( index / nx ) % ny;
    let z = index / ( nx * ny );

    let uvw = ( vec3f( f32( x ), f32( y ), f32( z ) ) + 0.5 ) / dims;
    let point = boundsMin + uvw * boundsSize;

    let result = bvhClosestPointToPoint( bvh_index, bvh_position, bvh, point, 1e6 );
    output[ index ] = result.side * sqrt( result.distanceSq );

  }
`, [ closestPointToPoint ])

export async function bakeSdfVolumeGPU(
  renderer: any,
  mesh: THREE.Mesh,
  res: number
): Promise<SdfVolume> {
  const geom = mesh.geometry as THREE.BufferGeometry
  const bvh = (geom as any).boundsTree
  if (!bvh) throw new Error('SDF bake: mesh has no BVH (boundsTree).')
  if (!geom.index) throw new Error('SDF bake: geometry must be indexed.')
  if (!bvh._roots || bvh._roots.length !== 1) throw new Error('SDF bake: single-root BVH only.')

  geom.computeBoundingBox()
  const bb = geom.boundingBox!.clone()
  const size = new THREE.Vector3()
  bb.getSize(size)
  bb.min.sub(size.clone().multiplyScalar(0.04))
  bb.max.add(size.clone().multiplyScalar(0.04))
  const min = bb.min.clone()
  bb.getSize(size)

  const nx = res, ny = res, nz = res
  const count = nx * ny * nz

  // Storage buffers — bvh._roots[0] is already in the BVHNode byte layout (8 f32/node).
  const indexArray = geom.index.array instanceof Uint32Array
    ? geom.index.array
    : new Uint32Array(geom.index.array)
  const geomIndex = new THREE.StorageBufferAttribute(indexArray, 3)
  const geomPos = new THREE.StorageBufferAttribute(geom.attributes.position.array as Float32Array, 3)
  const bvhNodes = new THREE.StorageBufferAttribute(new Float32Array(bvh._roots[0]), 8)
  const outAttr = new THREE.StorageBufferAttribute(new Float32Array(count), 1)

  const node = sdfKernel({
    bvh_index: storageBuf(geomIndex, 'uvec4', geomIndex.count).toReadOnly(),
    bvh_position: storageBuf(geomPos, 'vec4', geomPos.count).toReadOnly(),
    bvh: storageBuf(bvhNodes, 'BVHNode', bvhNodes.count).toReadOnly(),
    output: storageBuf(outAttr, 'float', count),
    dims: uniform(new THREE.Vector3(nx, ny, nz)),
    boundsMin: uniform(min),
    boundsSize: uniform(size),
    index: instanceIndex
  }).compute(count)

  await renderer.computeAsync(node)

  const buffer = await renderer.getArrayBufferAsync(outAttr)
  const floats = new Float32Array(buffer)
  const half = new Uint16Array(count)
  for (let i = 0; i < count; i++) half[i] = THREE.DataUtils.toHalfFloat(floats[i])

  return {
    data: half,
    dims: [nx, ny, nz],
    min: [min.x, min.y, min.z],
    size: [size.x, size.y, size.z]
  }
}
