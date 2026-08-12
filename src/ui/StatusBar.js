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
    // 缓存 DOM 引用，update() 复用，避免每次 rAF 合并更新时重复 getElementById
    this._objCountEl = document.getElementById('statusObjects');
    this._selEl = document.getElementById('statusSelection');
    this._backendEl = document.getElementById('statusBackend');
    this.update();
  }

  dispose() {
    this._offScene?.(); this._offScene = null;
    this._offSelection?.(); this._offSelection = null;
    this._objCountEl = null; this._selEl = null; this._backendEl = null;
    this._scheduleUpdate.cancel?.();
  }

  update() {
    const objCount = this._objCountEl;
    const selEl = this._selEl;
    const backendEl = this._backendEl;

    if (objCount) objCount.textContent = `物体: ${this.sceneManager.count}`;

    const selected = this.sceneManager.getSelectedObjects();
    if (selEl) {
      if (selected.length === 0) {
        selEl.textContent = '未选中';
      } else if (selected.length === 1) {
        // 空值安全：data 缺失时回退空串，避免解引用崩裸
        selEl.textContent = `已选: ${selected[0].data?.name ?? ''}`;
      } else {
        selEl.textContent = `已选 ${selected.length} 个对象`;
      }
    }

    if (backendEl) {
      backendEl.textContent = `渲染后端: ${this.renderer?.backend ?? 'unknown'}`;
    }
  }
}
