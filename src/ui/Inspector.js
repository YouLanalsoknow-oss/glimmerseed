import { SceneManager } from '../core/SceneManager.js';
import { DEFAULT_MATERIAL } from '../shared/constants.js';
import { UpdateObjectCommand } from '../core/Commands.js';
import { clone } from '../shared/utils.js';
import { escapeHtml } from '../shared/escapeHtml.js';
import { schedule } from '../shared/throttleByRAF.js';

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;
const fmt = (v) => (v ?? 0).toFixed(2);

/**
 * 界面层 — 属性面板：名称、变换、材质编辑
 */
export class Inspector {
  constructor({ sceneManager }) {
    this.sceneManager = sceneManager;
    this._currentId = null;
    this._scheduleUpdate = schedule(() => this._updateValues());  // rAF 合并 — 同一帧内多次 objectchanged 只执行一次 DOM 更新
    this._transformInputs = null;  // 缓存 DOM 引用，避免每帧 querySelectorAll
    this._beforeSnapshot = null;   // M6: 输入开始时快照，失焦/change 时提交 UpdateObjectCommand
  }

  init() {
    this._offSelection = this.sceneManager.on('selectionchange', () => this.render());
    this._offObjectChanged = this.sceneManager.on('objectchanged', ({ id }) => {
      if (id === this._currentId) this._scheduleUpdate();
    });
  }

  dispose() {
    this._offSelection?.(); this._offSelection = null;
    this._offObjectChanged?.(); this._offObjectChanged = null;
    this._scheduleUpdate.cancel?.();
  }

  render() {
    const body = document.getElementById('inspectorBody');
    const sub = document.getElementById('inspectorSub');
    const obj = this.sceneManager.getPrimarySelection();

    if (!obj) {
      this._currentId = null;
      sub.textContent = '未选中';
      body.innerHTML = '<div class="empty-hint">未选中对象</div>';
      return;
    }

    this._currentId = obj.data.id;
    const d = obj.data;
    const t = d.transform;
    const m = d.material || { ...DEFAULT_MATERIAL };
    sub.textContent = SceneManager.getTypeName(d.type);

    body.innerHTML = `
      <input class="name-field" id="insp-name" type="text" value="${escapeHtml(d.name)}" placeholder="名称">

      <div class="field-group">
        <div class="field-group-title">位置</div>
        <div class="field-row">
          <div class="field"><label>X</label><input type="number" step="0.1" data-t="position" data-axis="0" value="${fmt(t.position?.[0] ?? 0)}"></div>
          <div class="field"><label>Y</label><input type="number" step="0.1" data-t="position" data-axis="1" value="${fmt(t.position?.[1] ?? 0)}"></div>
          <div class="field"><label>Z</label><input type="number" step="0.1" data-t="position" data-axis="2" value="${fmt(t.position?.[2] ?? 0)}"></div>
        </div>
      </div>

      <div class="field-group">
        <div class="field-group-title">旋转 (度)</div>
        <div class="field-row">
          <div class="field"><label>X</label><input type="number" step="1" data-t="rotation" data-axis="0" value="${fmt((t.rotation?.[0] ?? 0) * RAD2DEG)}"></div>
          <div class="field"><label>Y</label><input type="number" step="1" data-t="rotation" data-axis="1" value="${fmt((t.rotation?.[1] ?? 0) * RAD2DEG)}"></div>
          <div class="field"><label>Z</label><input type="number" step="1" data-t="rotation" data-axis="2" value="${fmt((t.rotation?.[2] ?? 0) * RAD2DEG)}"></div>
        </div>
      </div>

      <div class="field-group">
        <div class="field-group-title">缩放</div>
        <div class="field-row">
          <div class="field"><label>X</label><input type="number" step="0.1" data-t="scale" data-axis="0" value="${fmt(t.scale?.[0] ?? 0)}"></div>
          <div class="field"><label>Y</label><input type="number" step="0.1" data-t="scale" data-axis="1" value="${fmt(t.scale?.[1] ?? 0)}"></div>
          <div class="field"><label>Z</label><input type="number" step="0.1" data-t="scale" data-axis="2" value="${fmt(t.scale?.[2] ?? 0)}"></div>
        </div>
      </div>

      <div class="field-group">
        <div class="field-group-title">材质</div>
        <div class="color-field" style="margin-bottom:10px">
          <input type="color" id="insp-color" value="${this._hex(m.color)}">
          <input type="text" id="insp-color-text" value="${this._hex(m.color)}">
        </div>
        <div class="field" style="grid-template-columns:56px 1fr;margin-bottom:8px">
          <label style="text-align:left;padding-left:2px">金属度</label>
          <input type="range" min="0" max="1" step="0.05" id="insp-metalness" value="${m.metalness}" style="padding:0;border:0;background:none">
        </div>
        <div class="field" style="grid-template-columns:56px 1fr">
          <label style="text-align:left;padding-left:2px">粗糙度</label>
          <input type="range" min="0" max="1" step="0.05" id="insp-roughness" value="${m.roughness}" style="padding:0;border:0;background:none">
        </div>
      </div>
    `;

    this._bindEvents();
  }

