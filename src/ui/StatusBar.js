/**
 * 界面层 — 状态栏：物体数、选中信息、渲染后端
 * 注意：模式（#statusMode）文本由 MeshEditController 统一持有并写入，
 * 此处不得覆盖，避免在拓扑编辑/框选模式下把状态冲掉。
 */
import { schedule } from '../shared/throttleByRAF.js';

export class StatusBar {
  constructor({ sceneManager, transformController, renderer }) {
    this.sceneManager = sceneManager;
    this.transformController = transformController;
    this.renderer = renderer;
    // rAF 合并 — 同一帧内多次事件只执行一次 DOM 更新
    this._scheduleUpdate = schedule(() => this.update());
  }

  init() {
    this._offScene = this.sceneManager.on('scenechanged', () => this._scheduleUpdate());
    this._offSelection = this.sceneManager.on('selectionchange', () => this._scheduleUpdate());
    this.update();
  }

  dispose() {
    this._offScene?.(); this._offScene = null;
    this._offSelection?.(); this._offSelection = null;
    this._scheduleUpdate.cancel?.();
  }

  update() {
    const objCount = document.getElementById('statusObjects');
    const selEl = document.getElementById('statusSelection');
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

    if (backendEl) {
      backendEl.textContent = `渲染后端: ${this.renderer?.backend ?? 'unknown'}`;
    }
  }
}
