/**
 * 书签系统核心 — 注册、状态管理、父子层级切换
 *
 * 常驻书签：固定在最左侧，始终平级，点击时重置概念书签层级
 * 概念书签：点击后成为父级，其余概念书签降为子级（缩小排列）
 */

import { createEmitter } from '../shared/events.js';

export class BookmarkSystem {
  constructor() {
    this.permanent = [];
    this.concepts = [];
    this.canvasTools = [];      // 画布模式工具书签
    this.activeParent = null;
    this.activeId = '3d';   // 当前选中书签（摆动选中态）
    this.mode = '3d';           // '3d' | 'canvas'
    Object.assign(this, createEmitter()); // 共享事件实现（on/emit）
  }

  registerPermanent(def) {
    this.permanent.push({ ...def, type: 'permanent' });
  }

  registerConcept(def) {
    this.concepts.push({ ...def, type: 'concept', children: def.children || [] });
  }

  registerCanvasTool(def) {
    this.canvasTools.push({ ...def, type: 'canvasTool' });
  }

  /**
   * 激活书签 — 根据类型执行不同逻辑
   * 常驻书签：重置概念层级 + 触发动作
   * 概念书签：切换为父级（或重置）+ 触发动作
   * 子级书签：仅触发动作（不改变层级）
   */
  activate(id) {
    const perm = this.permanent.find(p => p.id === id);
    if (perm) {
      this.activeParent = null;
      this.activeId = id;
      // 常驻书签切换模式
      if (perm.action === 'mode:3d') this.mode = '3d';
      else if (perm.action === 'mode:canvas') this.mode = 'canvas';
      this.emit('statechange');
      this.emit('action', perm.action);
      return;
    }

    // 画布工具书签（平级，点击选中摆动）
    const tool = this.canvasTools.find(t => t.id === id);
    if (tool) {
      this.activeId = id;
      this.emit('statechange');
      if (tool.action) this.emit('action', tool.action);
      return;
    }

    const concept = this.concepts.find(c => c.id === id);
    if (concept) {
      if (this.activeParent === id) {
        this.activeParent = null;
      } else {
        this.activeParent = id;
      }
      this.activeId = id;
      this.emit('statechange');
      if (concept.action) this.emit('action', concept.action);
      return;
    }

    // 子级书签 — 选中其父概念书签（保持父级摆动选中态）
    for (const c of this.concepts) {
      const child = c.children.find(ch => ch.id === id);
      if (child) {
        this.activeId = c.id;
        this.emit('statechange');
        this.emit('action', child.action);
        return;
      }
    }
  }

  resetConcepts() {
    this.activeParent = null;
    this.emit('statechange');
  }

  getRenderState() {
    const concepts = this.mode === 'canvas' ? this.canvasTools : this.concepts;
    const parent = concepts.find(c => c.id === this.activeParent);
    return {
      permanent: this.permanent.map(p => ({ ...p, isActive: p.id === this.activeId })),
      concepts: concepts.map(c => ({
        ...c,
        isParent: c.id === this.activeParent,
        isActive: c.id === this.activeId,
      })),
      activeChildren: parent ? (parent.children || []) : [],
      activeParent: this.activeParent,
      activeId: this.activeId,
      mode: this.mode,
    };
  }
}
