import * as THREE from 'three';
import { DEFAULT_MATERIAL, TYPE_NAMES, TYPE_ICONS } from '../shared/constants.js';
import { clone, dependencyName } from '../shared/utils.js';
import { isValidTopology, writeTopologyToGeometry, buildTopologyGeometry } from '../shared/topology.js';
import { isTextureUsedByAnyOther } from '../shared/textureUtils.js';
import { createEmitter } from '../shared/events.js';

/**
 * 场景管理层 — 对象树、选择集、纯数据模型、撤销重做栈
 * 数据模型不持有 Three.js 对象引用，方便序列化与未来同步
 */

let _idCounter = 0;
function genId() { return `obj-${Date.now().toString(36)}-${++_idCounter}`; }

// TextureLoader 无状态，模块级复用，避免每次加载都新建实例
const _textureLoader = new THREE.TextureLoader();

export class SceneManager {
  constructor(scene, geometryFactory = null, resourceStore = null) {
    this.scene = scene;
    this.factory = geometryFactory;
    this.resourceStore = resourceStore;
    this.objects = new Map();   // id -> { mesh, data }
    this.selection = new Set(); // set of ids
    Object.assign(this, createEmitter()); // M5: 共享事件实现（on/emit）
    this._undoStack = [];
    this._redoStack = [];
    this._meshList = [];
    this._suppressEvents = false; // M7: 批量恢复期间抑制 objectadded/scenechanged
    this._nameCounter = 0;        // L2: 独立递增的默认命名计数器
  }

  // ===== Object management =====
  addObject(mesh, data) {
    if (!mesh || !data) return null;
    const id = data.id || genId();
    // 防止重复 id 静默覆盖已有对象（与 addExternalObject 行为保持一致）
    if (this.objects.has(id)) return id;
    data.id = id;
    if (!data.name) data.name = this._defaultName(data.type);
    if (!data.transform) {
      data.transform = {
        position: [mesh.position.x, mesh.position.y, mesh.position.z],
        rotation: [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z],
        scale: [mesh.scale.x, mesh.scale.y, mesh.scale.z],
      };
    }
    if (!data.material) {
      data.material = { ...DEFAULT_MATERIAL };
    }
    this.objects.set(id, { mesh, data });
    mesh.userData.sceneObjectId = id;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this._meshList.push(mesh);
    this.scene.add(mesh);
    if (!this._suppressEvents) {
      this.emit('objectadded', { id, data });
      this.emit('scenechanged');
    }
    return id;
  }

  addExternalObject(object, data = {}) {
    if (!object) return null;
    const id = data.id || genId();
    if (this.objects.has(id)) return id;
    const firstMesh = object.isMesh ? object : object.getObjectByProperty?.('isMesh', true);
    const geometry = data.geometry || {};
    if (!geometry.topology && firstMesh?.geometry?.attributes?.position) {
      geometry.topology = this._topologyFromGeometry(firstMesh.geometry);
    }
    if (!geometry.meshes) {
      geometry.meshes = [];
      object.traverse?.(child => {
        if (!child.isMesh) return;
        if (!child.geometry?.attributes?.position) return;
        geometry.meshes.push({
          name: child.name || '',
          topology: this._topologyFromGeometry(child.geometry),
          material: this._serializeMaterial(child.material),
          transform: this._readTransform(child),
        });
      });
    }
    const record = {
      type: 'model',
      name: data.name || object.name || '导入模型',
      geometry,
      material: { ...DEFAULT_MATERIAL },
      transform: this._readTransform(object),
      ...data,
      id,
    };
    data.id = id;
    data.geometry = record.geometry;
    data.transform = record.transform;
    this.objects.set(id, { mesh: object, data: record, external: true });
    object.userData.sceneObjectId = id;
    object.traverse?.(child => {
      if (child.isMesh) {
        child.userData.sceneObjectId = id;
        child.castShadow = true;
        child.receiveShadow = true;
        this._meshList.push(child);
      }
    });
    this.scene.add(object);
    if (!this._suppressEvents) {
      this.emit('objectadded', { id, data: record });
      this.emit('scenechanged');
    }
    return id;
  }

