import * as THREE from 'three';
import { DEFAULT_MATERIAL, TYPE_NAMES, TYPE_ICONS } from '../shared/constants.js';
import { clone, dependencyName } from '../shared/utils.js';
import { isValidTopology, writeTopologyToGeometry } from '../shared/topology.js';
import { isTextureUsedByAnyOther } from '../shared/textureUtils.js';

/**
 * 场景管理层 — 对象树、选择集、纯数据模型、撤销重做栈
 * 数据模型不持有 Three.js 对象引用，方便序列化与未来同步
 */

let _idCounter = 0;
function genId() { return `obj-${Date.now().toString(36)}-${++_idCounter}`; }

export class SceneManager {
  constructor(scene, geometryFactory = null, resourceStore = null) {
    this.scene = scene;
    this.factory = geometryFactory;
    this.resourceStore = resourceStore;
    this.objects = new Map();   // id -> { mesh, data }
    this.selection = new Set(); // set of ids
    this._listeners = new Map();
    this._undoStack = [];
    this._redoStack = [];
    this._meshList = [];
    this._suppressEvents = false; // M7: 批量恢复期间抑制 objectadded/scenechanged
    this._nameCounter = 0;        // L2: 独立递增的默认命名计数器
  }

  // ===== Event system =====
  on(event, cb) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(cb);
    return () => this._listeners.get(event)?.delete(cb);
  }
  emit(event, data) {
    this._listeners.get(event)?.forEach(cb => { try { cb(data); } catch (e) { console.error(e); } });
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
    const disposeNode = (node) => {
      node.geometry?.dispose();
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.forEach(material => {
        if (!material) return;
        // 只释放不再被场景中其他对象引用的纹理，避免共享纹理泄漏或误释放。
        Object.values(material).forEach(value => {
          if (value?.isTexture && !isTextureUsedByAnyOther(this.objects.values(), value, id)) value.dispose();
        });
        material.dispose();
      });
      if (node.userData) delete node.userData.sceneObjectId;
    };
    if (dispose) {
      if (obj.external) obj.mesh.traverse?.(disposeNode);
      else disposeNode(obj.mesh);
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
    const topology = record?.topology;
    if (!isValidTopology(topology)) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(topology.vertices.flat()), 3));
    geo.setIndex(topology.indices);
    if (topology.uv?.length === topology.vertices.length * 2) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(topology.uv), 2));
    this._applyTopologyGroups(geo, topology);
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
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

  _applyTopologyGroups(geometry, topology) {
    geometry.clearGroups();
    const indexCount = topology.indices.length;
    if (Array.isArray(topology.materialIndices)) {
      let current = null;
      topology.materialIndices.forEach((materialIndex, faceId) => {
        if (!current || current.materialIndex !== materialIndex) {
          if (current) geometry.addGroup(current.start, current.count, current.materialIndex);
          current = { start: faceId * 3, count: 3, materialIndex };
        } else current.count += 3;
      });
      if (current) geometry.addGroup(current.start, Math.min(current.count, indexCount - current.start), current.materialIndex);
      return;
    }
    (topology.groups || []).forEach(group => {
      const start = Math.min(group.start, indexCount);
      const count = Math.min(group.count, indexCount - start);
      if (count > 0) geometry.addGroup(start, count, group.materialIndex);
    });
  }

  // ===== H1: 贴图资源恢复 =====
  /** 依据序列化材质中的 *MapResourceId 异步取回纹理并挂接到对应材质 */
  async _loadMaterialTexture(material, prop, resourceId) {
    if (!resourceId || !this.resourceStore || !material) return;
    let record;
    try { record = await this.resourceStore.get(resourceId); } catch (_) { return; }
    if (!record?.blob) return;
    const url = URL.createObjectURL(record.blob);
    try {
      const texture = await new THREE.TextureLoader().loadAsync(url);
      texture.userData.resourceId = resourceId;
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
    const tasks = [];
    mesh.traverse?.(node => {
      if (!node.material) return;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.forEach((material, index) => {
        const value = list[index] || list[0];
        if (!value || !material) return;
        tasks.push(this._loadMaterialTexture(material, 'map', value.mapResourceId));
        tasks.push(this._loadMaterialTexture(material, 'normalMap', value.normalMapResourceId));
        tasks.push(this._loadMaterialTexture(material, 'roughnessMap', value.roughnessMapResourceId));
        tasks.push(this._loadMaterialTexture(material, 'metalnessMap', value.metalnessMapResourceId));
      });
    });
    return Promise.all(tasks).catch(() => undefined);
  }

  // ===== Serialization
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
      let result = this.factory?.create(objData.type, objData.geometry || {}) || null;
      if (!result && objData.sourceResourceId && this.resourceStore) {
        const source = await this.resourceStore.get(objData.sourceResourceId).catch(() => null);
        if (source?.blob) {
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
                result = { mesh: await loader.loadAsync(url), data: { type: 'model' } };
              } else {
                const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
                const loader = new GLTFLoader();
                loader.setURLModifier(value => dependencyUrls.get(dependencyName(value)) || value);
                const loaded = await loader.loadAsync(url);
                result = { mesh: loaded.scene, data: { type: 'model' } };
              }
            } finally {
              dependencyUrls.forEach(value => URL.revokeObjectURL(value));
            }
          } catch (error) {
            console.warn('[SceneManager] source model restore failed:', error);
          } finally {
            URL.revokeObjectURL(url);
          }
        }
      }
      const externalMeshes = objData.geometry?.meshes;
      let restoredExternal = false;
      if (!result && Array.isArray(externalMeshes) && externalMeshes.length) {
        const group = new THREE.Group();
        externalMeshes.forEach(record => {
          const child = this._createExternalMesh(record);
          if (child) {
            group.add(child);
            // H1: 依据 record.material[*].*MapResourceId 异步补挂贴图
            this._attachMaterialTextures(child, record.material);
          }
        });
        if (group.children.length) {
          result = { mesh: group, data: { type: 'model' } };
          restoredExternal = true;
        }
      }
      // Fallback: reconstruct mesh from saved topology data (e.g. imported models)
      if (!result) {
        const topology = objData.geometry?.topology;
        if (isValidTopology(topology)) {
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(topology.vertices.flat()), 3));
          geo.setIndex(topology.indices);
          geo.computeVertexNormals();
          geo.computeBoundingBox();
          geo.computeBoundingSphere();
          if (topology.uv?.length === topology.vertices.length * 2) {
            geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(topology.uv), 2));
          }
          this._applyTopologyGroups(geo, topology);
          const material = new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.1, roughness: 0.7 });
          const mesh = new THREE.Mesh(geo, material);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          result = { mesh, data: { type: objData.type || 'model' } };
        }
      }
      if (!result) continue;
      const { mesh, data: newData } = result;
      if (restoredExternal) {
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
        continue;
      }
      // 始终应用已保存的拓扑数据，不再检查顶点数是否匹配
      // 编辑操作（挤出/环切/桥接）会改变顶点数，检查会导致编辑数据丢失
      const topology = objData.geometry?.topology;
      if (isValidTopology(topology)) {
        const position = new Float32Array(topology.vertices.flat());
        result.mesh.geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
        result.mesh.geometry.setIndex(topology.indices);
        result.mesh.geometry.computeVertexNormals();
        result.mesh.geometry.computeBoundingBox();
        result.mesh.geometry.computeBoundingSphere();
        if (topology.uv?.length === topology.vertices.length * 2) {
          result.mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(topology.uv), 2));
        } else {
          result.mesh.geometry.deleteAttribute('uv');
        }
        this._applyTopologyGroups(result.mesh.geometry, topology);
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
        materials.forEach(material => {
          const value = Array.isArray(mat) ? mat[materials.indexOf(material)] || mat[0] : mat;
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
    const disposeNode = (node) => {
      node.geometry?.dispose();
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.forEach(material => {
        if (!material) return;
        Object.values(material).forEach(value => {
          if (value?.isTexture && !disposedTextures.has(value)) {
            disposedTextures.add(value);
            value.dispose();
          }
        });
        material.dispose();
      });
    };
    for (const { mesh, external } of this.objects.values()) {
      this.scene?.remove(mesh);
      if (external) mesh.traverse?.(disposeNode);
      else disposeNode(mesh);
    }
    this.objects.clear();
    this.selection.clear();
    this._meshList.length = 0;
  }

  static getTypeIcon(type) { return TYPE_ICONS[type] || '?'; }
  static getTypeName(type) { return TYPE_NAMES[type] || type; }

  // ===== 全量释放 =====
  dispose() {
    this._disposeAllObjects();
    [...this._undoStack, ...this._redoStack].forEach(command => command.dispose?.());
    this._undoStack = [];
    this._redoStack = [];
    this._listeners.clear();
    this.scene = null;
    this.factory = null;
  }
}
