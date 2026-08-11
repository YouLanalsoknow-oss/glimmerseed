import * as THREE from 'three';
import { MeshEditSession } from './MeshEditSession.js';
import { TopologyEditCommand } from '../core/Commands.js';

/** 网格编辑协调器：负责会话、拾取覆盖层和对象级控制器切换。 */
export class MeshEditController {
  constructor() {
    this.renderer = null;
    this.viewport = null;
    this.sceneManager = null;
    this.transformController = null;
    this.session = null;
    this.mode = 'object';
    this.overlay = new THREE.Group();
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this._worldTemp = new THREE.Vector3();
    this._projectTemp = new THREE.Vector3();
    this._rightTemp = new THREE.Vector3();
    this._upTemp = new THREE.Vector3();
    this._drag = null;
    this._xray = false;
    this._boxSelect = false;
    this._boxStart = null;
    this._boxElement = null;
    this._hoverIndex = -1;
    this._orbitWasEnabled = undefined;
  }

  init(renderer, viewport, sceneManager, transformController) {
    this.renderer = renderer; this.viewport = viewport; this.sceneManager = sceneManager; this.transformController = transformController;
    viewport.scene.add(this.overlay);
    this._down = e => this._onDown(e); this._move = e => this._onMove(e); this._up = e => this._onUp(e);
    renderer.domElement.addEventListener('pointerdown', this._down);
    renderer.domElement.addEventListener('pointermove', this._move);
    renderer.domElement.addEventListener('pointerup', this._up);
    this._offSelection = sceneManager.on('selectionchange', () => this._syncTarget());
    return this;
  }

  setMode(mode) {
    if (!['object', 'vertex', 'edge', 'face'].includes(mode)) return;
    const previousMode = this.mode;
    this.mode = mode;
    this._diagnostic = null;
    this._hoverIndex = -1;
    if (mode === 'object') {
      this.session = null; this.transformController?.setTopologyEditing(false);
      this._clearOverlay();
      this._setStatus('对象模式');
      return;
    }
    // Switching between topology modes on the same mesh: keep session, preserve undo history
    if (this.session && previousMode !== 'object') {
      this.session.setMode(mode);
      this._renderOverlay();
      this._setStatus(`${mode === 'vertex' ? '顶点' : mode === 'edge' ? '边' : '面'}模式 · 已显示拓扑`);
      return;
    }
    this._setStatus(`${mode === 'vertex' ? '顶点' : mode === 'edge' ? '边' : '面'}模式：正在准备选中模型`);
    this._syncTarget(true);
  }

  refreshTarget() { if (this.mode !== 'object') this._syncTarget(true); }

  setXRay(enabled = !this._xray) {
    this._xray = Boolean(enabled);
    if (this.session?.mesh?.material) {
      const materials = Array.isArray(this.session.mesh.material) ? this.session.mesh.material : [this.session.mesh.material];
      materials.forEach(material => { material.transparent = this._xray; material.opacity = this._xray ? 0.28 : 1; material.depthWrite = !this._xray; material.needsUpdate = true; });
    }
    this._renderOverlay();
  }

  toggleBoxSelect() {
    this._boxSelect = !this._boxSelect;
    const status = document.getElementById('statusMode');
    if (status) status.textContent = this._boxSelect ? '框选模式 · 拖动选择顶点' : '拓扑编辑';
  }

  _projectVertex(vertex) {
    // 复用临时 Vector3，避免逐个顶点分配对象
    return this._projectTemp.set(vertex[0], vertex[1], vertex[2]).applyMatrix4(this.session.mesh.matrixWorld).project(this.viewport.camera);
  }

