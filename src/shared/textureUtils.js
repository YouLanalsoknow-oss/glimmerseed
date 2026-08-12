/**
 * 纹理共享工具 — 统一判断某个纹理是否仍被场景中其他对象引用。
 * 合并自 Commands.js 的 _isTextureShared（两处重复）与
 * SceneManager.js 的 _isTextureUsedByOtherObjects 的接近重复实现。
 *
 * @param {Iterable<{mesh: object, data?: {id?: string}}>} records 场景记录的可迭代集合（如 objects.values()）
 * @param {*} texture 待判定的纹理对象
 * @param {string|null} excludedId 需要排除的对象 id（通常为被删除/释放的对象自身）
 * @returns {boolean} 是否仍被其他对象使用
 */
/** 标准贴图槽位 — 仅比较这些属性，避免遍历全部材质属性造成误判与数组分配 */
const TEXTURE_SLOTS = [
  'map', 'normalMap', 'aoMap', 'emissiveMap', 'roughnessMap',
  'metalnessMap', 'bumpMap', 'displacementMap', 'alphaMap', 'lightMap',
];

export function isTextureUsedByAnyOther(records, texture, excludedId = null) {
  if (!records || !texture) return false;
  for (const record of records) {
    if (!record) continue;
    if (excludedId != null && record.data?.id === excludedId) continue;
    let used = false;
    record.mesh?.traverse?.(node => {
      if (used || !node.material) return;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of materials) {
        if (!material) continue;
        for (const slot of TEXTURE_SLOTS) {
          if (material[slot] === texture) { used = true; return; }
        }
      }
    });
    if (used) return true;
  }
  return false;
}