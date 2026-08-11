import { MODE_NAMES } from '../shared/constants.js';

/**
 * 界面层 — 状态栏：物体数、选中信息、变换模式、渲染后端
 */
export class StatusBar {
  constructor({ sceneManager, transformController, renderer }) {
    this.sceneManager = sceneManager;
    this.transformController = transformController;
    this.renderer = renderer;
    this._updateRAF = 0;
  }

  init() {
    this._offScene = this.sceneManager.on('scenechanged', () => this._scheduleUpdate());
    this._offSelection = this.sceneManager.on('selectionchange', () => this._scheduleUpdate());
    this.update();
  }

  dispose() {
    this._offScene?.(); this._offScene = null;
    this._offSelection?.(); this._offSelection = null;
    if (this._updateRAF) { cancelAnimationFrame(this._updateRAF); this._updateRAF = 0; }
  }

  /** rAF 合并 — 同一帧内多次事件只执行一次 DOM 更新 */
  _scheduleUpdate() {
    if (this._updateRAF) return;
    this._updateRAF = requestAnimationFrame(() => {
      this._updateRAF = 0;
      this.update();
    });
  }

  update() {
    const objCount = document.getElementById('statusObjects');
    const selEl = document.getElementById('statusSelection');
    const modeEl = document.getElementById('statusMode');
    const backendEl = document.getElementById('statusBackend');

    if (objCount) objCount.textContent = `物体: ${this.sceneManager.count}`;

    const selected = this.sceneManager.getSelectedObjects();
    if (selEl) {
      if (selected.length === 0) {
        selEl.textContent = '未选中';
      } else if (selected.length === 1) {
        selEl.textContent = `已选: ${selected[0].data.name}`;
      } else {
        selEl.textContent = `已选 ${selected.length} 个对象`;
      }
    }

    if (modeEl) {
      modeEl.textContent = `${MODE_NAMES[this.transformController.mode] || ''}模式`;
    }

    if (backendEl) {
      backendEl.textContent = `渲染后端: ${this.renderer.backend}`;
    }
  }
}
