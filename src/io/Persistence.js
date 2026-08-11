/**
 * 数据 IO 层 — localStorage 存场景元数据，IndexedDB 存大资源（图片/PSD 预览）。
 * 二进制 Blob 永不进入 JSON，避免 localStorage 5MB 上限。
 */

import { isValidTopology } from '../shared/topology.js';

const STORAGE_KEY = 'glimmerbook-workbench-v1';
const SAVE_DEBOUNCE = 800; // ms

// 存档版本号：数据无 version 字段时视为旧版（兼容）；低于最小支持版本时仅提示并尽量兼容，不静默丢弃。
const SCENE_VERSION = 1;
const MIN_SUPPORTED_VERSION = 1;

export class Persistence {
  constructor() {
    this._saveTimer = null;
    this._onSaveStatus = null;
    this._lastStatus = null;
    this._resourceStore = null;
    this._saveChain = Promise.resolve(); // 串行化保存，避免快照交错
    this._disposed = false;
  }

  /** 暴露 ResourceStore 供 CanvasRuntime 使用 */
  get resources() { return this._resourceStore; }

  /** @param {function} cb — receives 'saving' | 'saved' | 'error' */
  setSaveStatusCallback(cb) {
    this._onSaveStatus = cb;
  }

  _status(s) {
    if (s === this._lastStatus) return;
    this._lastStatus = s;
    if (this._onSaveStatus) this._onSaveStatus(s);
  }

  /** 向状态回调直接发送自定义提示（绕过去重，用于明确告警） */
  _notify(message) {
    this._lastStatus = message;
    if (this._onSaveStatus) this._onSaveStatus(message);
  }

  /**
   * 写入 localStorage；若触发 QuotaExceededError，将旧值备份到 `${key}-oversized` 并提示，
   * 避免静默丢存档。其他异常原样抛出。
   * @returns {boolean} 写入成功返回 true；配额不足（已备份）返回 false。
   */
  _setItemWithQuotaFallback(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (err) {
      const isQuota = err && (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014);
      if (isQuota && key === STORAGE_KEY) {
        try {
          const old = localStorage.getItem(key);
          if (old) localStorage.setItem(key + '-oversized', old);
        } catch (_) { /* 备份失败则忽略，原数据仍保留在旧键 */ }
        this._notify('存档过大：超出存储上限，已备份原有存档（键 -oversized）。请精简后重试。');
        return false;
      }
      throw err;
    }
  }

  /**
   * 初始化 — 创建 ResourceStore 并打开 IndexedDB。
   * 必须在 load() 之前调用。
   */
  async init() {
    this._disposed = false;
    const { ResourceStore } = await import('./ResourceStore.js');
    this._resourceStore = new ResourceStore();
    await this._resourceStore.init();
    // 请求持久化存储 — 防止浏览器在存储压力下自动清理 IndexedDB
    if (navigator.storage?.persist) {
      try {
        const granted = await navigator.storage.persist();
        if (!granted) console.info('[Persistence] 持久化存储未授权，资源可能在低存储时被清理');
      } catch (_) { /* 非关键路径 */ }
    }
  }

  /**
   * 查询存储用量与配额 — 验证 128MB 资源上限是否可达。
   * @returns {Promise<{usage:number, quota:number}>}
   */
  async getStorageEstimate() {
    if (!navigator.storage?.estimate) return { usage: 0, quota: 0 };
    try {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      return { usage, quota };
    } catch {
      return { usage: 0, quota: 0 };
    }
  }

  /**
   * 异步保存 — 场景元数据写入 localStorage，清理 IndexedDB 中未引用的资源。
   * @returns {Promise<boolean>}
   */
  async save(sceneManager, viewport, canvasRuntime = null) {
    if (this._disposed) return false;
    const run = async () => {
      this._status('saving');
      try {
        await this._doSave(sceneManager, viewport, canvasRuntime);
        this._status('saved');
        return true;
      } catch (err) {
        console.error('[Persistence] save failed:', err);
        this._status('error');
        return false;
      }
    };
    this._saveChain = this._saveChain.catch(() => false).then(run);
    return this._saveChain;
  }