  removeObject(id, { dispose = true } = {}) {
    const obj = this.objects.get(id);
    if (!obj) return;
    const wasSelected = this.selection.has(id);
    this.selection.delete(id);
    this.scene.remove(obj.mesh);
    if (dispose) {
      // 只释放不再被场景中其他对象引用的纹理，避免共享纹理泄漏或误释放。
      const shouldDisposeTexture = (value) => !isTextureUsedByAnyOther(this.objects.values(), value, id);
      if (obj.external) obj.mesh.traverse?.(node => this._disposeNode(node, shouldDisposeTexture));
      else this._disposeNode(obj.mesh, shouldDisposeTexture);
    }
    this.objects.delete(id);
    if (obj.mesh.userData) delete obj.mesh.userData.sceneObjectId;
    if (obj.external) {
      obj.mesh.traverse?.(child => {
        const meshIndex = this._meshList.indexOf(child);
        if (meshIndex !== -1) this._meshList.splice(meshIndex, 1);
      });
    } else {
      const meshIndex = this._meshList.indexOf(obj.mesh);
      if (meshIndex !== -1) this._meshList.splice(meshIndex, 1);
    }
    this.emit('objectremoved', { id });
    if (wasSelected) this.emit('selectionchange', { selection: [...this.selection] });
    this.emit('scenechanged');
  }

  getObject(id) { return this.objects.get(id) || null; }
  getAllObjects() { return [...this.objects.values()].map(o => o.data); }
  get count() { return this.objects.size; }
  get meshes() { return this._meshList; }

  // ===== Selection =====
  selectObject(id, additive = false) {
    if (!additive) this.selection.clear();
    if (id && this.objects.has(id)) this.selection.add(id);
    this.emit('selectionchange', { selection: [...this.selection] });
  }

  deselectAll() {
    if (this.selection.size === 0) return;
    this.selection.clear();
    this.emit('selectionchange', { selection: [] });
  }

  getSelectedObjects() {
    return [...this.selection].map(id => this.objects.get(id)).filter(Boolean);
  }

  getPrimarySelection() {
    for (const id of this.selection) return this.objects.get(id);
    return null;
  }

  // ===== Transform =====
  updateTransform(id, transform) {
    const obj = this.objects.get(id);
    if (!obj) return;
    const m = obj.mesh;
    if (transform.position) m.position.set(transform.position[0] ?? 0, transform.position[1] ?? 0, transform.position[2] ?? 0);
    if (transform.rotation) m.rotation.set(transform.rotation[0] ?? 0, transform.rotation[1] ?? 0, transform.rotation[2] ?? 0);
    if (transform.scale) m.scale.set(transform.scale[0] ?? 1, transform.scale[1] ?? 1, transform.scale[2] ?? 1);
    this._syncData(id);
    this.emit('objectchanged', { id, data: obj.data });
    this.emit('scenechanged');
  }

  syncTransformFromMesh(id) {
    if (!this._syncData(id)) return;
    const obj = this.objects.get(id);
    this.emit('objectchanged', { id, data: obj.data });
    this.emit('scenechanged');
  }

  syncGeometryFromMesh(id, { emit = true } = {}) {
    const obj = this.objects.get(id);
    const mesh = obj?.mesh?.isMesh ? obj.mesh : obj?.mesh?.getObjectByProperty?.('isMesh', true);
    if (!mesh?.geometry?.attributes?.position) return false;
    const geometry = mesh.geometry;
    const position = geometry.attributes.position;
    const index = geometry.index;
    const topology = {
      vertices: Array.from({ length: position.count }, (_, i) => [position.getX(i), position.getY(i), position.getZ(i)]),
      indices: index ? [...index.array] : [...Array(position.count).keys()],
    };
    const uv = geometry.attributes.uv;
    if (uv && uv.count === position.count) topology.uv = [...uv.array];
    topology.groups = geometry.groups.map(group => ({ ...group }));
    obj.data.geometry = { ...(obj.data.geometry || {}), topology };
    if (emit) {
      this.emit('objectchanged', { id, data: obj.data });
      this.emit('scenechanged');
    }
    return true;
  }

  applyTopologyData(id, topology, { emit = true } = {}) {
    const obj = this.objects.get(id);
    const mesh = obj?.mesh?.isMesh ? obj.mesh : obj?.mesh?.getObjectByProperty?.('isMesh', true);
    if (!mesh?.geometry || !isValidTopology(topology)) return false;
    const groups = writeTopologyToGeometry(mesh.geometry, topology);
    // M5: 同步存储拓扑的 groups 为实际写入的 group 列表，避免与 materialIndices 重建结果不一致
    const stored = clone(topology);
    if (groups.length) stored.groups = groups;
    obj.data.geometry = { ...(obj.data.geometry || {}), topology: stored };
    if (emit) {
      this.emit('objectchanged', { id, data: obj.data });
      this.emit('scenechanged');
    }
    return true;
  }

