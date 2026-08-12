import { TransformControls } from 'three/addons/controls/TransformControls.js';
import * as THREE from 'three';
import { UpdateObjectCommand } from '../core/Commands.js';
import { clone } from '../shared/utils.js';

/**
 * 交互控制层 — TransformControls 三模式 Gizmo（移动/旋转/缩放）
 */
export class TransformController {
  constructor() {
    this.controls = null;
    this.viewport = null;
    this.sceneManager = null;
    this._isDragging = false;
    this._mode = 'translate';
    this._box = null;
    this._topologyEditing = false;
    this._transformBefore = null;
    this._dragTargetId = null;
    this._dragListener = null;
    this._objectChangeListener = null;
  }

  init(renderer, viewport, sceneManager) {
    this.viewport = viewport;
    this.sceneManager = sceneManager;

    this.controls = new TransformControls(viewport.camera, renderer.domElement);
    this.controls.setMode(this._mode);
    this.controls.setSize(0.85);

    // Handle API differences: r169+ uses getHelper()
    const helper = this.controls.getHelper ? this.controls.getHelper() : this.controls;
    viewport.scene.add(helper);

    // 禁用 orbit 控件在 gizmo 拖拽期间
    this._dragListener = (event) => {
      this._isDragging = event.value;
      viewport.controls.enabled = !event.value;
      const mesh = this.controls.object;
      if (event.value && mesh?.userData?.sceneObjectId) {
        const object = this.sceneManager.getObject(mesh.userData.sceneObjectId);
        this._transformBefore = object ? clone(object.data) : null;
        // 捕获本次拖拽的目标对象 id：dragend 时若选中对象已切换，丢弃 before 防止 A 的旧数据写回 B
        this._dragTargetId = mesh.userData.sceneObjectId;
      } else if (event.value) {
        // 拖拽起点未命中有效对象（如选中集为空）：清空残留 targetId，避免后续误用旧 id
        this._dragTargetId = null;
      } else if (!event.value && this._transformBefore && mesh?.userData?.sceneObjectId) {
        if (mesh.userData.sceneObjectId === this._dragTargetId) {
          const object = this.sceneManager.getObject(mesh.userData.sceneObjectId);
          if (object) {
            const after = clone(object.data);
            this.sceneManager.pushCommand(new UpdateObjectCommand(this.sceneManager, mesh.userData.sceneObjectId, this._transformBefore, after));
          }
        }
        // 拖拽结束：包围盒重算一次，覆盖拖拽中跳过的 setFromObject，保证选中框落在最终位置
        if (this._box) this._box.setFromObject(mesh);
        this._transformBefore = null;
        this._dragTargetId = null;
      }
    };
    this.controls.addEventListener('dragging-changed', this._dragListener);

    // Sync transform changes back to data model — O(1) via userData
    this._objectChangeListener = () => {
      const mesh = this.controls.object;
      if (!mesh) return;
      const id = mesh.userData?.sceneObjectId;
      if (id) {
        this.sceneManager.syncTransformFromMesh(id);
        // 性能：拖拽中 objectChange 每帧触发，跳过 BoxHelper.setFromObject 的全量遍历（大网格成本高）；
        // 包围盒在 dragend 由 _dragListener 重算一次，避免每帧重复计算。
        if (this._box && !this._isDragging) this._box.setFromObject(mesh);
      }
    };
    this.controls.addEventListener('objectChange', this._objectChangeListener);

    // Auto-attach/detach on selection change
    this._offSelection = sceneManager.on('selectionchange', ({ selection }) => {
      if (selection.length === 0) {
        this.detach();
        this._hideBox();
      } else {
        const obj = this.sceneManager.getObject(selection[0]);
        if (obj) { this.attach(obj.mesh); this._showBox(obj.mesh); }
      }
    });

    // Detach if the attached object is removed
    this._offObjectRemoved = sceneManager.on('objectremoved', () => {
      const attached = this.controls?.object;
      if (!attached) return;
      let found = false;
      for (const obj of this.sceneManager.objects.values()) {
        if (obj.mesh === attached) { found = true; break; }
      }
      if (!found) this.detach();
    });

    return this;
  }

  setMode(mode) {
    this._mode = mode;
    if (this.controls) this.controls.setMode(mode);
  }

  setTopologyEditing(active) {
    this._topologyEditing = Boolean(active);
    if (this.controls) this.controls.enabled = !this._topologyEditing;
    if (this._topologyEditing) {
      this.detach();
    } else {
      const selected = this.sceneManager?.getPrimarySelection();
      if (selected) this.attach(selected.mesh);
    }
  }

  get mode() { return this._mode; }

  /** 是否处于拓扑编辑状态（供 SelectionController 等外部组件读取） */
  get topologyEditing() { return this._topologyEditing; }

  attach(mesh) {
    if (this.controls) this.controls.attach(mesh);
  }

  detach() {
    if (this.controls) this.controls.detach();
  }

  get isDragging() { return this._isDragging; }

  dispose() {
    this._offSelection?.(); this._offSelection = null;
    this._offObjectRemoved?.(); this._offObjectRemoved = null;
    // 移除控件的拖动/变换监听器，避免 dispose 后仍被回调
    if (this.controls) {
      if (this._dragListener) { this.controls.removeEventListener('dragging-changed', this._dragListener); this._dragListener = null; }
      if (this._objectChangeListener) { this.controls.removeEventListener('objectChange', this._objectChangeListener); this._objectChangeListener = null; }
      this.controls.dispose();
    }
    this._hideBox();
    this.controls = null;
  }

  _showBox(object) {
    if (!this.viewport?.scene) return;
    if (!this._box) {
      this._box = new THREE.BoxHelper(object, 0x6c5a91);
      this.viewport.scene.add(this._box);
    } else {
      this._box.setFromObject(object);
      this._box.visible = true;
    }
  }

  _hideBox() {
    if (!this._box) return;
    this.viewport?.scene?.remove(this._box);
    this._box.geometry?.dispose();
    this._box.material?.dispose();
    this._box = null;
  }
}