  _selectBox(start, end, additive) {
    const minX = Math.min(start.x, end.x); const maxX = Math.max(start.x, end.x);
    const minY = Math.min(start.y, end.y); const maxY = Math.max(start.y, end.y);
    if (!additive) this.session.clearSelection();
    this.session.topology.vertices.forEach((vertex, id) => {
      const projected = this._projectVertex(vertex);
      const x = (projected.x + 1) * 0.5; const y = (1 - projected.y) * 0.5;
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) this.session.selection.vertices.add(id);
    });
    this._renderOverlay();
  }

  _syncTarget(force = false) {
    const selected = this.sceneManager.getPrimarySelection()?.mesh;
    const editable = this._getEditableMesh(selected);
    if (!editable) {
      this.session = null; this._clearOverlay();
      this.transformController?.setTopologyEditing(false);
      this._setStatus('拓扑编辑需要先选中一个单独的网格对象');
      return;
    }
    if (!force && this.session?.mesh === editable) return;
    this._clearOverlay();
    this._hoverIndex = -1;
    if (this.mode === 'object') return;
    try { this.session = new MeshEditSession(editable); } catch (error) {
      this.session = null; this._clearOverlay(); this._setStatus(`拓扑编辑不可用：${error.message}`); return;
    }
    this.session.setMode(this.mode);
    this.transformController?.setTopologyEditing(true);
    this._renderOverlay();
    this._setStatus(`${this.mode === 'vertex' ? '顶点' : this.mode === 'edge' ? '边' : '面'}模式 · 已显示拓扑`);
  }

  _getEditableMesh(object) {
    if (object?.isMesh && object.geometry?.attributes?.position) return object;
    if (!object?.traverse) return null;
    let found = null; let count = 0;
    object.traverse(node => {
      if (node.isMesh && node.geometry?.attributes?.position) { found = node; count++; }
    });
    return count === 1 ? found : null;
  }

  _setStatus(message) {
    const status = document.getElementById('statusMode');
    if (status) status.textContent = message;
  }

  _onDown(event) {
    if (event.button !== 0 || !this.session) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const screen = { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
    if (this._boxSelect && this.mode === 'vertex') {
      this._boxStart = screen;
      this._drag = { type: 'box', start: screen, x: event.clientX, y: event.clientY };
      this._disableOrbit(event.pointerId);
      return;
    }
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.viewport.camera);
    let hit = false;
    if (this.mode === 'edge' && this._edges) {
      const radius = this.session.mesh.geometry.boundingSphere?.radius || 1;
      this.raycaster.params.Line.threshold = Math.max(radius * 0.04, 0.02);
      const edgeHit = this.raycaster.intersectObject(this._edges, false)[0];
      if (edgeHit?.index != null) {
        const edgeId = Math.floor(edgeHit.index / 2);
        if (event.altKey) this.session.selectBoundaryLoop(edgeId, event.shiftKey);
        else this.session.select(edgeId, event.shiftKey);
        hit = true;
      }
    } else if (this.mode === 'face') {
      const faceHit = this.raycaster.intersectObject(this.session.mesh, false)[0];
      if (faceHit?.faceIndex != null) { this.session.select(faceHit.faceIndex, event.shiftKey); hit = true; }
    } else if (this.mode === 'vertex') {
      this.raycaster.params.Points.threshold = Math.max((this.session.mesh.geometry.boundingSphere?.radius || 1) * 0.06, 0.04);
      const vertexHit = this.raycaster.intersectObject(this._vertexPoints, false)[0];
      if (vertexHit) {
        this.session.select(vertexHit.index, event.shiftKey);
        this.session.beginGesture();
        this._drag = { index: vertexHit.index, x: event.clientX, y: event.clientY, before: this._captureTopology() };
        this._disableOrbit(event.pointerId);
        hit = true;
      } else { this._setStatus('未命中顶点：请放大模型或开启框选模式'); }
    }
    if (!hit && !event.shiftKey) this.session.clearSelection();
    this._renderOverlay();
  }

  _onMove(event) {
    if (!this.session) return;
    if (this._drag?.type === 'box') { this._updateBoxVisual(event); return; }
    if (this._drag) {
      if (this.mode !== 'vertex') return;
      const dx = event.clientX - this._drag.x;
      const dy = event.clientY - this._drag.y;
      const factor = this._pixelToWorldFactor();
      // 复用预分配 Vector3，避免每帧新建临时对象
      const right = this._rightTemp.setFromMatrixColumn(this.viewport.camera.matrixWorld, 0);
      const up = this._upTemp.setFromMatrixColumn(this.viewport.camera.matrixWorld, 1);
      const delta = right.multiplyScalar(dx * factor).add(up.multiplyScalar(-dy * factor));
      this.session.moveVertices(delta);
      this._drag.x = event.clientX; this._drag.y = event.clientY;
      this._updateOverlayPositions();
      return;
    }
    this._updateHover(event);
  }

  _updateHover(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.viewport.camera);
    let hoverIndex = -1;
    if (this.mode === 'vertex' && this._vertexPoints) {
      this.raycaster.params.Points.threshold = Math.max((this.session.mesh.geometry.boundingSphere?.radius || 1) * 0.06, 0.04);
      const hit = this.raycaster.intersectObject(this._vertexPoints, false)[0];
      hoverIndex = hit?.index ?? -1;
    } else if (this.mode === 'edge' && this._edges) {
      const radius = this.session.mesh.geometry.boundingSphere?.radius || 1;
      this.raycaster.params.Line.threshold = Math.max(radius * 0.04, 0.02);
      const hit = this.raycaster.intersectObject(this._edges, false)[0];
      hoverIndex = hit?.index != null ? Math.floor(hit.index / 2) : -1;
    } else if (this.mode === 'face') {
      const hit = this.raycaster.intersectObject(this.session.mesh, false)[0];
      hoverIndex = hit?.faceIndex ?? -1;
    }
    if (hoverIndex !== this._hoverIndex) {
      this._hoverIndex = hoverIndex;
      this._updateHoverOnly();
    }
  }

  _pixelToWorldFactor() {
    const camera = this.viewport.camera;
    const mesh = this.session?.mesh;
    if (!camera?.isPerspectiveCamera || !mesh) return 0.01;
    const distance = camera.position.distanceTo(mesh.position);
    const fov = camera.fov ? camera.fov * Math.PI / 180 : Math.PI / 4;
    const screenHeight = this.renderer.domElement.clientHeight || 600;
    return (2 * distance * Math.tan(fov / 2)) / screenHeight;
  }

  _updateBoxVisual(event) {
    if (!this._boxElement) {
      this._boxElement = document.createElement('div');
      this._boxElement.style.cssText = 'position:fixed;border:1px solid #d18b53;background:rgba(209,139,83,0.12);pointer-events:none;z-index:1000;';
      document.body.appendChild(this._boxElement);
    }
    const rect = this.renderer.domElement.getBoundingClientRect();
    const startX = this._drag.start.x * rect.width + rect.left;
    const startY = this._drag.start.y * rect.height + rect.top;
    const endX = event.clientX;
    const endY = event.clientY;
    this._boxElement.style.left = Math.min(startX, endX) + 'px';
    this._boxElement.style.top = Math.min(startY, endY) + 'px';
    this._boxElement.style.width = Math.abs(endX - startX) + 'px';
    this._boxElement.style.height = Math.abs(endY - startY) + 'px';
    this._boxElement.style.display = 'block';
  }

  _removeBoxVisual() {
    if (this._boxElement) { this._boxElement.remove(); this._boxElement = null; }
  }

  _onUp(event) {
    if (this._drag?.type === 'box' && this._boxStart) {
      const rect = this.renderer.domElement.getBoundingClientRect();
      const end = { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
      this._selectBox(this._boxStart, end, event.shiftKey);
    }
    this._removeBoxVisual();
    const wasVertexDrag = this._drag && this.mode === 'vertex';
    if (wasVertexDrag) this._renderOverlay();
    this._enableOrbit(event.pointerId);
    this.session?.endGesture();
    if (wasVertexDrag) this._syncGeometry(this._drag.before);
    this._drag = null; this._boxStart = null;
  }

  _disableOrbit(pointerId) {
    if (this.viewport?.controls) {
      this._orbitWasEnabled = this.viewport.controls.enabled;
      this.viewport.controls.enabled = false;
    }
    if (pointerId != null) {
      try { this.renderer.domElement.setPointerCapture(pointerId); } catch (_) {}
    }
  }

  _enableOrbit(pointerId) {
    if (pointerId != null) {
      try { this.renderer.domElement.releasePointerCapture(pointerId); } catch (_) {}
    }
    if (this._orbitWasEnabled !== undefined) {
      if (this.viewport?.controls) this.viewport.controls.enabled = this._orbitWasEnabled;
      this._orbitWasEnabled = undefined;
    }
  }

  handleKey(event) {
    if (!this.session) return false;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault(); event.shiftKey ? this.redo() : this.undo(); return true;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault(); this.redo(); return true;
    }
    if (event.key.toLowerCase() === 'q') { event.preventDefault(); this.extrude(); return true; }
    if (event.key.toLowerCase() === 'k') { event.preventDefault(); this.cutLoop(); return true; }
    if (event.key.toLowerCase() === 'j') { event.preventDefault(); this.bridge(); return true; }
    if (event.key.toLowerCase() === 'i') { event.preventDefault(); this.diagnose(); return true; }
    if (event.key.toLowerCase() === 'h') { event.preventDefault(); this.setXRay(); return true; }
    if (event.key.toLowerCase() === 'g') { event.preventDefault(); this.toggleBoxSelect(); return true; }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (this.mode === 'face' && this.session?.selection.faces.size > 0) {
        event.preventDefault(); this.deleteSelected(); return true;
      }
      return false;
    }
    return false;
  }

  _syncGeometry(before = null) {
    const id = this.session?.mesh?.userData?.sceneObjectId;
    if (!id) return;
    const after = this.session.serialize();
    const topology = {
      vertices: after.vertices,
      indices: after.faces.flatMap(face => face),
      materialIndices: after.materialIndices,
      groups: this.session.mesh.geometry.groups.map(group => ({ ...group })),
    };
    // 用修订号判断是否有实际改动，避免全量 O(V) 的 JSON 序列化比较；
    // 拖拽未产生位移时 revision 不变，则不记录撤销命令。
    const changed = before ? before.revision !== this.session.revision : true;
    if (changed) {
      // 会话中的临时几何已更新；提交时只写入一次场景数据，再记录撤销命令。
      this.sceneManager.applyTopologyData(id, topology, { emit: false });
      this.sceneManager.pushCommand(new TopologyEditCommand(this.sceneManager, id, before, topology));
      // 拓扑变化未走 applyTopologyData 的默认 emit，需手动补发以触发自动保存。
      const record = this.sceneManager.getObject(id);
      this.sceneManager.emit('objectchanged', { id, data: record?.data });
      this.sceneManager.emit('scenechanged');
    } else {
      this.sceneManager.applyTopologyData(id, topology);
    }
    this.sceneManager.emit('topologyedited', { id, revision: this.session.revision });
  }

  _captureTopology() {
    if (!this.session) return null;
    const state = this.session.serialize();
    return { vertices: state.vertices, indices: state.faces.flatMap(face => face), materialIndices: state.materialIndices, groups: this.session.mesh.geometry.groups.map(group => ({ ...group })), revision: this.session.revision };
  }

  extrude(distance = 0) {
    const before = this._captureTopology();
    if (this.session?.extrudeSelectedFaces(distance)) { this._syncGeometry(before); this._renderOverlay(); }
    else this._notifyEditFailure('请选择有效面，或当前拓扑无法挤出');
  }

  cutLoop() {
    const before = this._captureTopology();
    if (this.mode === 'edge' && this.session?.cutEdgeLoop()) { this._syncGeometry(before); this._renderOverlay(); }
    else this._notifyEditFailure('请选择规则边环，环切无法跨越三角面或非流形区域');
  }

  bridge() {
    const before = this._captureTopology();
    if (this.mode === 'edge' && this.session?.bridgeSelectedBoundaries()) { this._syncGeometry(before); this._renderOverlay(); }
    else this._notifyEditFailure('桥接需要两条顶点数量一致的边界环');
  }

  diagnose() {
    const report = this.session?.diagnose();
    if (!report) return null;
    const status = document.getElementById('statusMode');
    if (status) status.textContent = report.valid
      ? `拓扑正常 · ${report.counts.triangles} 三角面`
      : `拓扑问题 · ${report.issues.length} 项`;
    this._diagnostic = report;
    this._renderOverlay();
    return report;
  }

  deleteSelected() {
    if (this.mode !== 'face') return;
    const before = this._captureTopology();
    if (this.session?.deleteSelectedFaces()) { this._syncGeometry(before); this._renderOverlay(); }
    else this._notifyEditFailure('请选择要删除的面');
  }

  _notifyEditFailure(message) {
    const status = document.getElementById('statusMode');
    if (!status) return;
    const previous = status.textContent;
    status.textContent = message;
    clearTimeout(this._failureTimer);
    this._failureTimer = setTimeout(() => { if (status.isConnected) status.textContent = previous; }, 2800);
  }

  undo() {
    if (this.sceneManager?.undo()) { this._syncTarget(true); this._renderOverlay(); }
  }
  redo() {
    if (this.sceneManager?.redo()) { this._syncTarget(true); this._renderOverlay(); }
  }

  _renderOverlay() {
    this._clearOverlay(); if (!this.session) return;
    const { vertices, edges, faces } = this.session.topology;
    const invalidEdges = new Set(this._diagnostic?.nonManifoldEdges || []);
    const position = this._worldPositions(vertices);
    if (this.mode === 'vertex') {
      const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
      const radius = this.session.mesh.geometry.boundingSphere?.radius || 1;
      this._vertexPoints = new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0x6c5a91, size: Math.max(radius * 0.035, 0.025), sizeAttenuation: true, depthTest: false }));
      this._vertexPoints.renderOrder = 20; this.overlay.add(this._vertexPoints);
      const selectedPositions = new Float32Array(this.session.selection.vertices.size * 3);
      let offset = 0;
      [...this.session.selection.vertices].forEach(id => { if (vertices[id]) { this._worldVertex(vertices[id], selectedPositions, offset); offset += 3; } });
      this._selectedVertices = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xd18b53, size: Math.max(radius * 0.07, 0.045), sizeAttenuation: true, depthTest: false }));
      this._selectedVertices.geometry.setAttribute('position', new THREE.Float32BufferAttribute(selectedPositions, 3));
      this._selectedVertices.renderOrder = 21; this.overlay.add(this._selectedVertices);
    } else {
      const edgePositions = new Float32Array(edges.length * 6);
      edges.forEach((edge, i) => { edge.vertices.forEach((id, n) => this._worldVertex(vertices[id], edgePositions, i * 6 + n * 3)); });
      const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(edgePositions, 3));
      this._edges = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0x6c5a91, depthTest: false, transparent: true, opacity: 0.9 }));
      this._edges.renderOrder = 20; this.overlay.add(this._edges);
      this._selectedEdges = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xd18b53, depthTest: false, linewidth: 2 }));
      const selectedPositions = new Float32Array(this.session.selection.edges.size * 6);
      let offset = 0;
      [...this.session.selection.edges].forEach(id => {
        const edge = edges[id];
        if (!edge) return;
        edge.vertices.forEach(vertexId => { if (vertices[vertexId]) { this._worldVertex(vertices[vertexId], selectedPositions, offset); offset += 3; } });
      });
      this._selectedEdges.geometry.setAttribute('position', new THREE.Float32BufferAttribute(selectedPositions, 3));
      this._selectedEdges.renderOrder = 21; this.overlay.add(this._selectedEdges);
      if (this.mode === 'face' && this.session.selection.faces.size > 0) {
        const facePositions = new Float32Array(this.session.selection.faces.size * 9);
        let offset = 0;
        this.session.selection.faces.forEach(faceId => {
          const face = faces[faceId];
          if (face) face.vertices.forEach(vId => { if (vertices[vId]) { this._worldVertex(vertices[vId], facePositions, offset); offset += 3; } });
        });
        if (offset) {
          const faceGeo = new THREE.BufferGeometry();
          faceGeo.setAttribute('position', new THREE.Float32BufferAttribute(facePositions.subarray(0, offset), 3));
          this._selectedFaces = new THREE.Mesh(faceGeo, new THREE.MeshBasicMaterial({ color: 0xd18b53, transparent: true, opacity: 0.35, depthTest: false, side: THREE.DoubleSide }));
          this._selectedFaces.renderOrder = 19; this.overlay.add(this._selectedFaces);
        }
      }
      if (invalidEdges.size) {
        const errorPositions = new Float32Array(invalidEdges.size * 6);
        let offset = 0;
        invalidEdges.forEach(id => edges[id]?.vertices.forEach(vertexId => { if (vertices[vertexId]) { this._worldVertex(vertices[vertexId], errorPositions, offset); offset += 3; } }));
        const errorGeometry = new THREE.BufferGeometry();
        errorGeometry.setAttribute('position', new THREE.Float32BufferAttribute(errorPositions.subarray(0, offset), 3));
        this._errorEdges = new THREE.LineSegments(errorGeometry, new THREE.LineBasicMaterial({ color: 0xc55f64, depthTest: false, linewidth: 3 }));
        this._errorEdges.renderOrder = 22; this.overlay.add(this._errorEdges);
      }
    }
    this._createHoverElement();
    this.sceneManager?.emit('topologyoverlay');
  }

  /** 仅更新悬停元素 — hover 变化时不重建全部覆盖层，大幅减少 GC 压力 */
  _updateHoverOnly() {
    this._disposeHoverElement();
    this._createHoverElement();
    this.sceneManager?.emit('topologyoverlay');
  }

  _disposeHoverElement() {
    if (!this._hoverElement) return;
    this._hoverElement.geometry.dispose();
    this._hoverElement.material.dispose();
    this.overlay.remove(this._hoverElement);
    this._hoverElement = null;
  }

  _createHoverElement() {
    if (!this.session || this._hoverIndex < 0) return;
    const { vertices, edges, faces } = this.session.topology;
    const radius = this.session.mesh.geometry.boundingSphere?.radius || 1;

    if (this.mode === 'vertex' && this._hoverIndex < vertices.length && !this.session.selection.vertices.has(this._hoverIndex)) {
      const hoverVertex = new Float32Array(3);
      this._worldVertex(vertices[this._hoverIndex], hoverVertex, 0);
      const hoverGeo = new THREE.BufferGeometry();
      hoverGeo.setAttribute('position', new THREE.Float32BufferAttribute(hoverVertex, 3));
      this._hoverElement = new THREE.Points(hoverGeo, new THREE.PointsMaterial({ color: 0x8b7ba8, size: Math.max(radius * 0.06, 0.035), sizeAttenuation: true, depthTest: false }));
      this._hoverElement.renderOrder = 19; this.overlay.add(this._hoverElement);
    } else if (this.mode === 'edge' && this._hoverIndex < edges.length && !this.session.selection.edges.has(this._hoverIndex)) {
      const edge = edges[this._hoverIndex];
      const hoverPositions = new Float32Array(6);
      let offset = 0;
      edge.vertices.forEach(vId => { if (vertices[vId]) { this._worldVertex(vertices[vId], hoverPositions, offset); offset += 3; } });
      const hoverGeo = new THREE.BufferGeometry();
      hoverGeo.setAttribute('position', new THREE.Float32BufferAttribute(hoverPositions.subarray(0, offset), 3));
      this._hoverElement = new THREE.LineSegments(hoverGeo, new THREE.LineBasicMaterial({ color: 0x8b7ba8, depthTest: false, linewidth: 3 }));
      this._hoverElement.renderOrder = 19; this.overlay.add(this._hoverElement);
    } else if (this.mode === 'face' && this._hoverIndex < faces.length && !this.session.selection.faces.has(this._hoverIndex)) {
      const face = faces[this._hoverIndex];
      const hoverPositions = new Float32Array(9);
      let offset = 0;
      face.vertices.forEach(vId => { if (vertices[vId]) { this._worldVertex(vertices[vId], hoverPositions, offset); offset += 3; } });
      const hoverGeo = new THREE.BufferGeometry();
      hoverGeo.setAttribute('position', new THREE.Float32BufferAttribute(hoverPositions.subarray(0, offset), 3));
      this._hoverElement = new THREE.Mesh(hoverGeo, new THREE.MeshBasicMaterial({ color: 0x8b7ba8, transparent: true, opacity: 0.25, depthTest: false, side: THREE.DoubleSide }));
      this._hoverElement.renderOrder = 18; this.overlay.add(this._hoverElement);
    }
  }

  /** 将顶点写入世界坐标。target 缺省时仅写入 _worldTemp 并返回；否则写入 target[offset..offset+2]。 */
  _worldVertex(vertex, target = null, offset = 0) {
    const t = this._worldTemp.set(vertex[0], vertex[1], vertex[2]).applyMatrix4(this.session.mesh.matrixWorld);
    if (target) {
      target[offset] = t.x;
      target[offset + 1] = t.y;
      target[offset + 2] = t.z;
    }
    return t;
  }

  _worldPositions(vertices) {
    const positions = new Float32Array(vertices.length * 3);
    vertices.forEach((vertex, index) => this._worldVertex(vertex, positions, index * 3));
    return positions;
  }

  /** 拖拽期间轻量更新 — 仅刷新已有几何体的 position 属性，不重建对象 */
  _updateOverlayPositions() {
    if (!this.session) return;
    const { vertices } = this.session.topology;
    // 拖拽只移动选中的顶点，因此仅更新这些顶点的覆盖层位置，避免 O(全部顶点)
    const moved = [...this.session.selection.vertices];
    if (this._vertexPoints) {
      const attr = this._vertexPoints.geometry.attributes.position;
      for (const id of moved) {
        if (!vertices[id]) continue;
        this._worldVertex(vertices[id]);
        attr.setXYZ(id, this._worldTemp.x, this._worldTemp.y, this._worldTemp.z);
      }
      attr.needsUpdate = true;
    }
    if (this._selectedVertices) {
      const attr = this._selectedVertices.geometry.attributes.position;
      moved.forEach((id, i) => {
        if (vertices[id]) {
          this._worldVertex(vertices[id]);
          attr.setXYZ(i, this._worldTemp.x, this._worldTemp.y, this._worldTemp.z);
        }
      });
      attr.needsUpdate = true;
    }
    this.sceneManager?.emit('topologyoverlay');
  }

  _clearOverlay() {
    this._vertexPoints?.geometry.dispose(); this._vertexPoints?.material.dispose();
    this._edges?.geometry.dispose(); this._edges?.material.dispose();
    this._selectedEdges?.geometry.dispose(); this._selectedEdges?.material.dispose();
    this._selectedVertices?.geometry.dispose(); this._selectedVertices?.material.dispose();
    this._selectedFaces?.geometry.dispose(); this._selectedFaces?.material.dispose();
    this._hoverElement?.geometry.dispose(); this._hoverElement?.material.dispose();
    this._errorEdges?.geometry.dispose(); this._errorEdges?.material.dispose();
    this._vertexPoints = null; this._selectedVertices = null; this._edges = null; this._selectedEdges = null; this._selectedFaces = null; this._hoverElement = null; this._errorEdges = null;
    while (this.overlay.children.length) this.overlay.remove(this.overlay.children[0]);
  }

  dispose() {
    this._clearOverlay(); this._removeBoxVisual(); this.transformController?.setTopologyEditing(false);
    this._offSelection?.(); this._offSelection = null;
    this.renderer?.domElement.removeEventListener('pointerdown', this._down);
    this.renderer?.domElement.removeEventListener('pointermove', this._move);
    this.renderer?.domElement.removeEventListener('pointerup', this._up);
    this.viewport?.scene.remove(this.overlay);
    this.session = null;
  }
}
