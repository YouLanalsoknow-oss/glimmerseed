import * as THREE from 'three';

/**
 * 交互控制层 — Raycaster 射线拾取，单击选中，Shift 追加选择，点击空白取消
 */
export class SelectionController {
  constructor() {
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.renderer = null;
    this.viewport = null;
    this.sceneManager = null;
    this.transformController = null;
    this._pointerStart = null;
  }

  init(renderer, viewport, sceneManager, transformController) {
    this.renderer = renderer;
    this.viewport = viewport;
    this.sceneManager = sceneManager;
    this.transformController = transformController;

    const dom = renderer.domElement;
    if (!dom) return;

    // 存储绑定引用，dispose 时才能正确 removeEventListener
    this._boundDown = (e) => this._onPointerDown(e);
    this._boundUp = (e) => this._onPointerUp(e);
    dom.addEventListener('pointerdown', this._boundDown);
    dom.addEventListener('pointerup', this._boundUp);
  }

  _onPointerDown(event) {
    if (event.button !== 0) return;
    this._pointerStart = { x: event.clientX, y: event.clientY };
  }

  _onPointerUp(event) {
    if (event.button !== 0 || !this._pointerStart) return;
    if (this.transformController?.topologyEditing) { this._pointerStart = null; return; }

    // Check if it was a click (not a drag)
    const dx = event.clientX - this._pointerStart.x;
    const dy = event.clientY - this._pointerStart.y;
    this._pointerStart = null;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) return; // It was a drag

    // Skip if TransformControls gizmo is under the pointer
    const tc = this.transformController?.controls;
    if (tc && tc.axis) return;

    const dom = this.renderer.domElement;
    const rect = dom.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointer, this.viewport.camera);

    const intersects = this.raycaster.intersectObjects(this.sceneManager.meshes, false);

    if (intersects.length > 0) {
      const hitMesh = intersects[0].object;
      const id = hitMesh.userData?.sceneObjectId;
      if (id) this.sceneManager.selectObject(id, event.shiftKey);
    } else {
      // Click on empty space — deselect
      this.sceneManager.deselectAll();
    }
  }

  dispose() {
    const dom = this.renderer?.domElement;
    if (dom) {
      dom.removeEventListener('pointerdown', this._boundDown);
      dom.removeEventListener('pointerup', this._boundUp);
    }
    this._boundDown = null;
    this._boundUp = null;
    this.renderer = null;
    this.viewport = null;
    this.sceneManager = null;
    this.transformController = null;
  }
}
