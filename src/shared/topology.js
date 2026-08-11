import * as THREE from 'three';

/**
 * 校验拓扑数据结构是否合法。
 * 合并自 SceneManager._isValidTopology 与 Persistence._isValidTopology 的重复实现，
 * 取两者并集（含 materialIndices 校验），对合法编辑数据行为保持等价。
 */
export function isValidTopology(topology) {
  if (!topology || !Array.isArray(topology.vertices) || !Array.isArray(topology.indices)) return false;
  if (topology.vertices.length === 0 || topology.indices.length < 3 || topology.indices.length % 3 !== 0) return false;
  if (topology.vertices.some(v => !Array.isArray(v) || v.length < 3 || v.slice(0, 3).some(n => !Number.isFinite(n)))) return false;
  if (topology.indices.some(i => !Number.isInteger(i) || i < 0 || i >= topology.vertices.length)) return false;
  if (topology.uv != null && (!Array.isArray(topology.uv) || topology.uv.length !== topology.vertices.length * 2 || topology.uv.some(value => !Number.isFinite(value)))) return false;
  if (topology.materialIndices != null && (!Array.isArray(topology.materialIndices) || topology.materialIndices.length !== topology.indices.length / 3 || topology.materialIndices.some(index => !Number.isInteger(index) || index < 0))) return false;
  return !topology.groups || (Array.isArray(topology.groups) && topology.groups.every(g => Number.isInteger(g.start) && Number.isInteger(g.count) && g.start >= 0 && g.count >= 0 && g.start + g.count <= topology.indices.length && Number.isInteger(g.materialIndex) && g.materialIndex >= 0));
}

/**
 * 将拓扑数据写回 BufferGeometry（positions/indices/uv/groups + 计算法线与包围盒）。
 * 抽自 Commands.applyTopology 与 SceneManager.applyObjectData 的完全一致代码块。
 * M5：并入 materialIndices 分支（原 SceneManager.applyTopologyData 内联逻辑），
 * 并将实际写入的 group 列表返回，供调用方同步存储拓扑的 groups。
 *
 * @returns {Array<{start:number,count:number,materialIndex:number}>} 实际写入的 group 列表
 */
export function writeTopologyToGeometry(geometry, topology) {
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(topology.vertices.flat()), 3));
  geometry.setIndex(topology.indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  if (topology.uv?.length === topology.vertices.length * 2) {
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(topology.uv), 2));
  } else {
    geometry.deleteAttribute('uv');
  }
  const indexCount = topology.indices.length;
  const groups = [];
  if (Array.isArray(topology.materialIndices)) {
    let current = null;
    topology.materialIndices.forEach((materialIndex, faceId) => {
      if (!current || current.materialIndex !== materialIndex) {
        if (current) groups.push(current);
        current = { start: faceId * 3, count: 3, materialIndex };
      } else {
        current.count += 3;
      }
    });
    if (current) groups.push({ ...current, count: Math.min(current.count, indexCount - current.start) });
  } else {
    (topology.groups || []).forEach(group => {
      const start = Math.min(group.start, indexCount);
      const count = Math.min(group.count, indexCount - start);
      if (count > 0) groups.push({ start, count, materialIndex: group.materialIndex });
    });
  }
  geometry.clearGroups();
  groups.forEach(group => geometry.addGroup(group.start, group.count, group.materialIndex));
  return groups;
}

/**
 * 由拓扑数据构建一个新的 BufferGeometry（positions/indices/uv/groups + 法线与包围盒）。
 * 抽自 _createExternalMesh 与 restoreSceneData topology 回退分支的重复代码，
 * 内部复用 writeTopologyToGeometry 保证与既有写入逻辑行为一致。
 *
 * @param {*} topology 合法拓扑数据（不合法返回 null）
 * @returns {THREE.BufferGeometry|null}
 */
export function buildTopologyGeometry(topology) {
  if (!isValidTopology(topology)) return null;
  const geometry = new THREE.BufferGeometry();
  writeTopologyToGeometry(geometry, topology);
  return geometry;
}