  applyObjectData(id, data) {
    const obj = this.objects.get(id);
    if (!obj || !data) return false;
    const topology = data.geometry?.topology;
    const mesh = obj.mesh?.isMesh ? obj.mesh : obj.mesh?.getObjectByProperty?.('isMesh', true);
    if (isValidTopology(topology) && mesh?.geometry) {
      writeTopologyToGeometry(mesh.geometry, topology);
    }
    Object.assign(obj.data, clone(data));
    this._applyTransformAndMaterial(obj);
    this.emit('objectchanged', { id, data: obj.data });
    this.emit('scenechanged');
    return true;
  }

  _applyTransformAndMaterial(obj) {
    const t = obj.data.transform;
    if (t) {
      obj.mesh.position.set(t.position?.[0] ?? 0, t.position?.[1] ?? 0, t.position?.[2] ?? 0);
      obj.mesh.rotation.set(t.rotation?.[0] ?? 0, t.rotation?.[1] ?? 0, t.rotation?.[2] ?? 0);
      obj.mesh.scale.set(t.scale?.[0] ?? 1, t.scale?.[1] ?? 1, t.scale?.[2] ?? 1);
    }
    const mat = obj.data.material;
    if (mat) obj.mesh.traverse?.(node => {
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.forEach(material => { if (material?.color) material.color.set(mat.color || '#cccccc'); if (material && 'metalness' in material) material.metalness = mat.metalness ?? 0.1; if (material && 'roughness' in material) material.roughness = mat.roughness ?? 0.7; });
    });
  }

  _syncData(id) {
    const obj = this.objects.get(id);
    if (!obj) return false;
    const m = obj.mesh;
    const transform = obj.data.transform || (obj.data.transform = {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    });
    transform.position[0] = m.position.x;
    transform.position[1] = m.position.y;
    transform.position[2] = m.position.z;
    transform.rotation[0] = m.rotation.x;
    transform.rotation[1] = m.rotation.y;
    transform.rotation[2] = m.rotation.z;
    transform.scale[0] = m.scale.x;
    transform.scale[1] = m.scale.y;
    transform.scale[2] = m.scale.z;
    return true;
  }

  // ===== Material =====
  updateMaterial(id, material) {
    const obj = this.objects.get(id);
    if (!obj) return;
    obj.mesh.traverse?.(node => {
      if (!node.material) return;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.forEach(mat => {
        if (material.color && mat.color) mat.color.set(material.color);
        if (material.metalness != null && 'metalness' in mat) mat.metalness = material.metalness;
        if (material.roughness != null && 'roughness' in mat) mat.roughness = material.roughness;
      });
    });
    obj.data.material = { ...obj.data.material, ...material };
    this.emit('objectchanged', { id, data: obj.data });
    this.emit('scenechanged');
  }

  updateName(id, name) {
    const obj = this.objects.get(id);
    if (!obj) return;
    const nextName = String(name ?? '').trim();
    obj.data.name = nextName || this._defaultName(obj.data.type);
    if (obj.mesh?.name !== undefined) obj.mesh.name = obj.data.name;
    this.emit('objectchanged', { id, data: obj.data });
    this.emit('namechanged', { id, name: obj.data.name });
    this.emit('scenechanged');
  }

  _readTransform(object) {
    return {
      position: [object.position?.x ?? 0, object.position?.y ?? 0, object.position?.z ?? 0],
      rotation: [object.rotation?.x ?? 0, object.rotation?.y ?? 0, object.rotation?.z ?? 0],
      scale: [object.scale?.x ?? 1, object.scale?.y ?? 1, object.scale?.z ?? 1],
    };
  }

  _topologyFromGeometry(geometry) {
    const position = geometry.attributes.position;
    const index = geometry.index;
    const topology = {
      vertices: Array.from({ length: position.count }, (_, i) => [position.getX(i), position.getY(i), position.getZ(i)]),
      indices: index ? Array.from(index.array) : [...Array(position.count).keys()],
      groups: geometry.groups.map(group => ({ start: group.start, count: group.count, materialIndex: group.materialIndex })),
    };
    const uv = geometry.attributes.uv;
    if (uv && uv.count === position.count) topology.uv = Array.from(uv.array);
    return topology;
  }

