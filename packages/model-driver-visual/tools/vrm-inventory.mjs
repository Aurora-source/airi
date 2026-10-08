import process from 'node:process'

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

async function main() {
  // Read only the selected corpus. Never rewrite an avatar or copy its embedded assets.
  const directory = process.argv[2]
  if (!directory)
    throw new Error('Supply the local VRM corpus directory.')
  const results = []
  for (const name of (await readdir(directory)).filter(name => name.toLowerCase().endsWith('.vrm')).sort()) {
    const bytes = await readFile(join(directory, name))
    if (bytes.readUInt32LE(0) !== 0x46546C67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(16) !== 0x4E4F534A)
      throw new Error('The corpus contains an unsupported GLB file.')
    const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8'))
    const extensions = json.extensions ?? {}
    const one = !!extensions.VRMC_vrm
    const vrm = extensions.VRMC_vrm ?? extensions.VRM
    if (!vrm)
      throw new Error('The corpus contains a model without VRM metadata.')
    const bones = one ? vrm.humanoid.humanBones : Object.fromEntries(vrm.humanoid.humanBones.map(bone => [bone.bone, { node: bone.node }]))
    const expressions = one
      ? [...Object.keys(vrm.expressions?.preset ?? {}), ...Object.keys(vrm.expressions?.custom ?? {})]
      : (vrm.blendShapeMaster?.blendShapeGroups ?? []).map(group => ({ preset: group.presetName, name: group.name, binds: group.binds?.length ?? 0 }))
    const secondary = extensions.VRMC_springBone ?? vrm.secondaryAnimation ?? {}
    const positionAccessors = [...new Set((json.meshes ?? []).flatMap(mesh => mesh.primitives.map(primitive => primitive.attributes?.POSITION)).filter(index => index !== undefined))]
    const bounds = positionAccessors.map(index => json.accessors[index]).filter(accessor => accessor.min && accessor.max)
    results.push({ file: name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, version: one ? vrm.specVersion : vrm.specVersion ?? '0.0', bones, expressions, lookAt: one ? vrm.lookAt : { type: vrm.firstPerson?.lookAtTypeName, horizontalOuter: vrm.firstPerson?.lookAtHorizontalOuter, horizontalInner: vrm.firstPerson?.lookAtHorizontalInner, verticalUp: vrm.firstPerson?.lookAtVerticalUp, verticalDown: vrm.firstPerson?.lookAtVerticalDown }, secondary: { groups: secondary.springs?.length ?? secondary.boneGroups?.length ?? 0, colliders: secondary.colliders?.length ?? secondary.colliderGroups?.length ?? 0 }, nodeScales: (json.nodes ?? []).filter(node => node.scale).map(node => node.scale), meshLocalBounds: bounds.map(accessor => ({ min: accessor.min, max: accessor.max })), animations: (json.animations ?? []).map(animation => ({ name: animation.name, channels: animation.channels?.length ?? 0 })), vrmAnimation: !!extensions.VRMC_vrm_animation })
  }
  console.info(JSON.stringify(results, null, 2))
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
