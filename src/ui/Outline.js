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
    this._offName = this.sceneManager.on('namechanged', () => this.render());
    // 选择切换只更新 active class，不重建整个列表
    this._offSelection = this.sceneManager.on('selectionchange', () => this._updateSelection());
  }

  dispose() {
    this._offAdded?.(); this._offAdded = null;
    this._offRemoved?.(); this._offRemoved = null;
    this._offName?.(); this._offName = null;
    this._offSelection?.(); this._offSelection = null;
  }

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

  render() {
    const list = document.getElementById('outlineList');
    const count = document.getElementById('outlineCount');
    const objects = this.sceneManager.getAllObjects();
    count.textContent = objects.length;

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

    list.querySelectorAll('.outline-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.dataset.del) return;
        this.sceneManager.selectObject(item.dataset.id, e.shiftKey);
      });
    });

    list.querySelectorAll('[data-del]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.del;
        const cmd = new RemoveObjectCommand(this.sceneManager, this.factory, id);
        const obj = this.sceneManager.getObject(id);
        // 外部模型交给命令保留引用，确保撤销可以恢复原对象
        this.sceneManager.removeObject(id, { dispose: !obj?.external });
        this.sceneManager.pushCommand(cmd);
      });
    });
  }
}