  async _doSave(sceneManager, viewport, canvasRuntime) {
    const data = sceneManager.getSceneData();
    if (viewport) data.camera = viewport.getCameraData();
    if (canvasRuntime) data.canvas = canvasRuntime.serialize();
    if (!this._isValidSceneData(data)) throw new Error('场景数据校验失败');

    // 1. 场景元数据 → localStorage（不含 Blob，体积小）
    const json = JSON.stringify(data);
    if (!this._setItemWithQuotaFallback(STORAGE_KEY, json)) {
      // 配额不足：旧值已备份且已提示，抛错走外层 error 状态，不静默丢存档
      throw new Error('存档过大：超出 localStorage 存储上限，已备份原有存档');
    }

    // 2. 清理 IndexedDB 中不再被引用的资源
    if (this._resourceStore && canvasRuntime) {
      const referencedIds = canvasRuntime.getResourceIds();
      await this._resourceStore.removeUnreferenced(referencedIds);
    }
    return true;
  }

  /**
   * 异步加载 — 从 localStorage 读取场景元数据。
   * 大资源由 CanvasRuntime.restore() 按需从 IndexedDB 异步获取。
   * @returns {Promise<object|null>}
   */
  async load() {
    try {
      const json = localStorage.getItem(STORAGE_KEY);
      if (!json) return null;
      const data = JSON.parse(json);
      this._checkVersion(data);
      if (!this._isValidSceneData(data)) throw new Error('保存数据结构无效');
      if (data.camera && !this._isValidCamera(data.camera)) delete data.camera;
      if (data.canvas && !this._isValidCanvas(data.canvas)) delete data.canvas;
      return data;
    } catch (err) {
      console.error('[Persistence] load failed:', err);
      // 保留损坏数据以供恢复
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) localStorage.setItem(STORAGE_KEY + '-corrupted', raw);
      } catch (_) { /* ignore */ }
      return null;
    }
  }

  /**
   * 校验存档版本。策略：仅提示并尽量兼容，不静默丢弃。
   * - 无 version 字段：视为旧版，兼容加载。
   * - version 低于最小支持版本：告警并尝试兼容加载。
   * - version 高于当前版本：告警并发回兼容性提醒。
   */
  _checkVersion(data) {
    const v = data && data.version;
    if (v == null) return; // 旧存档无版本字段，直接兼容
    if (typeof v !== 'number') { console.warn('[Persistence] 存档 version 字段格式异常，将尝试兼容加载'); return; }
    if (v < MIN_SUPPORTED_VERSION) {
      console.warn(`[Persistence] 存档版本 ${v} 低于当前支持版本 ${SCENE_VERSION}，将尝试兼容加载（不保证完整恢复）`);
    } else if (v > SCENE_VERSION) {
      console.warn(`[Persistence] 存档版本 ${v} 高于当前支持版本 ${SCENE_VERSION}，可能存在不兼容字段，将尝试兼容加载`);
    }
  }

  _isValidSceneData(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.objects)) return false;
    return data.objects.every(object => {
      if (!object || typeof object !== 'object' || typeof object.id !== 'string' || typeof object.type !== 'string') return false;
      const t = object.transform;
      if (t && (!this._isNumberArray(t.position, 3) || !this._isNumberArray(t.rotation, 3) || !this._isNumberArray(t.scale, 3))) return false;
      const topology = object.geometry?.topology;
      if (topology && !isValidTopology(topology)) return false;
      if (object.material != null && !this._isValidMaterial(object.material)) return false;
      const meshes = object.geometry?.meshes;
      if (object.sourceResourceId != null && (typeof object.sourceResourceId !== 'string' || object.sourceResourceId.length > 200)) return false;
      if (object.sourceName != null && (typeof object.sourceName !== 'string' || object.sourceName.length > 500)) return false;
      if (object.sourceResources != null && (!Array.isArray(object.sourceResources) || object.sourceResources.length > 200 || object.sourceResources.some(resource =>
        !resource || typeof resource.id !== 'string' || resource.id.length > 200 || typeof resource.name !== 'string' || resource.name.length > 500 ||
        (resource.type != null && typeof resource.type !== 'string')))) return false;
      if (meshes != null && (!Array.isArray(meshes) || meshes.length > 2000 || meshes.some(mesh =>
        !mesh || typeof mesh !== 'object' || typeof mesh.name !== 'string' ||
        !isValidTopology(mesh.topology) || !this._isValidMaterial(mesh.material) ||
        (mesh.transform != null && !this._isValidTransform(mesh.transform))))) return false;
      return true;
    }) && (!data.canvas || this._isValidCanvas(data.canvas));
  }

  _isValidCamera(camera) {
    return camera && this._isNumberArray(camera.position, 3) && this._isNumberArray(camera.target, 3) &&
      (camera.zoom == null || Number.isFinite(camera.zoom));
  }

  _isValidCanvas(canvas) {
    return canvas && Number.isInteger(canvas.version) && Array.isArray(canvas.elements) &&
      canvas.elements.length <= 2000 && canvas.elements.every(item => item && typeof item === 'object' &&
      typeof item.tag === 'string' && typeof item.className === 'string' && item.className.length < 2000 && typeof item.style === 'string' && item.style.length < 10000 &&
        (item.text == null || typeof item.text === 'string') && (item.html == null || typeof item.html === 'string') &&
        (item.src == null || typeof item.src === 'string') &&
        (item.resourceId == null || typeof item.resourceId === 'string' && item.resourceId.length < 200));
  }

  _isNumberArray(value, length) {
    return Array.isArray(value) && value.length === length && value.every(Number.isFinite);
  }

  _isValidTransform(transform) {
    return transform && this._isNumberArray(transform.position, 3) && this._isNumberArray(transform.rotation, 3) && this._isNumberArray(transform.scale, 3);
  }

  _isValidMaterial(material) {
    const materials = Array.isArray(material) ? material : [material];
    return materials.length > 0 && materials.length <= 64 && materials.every(item => item && typeof item === 'object' &&
      (item.color == null || typeof item.color === 'string') &&
      (item.emissive == null || typeof item.emissive === 'string') &&
      (item.metalness == null || Number.isFinite(item.metalness)) &&
      (item.roughness == null || Number.isFinite(item.roughness)) &&
      (item.emissiveIntensity == null || Number.isFinite(item.emissiveIntensity)) &&
      (item.opacity == null || Number.isFinite(item.opacity)) &&
      (item.transparent == null || typeof item.transparent === 'boolean') &&
      (item.depthWrite == null || typeof item.depthWrite === 'boolean') &&
      (item.side == null || Number.isInteger(item.side)) &&
      (item.wireframe == null || typeof item.wireframe === 'boolean'));
  }

  /**
   * 防抖自动保存 — 800ms 内连续修改只触发一次异步保存。
   */
  autoSave(sceneManager, viewport, canvasRuntime = null) {
    this._status('saving');
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.save(sceneManager, viewport, canvasRuntime);
    }, SAVE_DEBOUNCE);
  }

  /**
   * 同步刷新 — 取消防抖，立即执行异步保存。
   * 返回 Promise，供 beforeunload 或 dispose 等待。
   */
  flush(sceneManager, viewport, canvasRuntime = null) {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    return this.save(sceneManager, viewport, canvasRuntime);
  }

  /**
   * 同步写入当前元数据快照，供页面卸载前使用。
   * IndexedDB 资源仍由 flush() 异步清理，但最新场景结构不会依赖 Promise 调度。
   */
  saveSnapshotSync(sceneManager, viewport, canvasRuntime = null) {
    if (this._disposed) return false;
    try {
      const data = sceneManager.getSceneData();
      if (viewport) data.camera = viewport.getCameraData();
      if (canvasRuntime) data.canvas = canvasRuntime.serialize();
      if (!this._isValidSceneData(data)) throw new Error('场景数据校验失败');
      return this._setItemWithQuotaFallback(STORAGE_KEY, JSON.stringify(data));
    } catch (error) {
      console.error('[Persistence] synchronous snapshot failed:', error);
      return false;
    }
  }

  clear() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      console.error('[Persistence] clear failed:', err);
    }
    // 同时清空 IndexedDB 资源 — 返回等待所有 delete 完成的 Promise，供调用方 await
    if (this._resourceStore) {
      return this._resourceStore.list()
        .then(records => Promise.all(records.map(r => this._resourceStore.delete(r.id))))
        .catch(() => {});
    }
    return Promise.resolve();
  }

  hasSavedData() {
    try {
      return localStorage.getItem(STORAGE_KEY) !== null;
    } catch {
      return false;
    }
  }

  dispose() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    this._disposed = true;
    this._onSaveStatus = null;
    const store = this._resourceStore;
    const pending = this._saveChain;
    // 等待最后一个 IndexedDB 操作结束后再关闭连接
    pending.finally(() => {
      if (this._resourceStore === store) this._resourceStore = null;
      store?.dispose();
    });
  }
}
