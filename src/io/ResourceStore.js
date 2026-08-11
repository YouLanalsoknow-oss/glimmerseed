/**
 * 大资源存储。二进制内容只进入 IndexedDB，不进入场景 JSON/localStorage。
 * 无 IndexedDB（例如受限预览环境）时使用内存回退，API 保持异步一致。
 */
const DB_NAME = 'glimmerbook-workbench-resources';
const DB_VERSION = 1;
const STORE_NAME = 'resources';
const MAX_RESOURCE_BYTES = 128 * 1024 * 1024;

export class ResourceStore {
  constructor() {
    this._dbPromise = null;
    this._memory = new Map();
    this._writeChain = Promise.resolve();
    this._usedBytes = -1;   // -1 表示尚未初始化
    this._sizes = new Map(); // id -> size（用于维护增量占用，避免每次 put 全量 list）
  }

  init() {
    if (this._dbPromise) return this._dbPromise;
    if (typeof indexedDB === 'undefined') {
      this._dbPromise = Promise.resolve(null);
      return this._dbPromise;
    }
    this._dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB 打开失败'));
    }).catch(error => {
      console.warn('[ResourceStore] IndexedDB unavailable, using memory fallback:', error);
      return null;
    });
    return this._dbPromise;
  }

  _id() {
    return globalThis.crypto?.randomUUID?.() || `resource-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  async put(blob, metadata = {}) {
    if (!(blob instanceof Blob)) throw new TypeError('资源必须是 Blob');
    const run = async () => {
      const id = metadata.id || this._id();
      const record = { id, blob, name: metadata.name || 'resource', type: metadata.type || blob.type || 'application/octet-stream', size: blob.size, updatedAt: Date.now() };
      const db = await this.init();
      if (this._usedBytes < 0) await this._ensureUsage();
      const oldSize = this._sizes.get(id) || 0;
      if (this._usedBytes - oldSize + record.size > MAX_RESOURCE_BYTES) {
        throw new Error(`资源容量已达到 128MB 上限，当前还需要 ${this._formatBytes(this._usedBytes - oldSize + record.size - MAX_RESOURCE_BYTES)}`);
      }
      if (!db) { this._memory.set(id, record); this._applyUsage(id, record.size, oldSize); return this._meta(record); }
      await new Promise((resolve, reject) => {
        const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(record);
        request.onsuccess = resolve; request.onerror = () => reject(request.error);
      });
      this._applyUsage(id, record.size, oldSize);
      return this._meta(record);
    };
    this._writeChain = this._writeChain.catch(() => undefined).then(run);
    return this._writeChain;
  }

  async get(id) {
    if (!id) return null;
    const db = await this.init();
    if (!db) return this._memory.get(id) || null;
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async delete(id) {
    if (!id) return;
    const db = await this.init();
    if (!db) { this._memory.delete(id); this._applyUsage(id, 0, this._sizes.get(id) || 0); return; }
    await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(id);
      request.onsuccess = resolve; request.onerror = () => reject(request.error);
    });
    this._applyUsage(id, 0, this._sizes.get(id) || 0);
  }

  async list() {
    const db = await this.init();
    if (!db) return [...this._memory.values()];
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async removeUnreferenced(ids = []) {
    const keep = new Set(ids);
    const db = await this.init();
    if (!db) {
      for (const [id] of this._memory) {
        if (!keep.has(id)) { this._memory.delete(id); this._applyUsage(id, 0, this._sizes.get(id) || 0); }
      }
      return;
    }
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.openCursor();
      const removed = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (!keep.has(cursor.primaryKey)) { removed.push(cursor.primaryKey); cursor.delete(); }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => { removed.forEach(id => this._applyUsage(id, 0, this._sizes.get(id) || 0)); resolve(); };
      transaction.onerror = () => reject(transaction.error || new Error('资源清理失败'));
      transaction.onabort = () => reject(transaction.error || new Error('资源清理已中止'));
    });
  }

  _applyUsage(id, newSize, oldSize) {
    if (this._usedBytes < 0) return;
    this._usedBytes = this._usedBytes - oldSize + newSize;
    if (newSize > 0) this._sizes.set(id, newSize); else this._sizes.delete(id);
  }

  async _ensureUsage() {
    const db = await this.init();
    const records = db ? await this.list() : [...this._memory.values()];
    let total = 0;
    this._sizes.clear();
    for (const record of records) { total += Number(record.size) || 0; this._sizes.set(record.id, Number(record.size) || 0); }
    this._usedBytes = total;
    return total;
  }

  _meta(record) {
    return { id: record.id, name: record.name, type: record.type, size: record.size, updatedAt: record.updatedAt };
  }

  _formatBytes(bytes) {
    return `${Math.max(0, bytes / 1024 / 1024).toFixed(1)}MB`;
  }

  dispose() {
    if (this._dbPromise) this._dbPromise.then(db => db?.close());
    this._dbPromise = null;
    this._memory.clear();
  }
}