  _serializeMaterial(material) {
    const materials = Array.isArray(material) ? material : [material];
    return materials.filter(Boolean).map(item => ({
      color: item.color?.getHexString?.() ? `#${item.color.getHexString()}` : '#cccccc',
      metalness: 'metalness' in item ? item.metalness : 0.1,
      roughness: 'roughness' in item ? item.roughness : 0.7,
      emissive: item.emissive?.getHexString?.() ? `#${item.emissive.getHexString()}` : '#000000',
      emissiveIntensity: item.emissiveIntensity ?? 1,
      opacity: item.opacity ?? 1,
      transparent: Boolean(item.transparent),
      depthWrite: item.depthWrite ?? true,
      side: item.side ?? THREE.FrontSide,
      wireframe: Boolean(item.wireframe),
      mapResourceId: item.map?.userData?.resourceId || '',
      normalMapResourceId: item.normalMap?.userData?.resourceId || '',
      roughnessMapResourceId: item.roughnessMap?.userData?.resourceId || '',
      metalnessMapResourceId: item.metalnessMap?.userData?.resourceId || '',
    }));
  }

  _createExternalMesh(record) {
    const geo = buildTopologyGeometry(record?.topology);
    if (!geo) return null;
    const materialData = Array.isArray(record.material) ? record.material : [record.material || {}];
    const materials = materialData.map(item => new THREE.MeshStandardMaterial({
      color: item?.color || '#cccccc', metalness: item?.metalness ?? 0.1, roughness: item?.roughness ?? 0.7,
      emissive: item?.emissive || '#000000', emissiveIntensity: item?.emissiveIntensity ?? 1,
      opacity: item?.opacity ?? 1, transparent: Boolean(item?.transparent), depthWrite: item?.depthWrite ?? true,
      side: Number.isInteger(item?.side) ? item.side : THREE.FrontSide, wireframe: Boolean(item?.wireframe),
    }));
    const mesh = new THREE.Mesh(geo, materials.length === 1 ? materials[0] : materials);
    mesh.name = record.name || '';
    const transform = record.transform;
    if (transform) {
      mesh.position.set(transform.position?.[0] ?? 0, transform.position?.[1] ?? 0, transform.position?.[2] ?? 0);
      mesh.rotation.set(transform.rotation?.[0] ?? 0, transform.rotation?.[1] ?? 0, transform.rotation?.[2] ?? 0);
      mesh.scale.set(transform.scale?.[0] ?? 1, transform.scale?.[1] ?? 1, transform.scale?.[2] ?? 1);
    }
    return mesh;
  }

