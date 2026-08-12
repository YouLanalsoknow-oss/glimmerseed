import { SceneManager } from '../core/SceneManager.js';
import { RemoveObjectCommand } from '../core/Commands.js';
import { escapeHtml } from '../shared/escapeHtml.js';

/**
 * 界面层 — 场景大纲：对象列表、点击选中、删除
 */
export class Outline {
  constructor({ sceneManager, factory }) {
    this.sceneManager = sceneManager;
    this.factory = factory;
  }

  init() {
    this._offAdded = this.sceneManager.on('objectadded', () => this.render());
    this._offRemoved = this.sceneManager.on('objectremoved', () => this.render());
    // 重命名只更新对应名称节点，避免单对象改名触发整表全量重建（O(1) DOM 更新）
    this._offName = this.sceneManager.on('namechanged', ({ id, name }) => this._updateName(id, name));
    // 选择切换只更新 active class，不重建整个列表
    this._offSelection = this.sceneManager.on('selectionchange', () => this._updateSelection());
    // 事件委托：容器上只绑一次点击监听，避免每次 render 全量重建后重新 querySelectorAll + 逐个绑定
    const list = document.getElementById('outlineList');
    if (list) list.addEventListener('click', this._onListClick);
  }

  dispose() {
    this._offAdded?.(); this._offAdded = null;
    this._offRemoved?.(); this._offRemoved = null;
    this._offName?.(); this._offName = null;
    this._offSelection?.(); this._offSelection = null;
    const list = document.getElementById('outlineList');
    if (list) list.removeEventListener('click', this._onListClick);
  }

  _onListClick = (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      const id = del.dataset.del;
      const cmd = new RemoveObjectCommand(this.sceneManager, this.factory, id);
      const obj = this.sceneManager.getObject(id);
      // 外部模型交给命令保留引用，确保撤销可以恢复原对象
      this.sceneManager.removeObject(id, { dispose: !obj?.external });
      this.sceneManager.pushCommand(cmd);
      return;
    }
    const item = e.target.closest('.outline-item');
    if (item) this.sceneManager.selectObject(item.dataset.id, e.shiftKey);
  };

  /** 轻量选择更新 — 只切换已有 DOM 的 active class */
  _updateSelection() {
    const list = document.getElementById('outlineList');
    if (!list) return;
    const selection = this.sceneManager.selection;
    list.querySelectorAll('.outline-item').forEach(item => {
      const isActive = selection.has(item.dataset.id);
      item.classList.toggle('active', isActive);
    });
  }

  /** 轻量重命名更新 — 只改写对应名称节点，避免整表重建 */
  _updateName(id, name) {
    const list = document.getElementById('outlineList');
    if (!list || !id) return;
    const item = list.querySelector(`.outline-item[data-id="${CSS.escape(id)}"]`);
    if (!item) return;
    const nameEl = item.querySelector('.name');
    // textContent 天然防注入，无需 escapeHtml
    if (nameEl) nameEl.textContent = String(name ?? '');
  }

  render() {
    const list = document.getElementById('outlineList');
    const count = document.getElementById('outlineCount');
    if (!list) return;
    const objects = this.sceneManager.getAllObjects();
    if (count) count.textContent = objects.length;

    if (objects.length === 0) {
      list.innerHTML = '<div class="empty-hint">场景为空<br>从工具栏创建第一个物体</div>';
      return;
    }

    const selection = this.sceneManager.selection;
    // id 也走 escapeHtml：限定字符集，防止损坏存档中的 id 含引号/尖括号注入属性
    list.innerHTML = objects.map(obj => `
      <div class="outline-item ${selection.has(obj.id) ? 'active' : ''}" data-id="${escapeHtml(obj.id)}">
        <span class="icon">${SceneManager.getTypeIcon(obj.type)}</span>
        <span class="name">${escapeHtml(obj.name)}</span>
        <span class="del" data-del="${escapeHtml(obj.id)}" title="删除">\u00d7</span>
      </div>
    `).join('');
  }
}
