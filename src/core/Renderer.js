import * as THREE from 'three';

/**
 * 视口渲染层 — WebGPURenderer 优先，WebGL2 自动回退
 */
export class Renderer {
  constructor() {
    this.renderer = null;
    this.backend = 'initializing';
    this.canvas = null;
    this._initPromise = null;
    this._disposed = false;
  }

  async init(canvas) {
    if (!canvas) throw new Error('Renderer.init: canvas is required');
    if (this._disposed) return null;
    if (this.renderer) return this;
    if (this._initPromise) {
      if (this.canvas !== canvas) throw new Error('Renderer.init: already initializing another canvas');
      return this._initPromise;
    }
    this.canvas = canvas;
    this._initPromise = this._create(canvas);
    try {
      return await this._initPromise;
    } finally {
      this._initPromise = null;
    }
  }

  async _create(canvas) {
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    let webGpuError = null;

    // WebGPU 需要异步初始化；失败后必须释放实例，再在同一 canvas 上创建 WebGL2。
    if (typeof navigator !== 'undefined' && navigator.gpu && typeof THREE.WebGPURenderer === 'function') {
      let gpu = null;
      try {
        gpu = new THREE.WebGPURenderer({ canvas, antialias: true });
        await gpu.init();
        // dispose 可能在 await 期间被调用：此时释放已创建的实例，不再挂回已报废的渲染器
        if (this._disposed) { gpu.dispose?.(); return null; }
        gpu.setPixelRatio(pixelRatio);
        this.renderer = gpu;
        this.backend = 'WebGPU';
        this._configureRenderer();
        return this;
      } catch (err) {
        webGpuError = err;
        console.warn('[Renderer] WebGPU unavailable, falling back to WebGL2:', err);
        gpu?.dispose?.();
        this.renderer?.dispose?.();
        this.renderer = null;
      }
    }

    try {
      const webgl = new THREE.WebGLRenderer({ canvas, antialias: true });
      if (!webgl.getContext()) throw new Error('WebGL2 context unavailable');
      if (this._disposed) { webgl.dispose(); return null; }
      webgl.setPixelRatio(pixelRatio);
      this.renderer = webgl;
      this.backend = 'WebGL2';
      this._configureRenderer();
    } catch (err) {
      this.backend = 'failed';
      this.canvas = null;
      console.error('[Renderer] WebGL2 init failed:', err);
      const failure = new Error('无法初始化 WebGPU 或 WebGL2 渲染器', { cause: webGpuError || err });
      failure.webGpuError = webGpuError;
      failure.webglError = err;
      throw failure;
    }
    return this;
  }

  get domElement() {
    return this.renderer?.domElement ?? null;
  }

  /** 配置阴影贴图与色调映射 — WebGPU 和 WebGL2 通用 */
  _configureRenderer() {
    const r = this.renderer;
    if (!r) return;
    if (r.shadowMap) {
      r.shadowMap.enabled = true;
      r.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    if ('toneMapping' in r) {
      r.toneMapping = THREE.ACESFilmicToneMapping;
      r.toneMappingExposure = 1.0;
    }
  }

  setSize(w, h) {
    if (this.renderer && w > 0 && h > 0) {
      this.renderer.setSize(w, h, false);
    }
  }

  render(scene, camera) {
    if (this.renderer && scene && camera) {
      this.renderer.render(scene, camera);
    }
  }

  dispose() {
    this._disposed = true;
    this.renderer?.dispose();
    this.renderer = null;
    this.canvas = null;
    this.backend = 'disposed';
  }
}