  // ===== H1: 贴图资源恢复 =====
  /** 依据序列化材质中的 *MapResourceId 异步取回纹理并挂接到对应材质。
   *  alive 用于加载期间对象被删除/整体 disposition 时中止，避免挂到已释放材质造成泄漏。 */
  async _loadMaterialTexture(material, prop, resourceId, alive = () => true) {
    if (!resourceId || !this.resourceStore || !material) return;
    let record;
    try { record = await this.resourceStore.get(resourceId); } catch (_) { return; }
    if (!record?.blob) return;
    const url = URL.createObjectURL(record.blob);
    try {
      const texture = await _textureLoader.loadAsync(url);
      if (!alive()) { texture.dispose(); return; } // 加载期间对象已释放，丢弃纹理
      texture.userData.resourceId = resourceId;
      // L2: 赋值前释放同通道旧纹理，避免重复挂载泄漏 GPU 资源
      if (material[prop]?.isTexture) material[prop].dispose();
      material[prop] = texture;
      material.needsUpdate = true;
    } catch (error) {
      console.warn('[SceneManager] texture restore failed:', error);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** 为网格的所有材质按序列化材质数据补挂 map/normalMap/roughnessMap/metalnessMap */
  _attachMaterialTextures(mesh, materialData) {
    if (!mesh || !this.resourceStore) return;
    const list = Array.isArray(materialData) ? materialData : materialData ? [materialData] : [];
    if (!list.length) return;
    const objectId = mesh.userData?.sceneObjectId;
    const alive = () => this.scene != null && (!objectId || this.objects.has(objectId));
    const tasks = [];
    mesh.traverse?.(node => {
      if (!node.material) return;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.forEach((material, index) => {
        // L5: 该槽位串行化材质数 > list 长度时，跳过挂图避免与 list[0] 错配
        if (index >= list.length) return;
        const value = list[index] ?? list[0];
        if (!value || !material) return;
        tasks.push(this._loadMaterialTexture(material, 'map', value.mapResourceId, alive));
        tasks.push(this._loadMaterialTexture(material, 'normalMap', value.normalMapResourceId, alive));
        tasks.push(this._loadMaterialTexture(material, 'roughnessMap', value.roughnessMapResourceId, alive));
        tasks.push(this._loadMaterialTexture(material, 'metalnessMap', value.metalnessMapResourceId, alive));
      });
    });
    return Promise.all(tasks).catch(() => undefined);
  }

  // ===== Serialization
  /** H2: 收集场景对象已引用的全部资源 id（供 io/Persistence.js 的 _doSave 合并保留集使用）。
   *  遍历每个对象的 data：sourceResourceId、sourceResources[].id，
   *  以及各材质（material 可能是数组或对象）上的 mapResourceId/normalMapResourceId/
   *  roughnessMapResourceId/metalnessMapResourceId。过滤 undefined/null/空串。 */
  getReferencedResourceIds() {
    const ids = new Set();
    const push = (id) => { if (id != null && id !== '') ids.add(id); };
    for (const { data } of this.objects.values()) {
      if (!data) continue;
      push(data.sourceResourceId);
      if (Array.isArray(data.sourceResources)) {
        for (const res of data.sourceResources) push(res?.id);
      }
      const materials = Array.isArray(data.material) ? data.material
        : data.material ? [data.material] : [];
      for (const m of materials) {
        if (!m) continue;
        push(m.mapResourceId);
        push(m.normalMapResourceId);
        push(m.roughnessMapResourceId);
        push(m.metalnessMapResourceId);
      }
    }
    return ids;
  }

  getSceneData() {
    return {
      version: 1,
      objects: [...this.objects.values()].map(o => clone(o.data)),
    };
  }

  async restoreSceneData(data) {
    if (!data || !Array.isArray(data.objects)) return;
    // 批量清除 — 释放 GPU 资源但不逐个触发事件，避免 N 次冗余 emit
    this._disposeAllObjects();
    // M7: 批量恢复期间抑制 objectadded/scenechanged，结束后统一 emit 一次
    const prevSuppress = this._suppressEvents;
    this._suppressEvents = true;
    // Restore each object
    try {
      for (const objData of data.objects) {
        if (!objData || typeof objData !== 'object') continue;
        // M1: “重建 mesh”的多种来源拆分为独立小方法，按优先级串联，降低嵌套深度
        const result = this._restoreFromFactory(objData)
          || await this._restoreFromSource(objData)
          || this._restoreFromExternalMeshes(objData)
          || this._restoreFromTopology(objData);
        if (!result) continue;
        const { mesh, restoredExternal } = result;
        if (restoredExternal) {
          this._finalizeRestoredExternal(mesh, objData);
          continue;
        }
        // 始终应用已保存的拓扑数据，不再检查顶点数是否匹配
        // 编辑操作（挤出/环切/桥接）会改变顶点数，检查会导致编辑数据丢失
        const topology = objData.geometry?.topology;
        if (isValidTopology(topology)) {
          writeTopologyToGeometry(mesh.geometry, topology);
        }
        // Apply saved transform
        const t = objData.transform;
        if (t) {
          mesh.position.set(t.position?.[0] ?? 0, t.position?.[1] ?? 0, t.position?.[2] ?? 0);
          mesh.rotation.set(t.rotation?.[0] ?? 0, t.rotation?.[1] ?? 0, t.rotation?.[2] ?? 0);
          mesh.scale.set(t.scale?.[0] ?? 1, t.scale?.[1] ?? 1, t.scale?.[2] ?? 1);
        }
        // Apply saved material
        const mat = objData.material;
        if (mat) {
          const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          materials.forEach((material, index) => {
            // M2: 用 index 替代 indexOf（O(n²)→O(n)），用 ?? 替代 || 避免 falsy 值错误回退
            const value = Array.isArray(mat) ? (mat[index] ?? mat[0]) : mat;
            material.color?.set(value?.color || '#cccccc');
            material.emissive?.set(value?.emissive || '#000000');
            if ('emissiveIntensity' in material) material.emissiveIntensity = value?.emissiveIntensity ?? 1;
            if ('metalness' in material) material.metalness = value?.metalness ?? 0.1;
            if ('roughness' in material) material.roughness = value?.roughness ?? 0.7;
            if ('opacity' in material) material.opacity = value?.opacity ?? 1;
            if ('transparent' in material) material.transparent = Boolean(value?.transparent);
            if ('depthWrite' in material) material.depthWrite = value?.depthWrite ?? true;
            if (Number.isInteger(value?.side)) material.side = value.side;
            if ('wireframe' in material) material.wireframe = Boolean(value?.wireframe);
            material.needsUpdate = true;
          });
        }
        this.addObject(mesh, clone(objData));
        // H1: 依据 objData.material[*].*MapResourceId 异步补挂贴图
        this._attachMaterialTextures(mesh, objData.material);
      }
    } finally {
      this._suppressEvents = prevSuppress;
      this.emit('scenechanged');
    }
  }

  /** M1: 来源1 — 由 geometryFactory 重建 */
  _restoreFromFactory(objData) {
    // 外部导入模型走 _restoreFromSource/_restoreFromExternalMeshes，提前返回避免打未知类型 warning
    if (objData.type === 'model') return null;
    return this.factory?.create(objData.type, objData.geometry || {}) || null;
  }

  /** M1: 来源2 — 由 sourceResourceId 加载原始模型（OBJ/GLTF） */
  async _restoreFromSource(objData) {
    if (!objData.sourceResourceId || !this.resourceStore) return null;
    const source = await this.resourceStore.get(objData.sourceResourceId).catch(() => null);
    if (!source?.blob) return null;
    const url = URL.createObjectURL(source.blob);
    try {
      const ext = (objData.sourceName || source.name || '').toLowerCase().split('.').pop();
      const dependencyUrls = new Map();
      try {
        for (const dependency of objData.sourceResources || []) {
          const record = await this.resourceStore.get(dependency.id).catch(() => null);
          if (record?.blob) dependencyUrls.set(dependencyName(dependency.name), URL.createObjectURL(record.blob));
        }
        if (ext === 'obj') {
          const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
          const loader = new OBJLoader();
          const mtl = (objData.sourceResources || []).find(item => /\.mtl$/i.test(item.name));
          if (mtl) {
            const mtlUrl = dependencyUrls.get(dependencyName(mtl.name));
            if (mtlUrl) {
              const { MTLLoader } = await import('three/addons/loaders/MTLLoader.js');
              const materials = await new MTLLoader().loadAsync(mtlUrl);
              materials.preload();
              loader.setMaterials(materials);
            }
          }
          const mesh = await loader.loadAsync(url);
          if (!this.scene) { this._disposeObjectTree(mesh); return null; } // 加载期间场景被释放
          return { mesh, data: { type: 'model' } };
        }
        const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
        const loader = new GLTFLoader();
        loader.setURLModifier(value => dependencyUrls.get(dependencyName(value)) || value);
        const loaded = await loader.loadAsync(url);
        if (!this.scene) { this._disposeObjectTree(loaded.scene); return null; } // 加载期间场景被释放
        return { mesh: loaded.scene, data: { type: 'model' } };
      } finally {
        dependencyUrls.forEach(value => URL.revokeObjectURL(value));
      }
    } catch (error) {
      console.warn('[SceneManager] source model restore failed:', error);
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** 释放从加载器得到的对象树（含纹理/材质/几何体），用于加载被中止时避免 GPU 泄漏 */
  _disposeObjectTree(root) {
    root?.traverse?.(node => {
      node.geometry?.dispose();
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.forEach(material => {
        if (!material) return;
        Object.values(material).forEach(value => { if (value?.isTexture) value.dispose(); });
        material.dispose();
      });
    });
  }

  /** M1: 来源3 — 由 serialized meshes 重建外部模型 */
  _restoreFromExternalMeshes(objData) {
    const externalMeshes = objData.geometry?.meshes;
    if (!Array.isArray(externalMeshes) || !externalMeshes.length) return null;
    const group = new THREE.Group();
    externalMeshes.forEach(record => {
      const child = this._createExternalMesh(record);
      if (child) {
        group.add(child);
        // H1: 依据 record.material[*].*MapResourceId 异步补挂贴图
        this._attachMaterialTextures(child, record.material);
      }
    });
    if (!group.children.length) return null;
    return { mesh: group, data: { type: 'model' }, restoredExternal: true };
  }

  /** M1: 来源4 — 回退：由保存的 topology 重建网格（e.g. imported models） */
  _restoreFromTopology(objData) {
    const geo = buildTopologyGeometry(objData.geometry?.topology);
    if (!geo) return null;
    const material = new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.1, roughness: 0.7 });
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return { mesh, data: { type: objData.type || 'model' } };
  }

  /** M1: external 模型恢复后的统一收尾（命名/变换/阴影/入场景） */
  _finalizeRestoredExternal(mesh, objData) {
    const transform = objData.transform;
    mesh.name = objData.name || mesh.name || '导入模型';
    if (transform) {
      mesh.position.set(transform.position?.[0] ?? 0, transform.position?.[1] ?? 0, transform.position?.[2] ?? 0);
      mesh.rotation.set(transform.rotation?.[0] ?? 0, transform.rotation?.[1] ?? 0, transform.rotation?.[2] ?? 0);
      mesh.scale.set(transform.scale?.[0] ?? 1, transform.scale?.[1] ?? 1, transform.scale?.[2] ?? 1);
    }
    mesh.traverse?.(child => {
      if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; }
    });
    this.addExternalObject(mesh, clone(objData));
  }

  // ===== Undo / Redo (command pattern) =====
  pushCommand(cmd) {
    this._undoStack.push(cmd);
    this._redoStack = [];
    this.emit('historychange', { canUndo: true, canRedo: false });
  }
  undo() {
    const cmd = this._undoStack.pop();
    if (!cmd) return false;
    cmd.undo();
    this._redoStack.push(cmd);
    this.emit('historychange', { canUndo: this._undoStack.length > 0, canRedo: true });
    this.emit('scenechanged');
    return true;
  }
  redo() {
    const cmd = this._redoStack.pop();
    if (!cmd) return false;
    cmd.redo();
    this._undoStack.push(cmd);
    this.emit('historychange', { canUndo: true, canRedo: this._redoStack.length > 0 });
    this.emit('scenechanged');
    return true;
  }
  get canUndo() { return this._undoStack.length > 0; }
  get canRedo() { return this._redoStack.length > 0; }

  // ===== Helpers =====
  _defaultName(type) {
    this._nameCounter += 1;
    return `${TYPE_NAMES[type] || type} ${this._nameCounter}`;
  }

  /** 批量释放所有物体资源 — 不触发事件，由调用方统一 emit */
  _disposeAllObjects() {
    const disposedTextures = new Set();
    const shouldDisposeTexture = (value) => {
      if (disposedTextures.has(value)) return false;
      disposedTextures.add(value);
      return true;
    };
    for (const { mesh, external } of this.objects.values()) {
      this.scene?.remove(mesh);
      if (external) mesh.traverse?.(node => this._disposeNode(node, shouldDisposeTexture));
      else this._disposeNode(mesh, shouldDisposeTexture);
    }
    this.objects.clear();
    this.selection.clear();
    this._meshList.length = 0;
  }

  /** 释放单个节点（几何体 + 材质 + 纹理）— 纹理是否释放由回调决定，供 removeObject 与 _disposeAllObjects 复用 */
  _disposeNode(node, shouldDisposeTexture) {
    node.geometry?.dispose();
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    materials.forEach(material => {
      if (!material) return;
      Object.values(material).forEach(value => {
        if (value?.isTexture && shouldDisposeTexture(value)) value.dispose();
      });
      material.dispose();
    });
    if (node.userData) delete node.userData.sceneObjectId;
  }

  static getTypeIcon(type) { return TYPE_ICONS[type] || '?'; }
  static getTypeName(type) { return TYPE_NAMES[type] || type; }

  // ===== 全量释放 =====
  dispose() {
    this._disposeAllObjects();
    [...this._undoStack, ...this._redoStack].forEach(command => command.dispose?.());
    this._undoStack = [];
    this._redoStack = [];
    this.clear();
    this.scene = null;
    this.factory = null;
  }
}