  _bindEvents() {
    const body = document.getElementById('inspectorBody');

    // 缓存全部 DOM 引用，_updateValues 直接复用，避免每次 rAF getElementById
    this._transformInputs = body.querySelectorAll('[data-t]');
    this._nameEl = document.getElementById('insp-name');
    this._colorEl = document.getElementById('insp-color');
    this._colorText = document.getElementById('insp-color-text');
    this._metalEl = document.getElementById('insp-metalness');
    this._roughEl = document.getElementById('insp-roughness');

    const nameEl = document.getElementById('insp-name');
    if (nameEl) {
      nameEl.addEventListener('input', () => {
        this.sceneManager.updateName(this._currentId, nameEl.value);
      });
    }

    body.querySelectorAll('[data-t]').forEach(input => {
      input.addEventListener('input', () => this._onTransformInput(input));
      input.addEventListener('focus', () => this._beginSnapshot());
      input.addEventListener('blur', () => this._commitSnapshot());
    });

    const colorEl = document.getElementById('insp-color');
    const colorText = document.getElementById('insp-color-text');
    if (colorEl && colorText) {
      colorEl.addEventListener('input', () => {
        colorText.value = colorEl.value;
        this.sceneManager.updateMaterial(this._currentId, { color: colorEl.value });
      });
      colorEl.addEventListener('focus', () => this._beginSnapshot());
      colorEl.addEventListener('blur', () => this._commitSnapshot());
      colorText.addEventListener('focus', () => this._beginSnapshot());
      colorText.addEventListener('blur', () => this._commitSnapshot());
      colorText.addEventListener('change', () => {
        const val = colorText.value.trim();
        if (/^#[0-9a-fA-F]{6}$/.test(val)) {
          colorEl.value = val;
          this.sceneManager.updateMaterial(this._currentId, { color: val });
        } else {
          colorText.value = colorEl.value;
        }
        this._commitSnapshot();
      });
    }

    const metalEl = document.getElementById('insp-metalness');
    if (metalEl) {
      metalEl.addEventListener('input', () => {
        this.sceneManager.updateMaterial(this._currentId, { metalness: parseFloat(metalEl.value) });
      });
      metalEl.addEventListener('focus', () => this._beginSnapshot());
      metalEl.addEventListener('blur', () => this._commitSnapshot());
    }

    const roughEl = document.getElementById('insp-roughness');
    if (roughEl) {
      roughEl.addEventListener('input', () => {
        this.sceneManager.updateMaterial(this._currentId, { roughness: parseFloat(roughEl.value) });
      });
      roughEl.addEventListener('focus', () => this._beginSnapshot());
      roughEl.addEventListener('blur', () => this._commitSnapshot());
    }
  }

  // M6: 输入开始时快照，失焦/change 时提交一个 UpdateObjectCommand，保证撤销栈与 UI 一致
  _beginSnapshot() {
    const obj = this.sceneManager.getObject(this._currentId);
    this._beforeSnapshot = obj ? clone(obj.data) : null;
  }

  _commitSnapshot() {
    if (!this._beforeSnapshot) return;
    const obj = this.sceneManager.getObject(this._currentId);
    if (obj) {
      const after = clone(obj.data);
      if (JSON.stringify(after) !== JSON.stringify(this._beforeSnapshot)) {
        this.sceneManager.pushCommand(new UpdateObjectCommand(this.sceneManager, this._currentId, this._beforeSnapshot, after));
      }
    }
    this._beforeSnapshot = null;
  }

  _onTransformInput(input) {
    const type = input.dataset.t;
    const axis = parseInt(input.dataset.axis);
    const obj = this.sceneManager.getObject(this._currentId);
    if (!obj) return;
    const t = obj.data.transform;
    let val = parseFloat(input.value) || 0;
    if (type === 'scale') {
      // 缩放钳制到 [0.001, 1000]，避免 0/负缩放导致网格缩放为 0 不可见
      val = Math.min(1000, Math.max(0.001, val));
      input.value = String(val);
    } else if (type === 'rotation') {
      // 归一化到 [-180, 180] 度
      val = (((val % 360) + 540) % 360) - 180;
      val *= DEG2RAD;
    }
    const arr = [...t[type]];
    arr[axis] = val;
    this.sceneManager.updateTransform(this._currentId, { [type]: arr });
  }

  _updateValues() {
    const obj = this.sceneManager.getObject(this._currentId);
    if (!obj) return;
    const d = obj.data;
    const t = d.transform;
    const m = d.material;

    // 使用缓存的 DOM 引用，避免每帧 querySelectorAll
    const inputs = this._transformInputs;
    if (inputs) {
      inputs.forEach(input => {
        if (document.activeElement === input) return;
        const type = input.dataset.t;
        const axis = parseInt(input.dataset.axis);
        let val = t[type]?.[axis] ?? 0;
        if (type === 'rotation') {
          // 显示时归一化到 [-180, 180] 度
          val = (((val * RAD2DEG) % 360) + 540) % 360 - 180;
        } else if (type === 'scale') {
          // 显示时保持一致钳制，避免输入被外力改写为非法缩放
          val = Math.min(1000, Math.max(0.001, val));
        }
        input.value = fmt(val);
      });
    }

    if (this._nameEl && document.activeElement !== this._nameEl) this._nameEl.value = d.name;

    if (this._colorEl) this._colorEl.value = m.color;
    if (this._colorText && document.activeElement !== this._colorText) this._colorText.value = m.color;
    if (this._metalEl && document.activeElement !== this._metalEl) this._metalEl.value = m.metalness;
    if (this._roughEl && document.activeElement !== this._roughEl) this._roughEl.value = m.roughness;
  }

  /** 仅接受 #rrggbb，杜绝外部数据注入非法属性值 */
  _hex(v) {
    return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : DEFAULT_MATERIAL.color;
  }
}
