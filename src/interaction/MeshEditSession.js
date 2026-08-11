import * as THREE from 'three';
import { HalfEdgeMesh } from './HalfEdgeMesh.js';
import { clone } from '../shared/utils.js';

/**
 * 可扩展拓扑编辑会话。
 *
 * 设计原则：
 * 1. 编辑会话不直接污染 SceneManager 的对象数据。
 * 2. 内部统一为 indexed triangle topology，顶点/边/面选择使用稳定索引。
 * 3. 每次提交生成快照，后续可接入统一 Command/协同编辑协议。
 */
export class MeshEditSession {
  constructor(mesh) {
    if (!mesh?.isMesh || !mesh.geometry?.attributes?.position) {
      throw new Error('MeshEditSession requires a mesh with position attribute');
    }
    this.mesh = mesh;
    this.geometry = mesh.geometry;
    this.halfEdge = HalfEdgeMesh.fromBufferGeometry(this.geometry);
    this.topology = this.halfEdge.toTopology();
    this.selection = { vertices: new Set(), edges: new Set(), faces: new Set() };
    this.mode = 'vertex';
    this.revision = 0;
    this._gesture = false;
    this._gestureMoved = false;
    this._attributes = this._captureAttributes();
    this._materialGroups = mesh.geometry.groups.map(group => ({ ...group }));
    // 每个三角面保存材质槽位，避免拓扑数量变化后仅按旧 start/count 截断分组。
    this.topology.faces.forEach((face, faceId) => {
      face.materialIndex = this._materialIndexForFace(faceId);
    });
    this.lastError = '';
  }

  static fromGeometry(geometry) {
    return HalfEdgeMesh.fromBufferGeometry(geometry).toTopology();
  }

  get counts() {
    return {
      vertices: this.topology.vertices.length,
      edges: this.topology.edges.length,
      faces: this.topology.faces.length,
      triangles: this.topology.faces.length,
    };
  }

  serialize() {
    return {
      vertices: this.topology.vertices.map(vertex => [...vertex]),
      faces: this.topology.faces.map(face => [...face.vertices]),
      materialIndices: this.topology.faces.map(face => face.materialIndex ?? 0),
    };
  }

  _materialIndexForFace(faceId) {
    const start = faceId * 3;
    const group = this._materialGroups.find(item => start >= item.start && start < item.start + item.count);
    return group?.materialIndex ?? 0;
  }

  diagnose() {
    const { vertices, edges, faces } = this.topology;
    const issues = [];
    const used = new Set();
    const faceKeys = new Map();
    const vertexKeys = new Map();
    vertices.forEach((vertex, id) => {
      const key = vertex.map(value => Number(value).toFixed(6)).join(':');
      if (vertexKeys.has(key)) issues.push({ type: 'duplicate-vertex', ids: [vertexKeys.get(key), id] });
      else vertexKeys.set(key, id);
    });
    faces.forEach((face, id) => {
      const [a, b, c] = face.vertices;
      face.vertices.forEach(vertex => used.add(vertex));
      const key = [...face.vertices].sort((x, y) => x - y).join(':');
      if (faceKeys.has(key)) issues.push({ type: 'duplicate-face', ids: [faceKeys.get(key), id] });
      else faceKeys.set(key, id);
      if (a === b || b === c || c === a || this._triangleArea(face.vertices) < 1e-8) {
        issues.push({ type: 'zero-area-face', id });
      }
    });
    vertices.forEach((_, id) => {
      if (!used.has(id)) issues.push({ type: 'isolated-vertex', id });
    });
    const nonManifoldEdges = edges.map((edge, id) => edge.faces.length > 2 ? id : -1).filter(id => id >= 0);
    const boundaryEdges = edges.map((edge, id) => edge.faces.length === 1 ? id : -1).filter(id => id >= 0);
    const boundaryLoops = this._edgeComponents(boundaryEdges);
    nonManifoldEdges.forEach(id => issues.push({ type: 'non-manifold-edge', id }));
    return {
      valid: issues.length === 0,
      issues,
      counts: this.counts,
      boundaryEdges: boundaryEdges.length,
      boundaryLoops: boundaryLoops.length,
      nonManifoldEdges,
    };
  }

  _triangleArea(vertices) {
    const a = this.topology.vertices[vertices[0]];
    const b = this.topology.vertices[vertices[1]];
    const c = this.topology.vertices[vertices[2]];
    if (!a || !b || !c) return 0;
    // 标量运算避免 Vector3 对象分配
    const abx = b[0]-a[0], aby = b[1]-a[1], abz = b[2]-a[2];
    const acx = c[0]-a[0], acy = c[1]-a[1], acz = c[2]-a[2];
    const cx = aby*acz - abz*acy;
    const cy = abz*acx - abx*acz;
    const cz = abx*acy - aby*acx;
    return Math.sqrt(cx*cx + cy*cy + cz*cz) * 0.5;
  }

  setMode(mode) {
    if (!['vertex', 'edge', 'face'].includes(mode)) throw new Error(`Unknown topology mode: ${mode}`);
    this.mode = mode;
    this.clearSelection();
  }

  select(index, additive = false) {
    const bucket = this.selection[`${this.mode}s`];
    if (!additive) this.clearSelection();
    if (Number.isInteger(index) && bucket) bucket.add(index);
    return this.getSelection();
  }

  /**
   * 环切/边分割：对选中边以及相邻三角面中的连续边插入中点。
   * 三角网格没有天然四边环，因此这里采用拓扑邻接传播，保持所有面有效。
   */
  cutEdgeLoop(edgeId = null, ratio = 0.5) {
    const start = edgeId ?? [...this.selection.edges][0];
    if (!Number.isInteger(start) || !this.topology.edges[start]) return false;
    let cutEdges = this.halfEdge?.collectEdgeLoop?.(start);
    if (!cutEdges || cutEdges.size <= 1) {
      // Triangle meshes: loop detection returns only the start edge.
      // Fall back to all selected edges for multi-edge subdivision.
      cutEdges = this.selection.edges.size > 0 ? new Set(this.selection.edges) : new Set([start]);
    }
    if (!cutEdges.size) return false;
    const before = this._capture();
    const midpoint = new Map();
    cutEdges.forEach(id => {
      const edge = this.topology.edges[id];
      const a = this.topology.vertices[edge.vertices[0]];
      const b = this.topology.vertices[edge.vertices[1]];
      midpoint.set(id, this.topology.vertices.push([
        a[0] + (b[0] - a[0]) * ratio,
        a[1] + (b[1] - a[1]) * ratio,
        a[2] + (b[2] - a[2]) * ratio,
      ]) - 1);
    });
    const faces = [];
    this.topology.faces.forEach(face => {
      const polygon = [];
      face.vertices.forEach((vertex, index) => {
        polygon.push(vertex);
        const edge = face.edges[index];
        if (midpoint.has(edge)) polygon.push(midpoint.get(edge));
      });
      const materialIndex = face.materialIndex ?? 0;
      if (polygon.length === 3) faces.push({ vertices: polygon, edges: [], materialIndex });
      else for (let i = 1; i < polygon.length - 1; i++) faces.push({ vertices: [polygon[0], polygon[i], polygon[i + 1]], edges: [], materialIndex });
    });
    this.topology.faces = faces;
    this.clearSelection();
    // 校验与回滚统一由 _commitOrRollback 处理（内部会重建边并做一次拓扑校验）
    return this._commitOrRollback(before);
  }

  /** 连接两条选中的边界环，要求两个环顶点数量一致。 */
  bridgeSelectedBoundaries() {
    const selected = [...this.selection.edges].filter(id => this.topology.edges[id]?.faces.length === 1);
    const loops = this._edgeComponents(selected);
    if (loops.length !== 2 || loops[0].length !== loops[1].length || loops[0].length < 3) return false;
    let aligned = this._alignLoops(loops[0], loops[1]);
    if (!aligned) return false;
    // 校正缠绕方向：桥接面法线应与两环中心连线方向一致
    const center0 = this._loopCenter(loops[0]);
    const center1 = this._loopCenter(aligned);
    const bridgeDir = center1.clone().sub(center0);
    const va = new THREE.Vector3(...this.topology.vertices[loops[0][0]]);
    const vb = new THREE.Vector3(...this.topology.vertices[loops[0][1]]);
    const vc = new THREE.Vector3(...this.topology.vertices[aligned[1] % aligned.length]);
    const normal = new THREE.Vector3().crossVectors(vb.clone().sub(va), vc.clone().sub(va));
    if (normal.dot(bridgeDir) < 0) aligned = [...aligned].reverse();
    const before = this._capture();
    const faces = [];
    for (let i = 0; i < loops[0].length; i++) {
      const a = loops[0][i]; const b = loops[0][(i + 1) % loops[0].length];
      const c = aligned[(i + 1) % aligned.length]; const d = aligned[i];
      faces.push({ vertices: [a, b, c], edges: [], materialIndex: 0 }, { vertices: [a, c, d], edges: [], materialIndex: 0 });
    }
    this.topology.faces.push(...faces);
    this.clearSelection();
    return this._commitOrRollback(before);
  }

  _loopCenter(loop) {
    const center = new THREE.Vector3();
    loop.forEach(id => center.add(new THREE.Vector3(...this.topology.vertices[id])));
    return center.divideScalar(Math.max(loop.length, 1));
  }

  selectBoundaryLoop(edgeId = null, additive = false) {
    const start = edgeId ?? [...this.selection.edges][0];
    if (!Number.isInteger(start) || this.topology.edges[start]?.faces.length !== 1) return false;
    // Build vertex-to-boundary-edge map for O(1) neighbor lookup
    const vertexEdges = new Map();
    this.topology.edges.forEach((edge, id) => {
      if (edge.faces.length !== 1) return;
      edge.vertices.forEach(v => {
        if (!vertexEdges.has(v)) vertexEdges.set(v, []);
        vertexEdges.get(v).push(id);
      });
    });
    const ids = new Set([start]); const queue = [start];
    while (queue.length) {
      const edge = this.topology.edges[queue.shift()];
      edge.vertices.forEach(vertex => {
        (vertexEdges.get(vertex) || []).forEach(id => {
          if (!ids.has(id)) { ids.add(id); queue.push(id); }
        });
      });
    }
    if (!additive) this.selection.edges.clear();
    ids.forEach(id => this.selection.edges.add(id));
    return true;
  }

  _edgeComponents(edgeIds) {
    // 先建 顶点→边 邻接表，再用 BFS 分组，避免原实现每轮全量扫描的 O(n²)
    const vertexEdges = new Map();
    for (const id of edgeIds) {
      const edge = this.topology.edges[id];
      if (!edge) continue;
      for (const v of edge.vertices) {
        if (!vertexEdges.has(v)) vertexEdges.set(v, []);
        vertexEdges.get(v).push(id);
      }
    }
    const visited = new Set();
    const components = [];
    for (const seed of edgeIds) {
      if (visited.has(seed)) continue;
      visited.add(seed);
      const component = [seed];
      const queue = [seed];
      while (queue.length) {
        const id = queue.pop();
        for (const v of this.topology.edges[id].vertices) {
          for (const nid of (vertexEdges.get(v) || [])) {
            if (!visited.has(nid)) { visited.add(nid); component.push(nid); queue.push(nid); }
          }
        }
      }
      const ordered = this._orderLoop(component);
      if (ordered.length) components.push(ordered);
    }
    return components;
  }

  _orderLoop(edgeIds) {
    const edges = edgeIds.map(id => this.topology.edges[id].vertices);
    const next = new Map();
    edges.forEach(([a, b]) => { if (!next.has(a)) next.set(a, []); if (!next.has(b)) next.set(b, []); next.get(a).push(b); next.get(b).push(a); });
    const start = next.keys().next().value; if (start == null) return [];
    const result = [start]; let previous = null; let current = start;
    for (let i = 0; i < edges.length; i++) {
      const candidates = next.get(current) || []; const target = candidates.find(v => v !== previous && (v !== start || i === edges.length - 1));
      if (target == null || (target === start && i < edges.length - 1)) break;
      result.push(target); previous = current; current = target;
      if (current === start) break;
    }
    if (result[result.length - 1] === start) result.pop();
    return result;
  }

  _alignLoops(first, second) {
    if (first.length !== second.length) return null;
    const n = second.length;
    const a = this.topology.vertices[first[0]];
    // 对齐评分只取决于每个候选方向的"首顶点"，因此无需为每个偏移构造完整数组，
    // 直接按索引取首顶点即可定位最优偏移与方向，将 O(n²) 降为 O(n)。
    let bestOffset = 0; let bestReverse = false; let bestScore = Infinity;
    for (let offset = 0; offset < n; offset++) {
      const b0 = this.topology.vertices[second[offset]];
      const s0 = (a[0] - b0[0]) ** 2 + (a[1] - b0[1]) ** 2 + (a[2] - b0[2]) ** 2;
      if (s0 < bestScore) { bestScore = s0; bestOffset = offset; bestReverse = false; }
      const b1 = this.topology.vertices[second[(offset + n - 1) % n]];
      const s1 = (a[0] - b1[0]) ** 2 + (a[1] - b1[1]) ** 2 + (a[2] - b1[2]) ** 2;
      if (s1 < bestScore) { bestScore = s1; bestOffset = offset; bestReverse = true; }
    }
    const best = [];
    for (let i = 0; i < n; i++) best.push(second[(bestOffset + i) % n]);
    if (bestReverse) best.reverse();
    return best;
  }

  clearSelection() {
    Object.values(this.selection).forEach(set => set.clear());
  }

  getSelection() {
    return {
      vertices: [...this.selection.vertices],
      edges: [...this.selection.edges],
      faces: [...this.selection.faces],
      mode: this.mode,
    };
  }

  moveVertices(delta) {
    const ids = [...this.selection.vertices];
    if (!ids.length) return false;
    if (this._gesture) this._gestureMoved = true;
    ids.forEach(id => {
      const v = this.topology.vertices[id];
      if (v) { v[0] += delta.x || 0; v[1] += delta.y || 0; v[2] += delta.z || 0; }
    });
    if (this._gesture) {
      // 拖拽是最高频路径：只原地更新选中移动顶点的 position，法线/包围盒延后到 endGesture 统一重算
      this._writePositionsOnly(ids);
    } else {
      this._writeGeometry();
      this.halfEdge = new HalfEdgeMesh(this.topology);
      this.revision++;
    }
    return true;
  }

  beginGesture() { this._gesture = true; this._gestureMoved = false; }
  endGesture() {
    if (this._gesture && this._gestureMoved) {
      this._writeGeometry();
      this.halfEdge = new HalfEdgeMesh(this.topology);
      this.revision++;
    }
    this._gesture = false;
    this._gestureMoved = false;
  }

  deleteSelectedFaces() {
    const ids = new Set(this.selection.faces);
    if (!ids.size) return false;
    const before = this._capture();
    this.topology.faces = this.topology.faces.filter((_, id) => !ids.has(id));
    this.clearSelection();
    return this._commitOrRollback(before);
  }

  extrudeSelectedFaces(distance = 0) {
    const ids = [...this.selection.faces];
    if (!ids.length) return false;
    if (!distance) {
      const radius = this.mesh.geometry.boundingSphere?.radius || 1;
      distance = radius * 0.15;
    }
    const before = this._capture();
    const { vertices, faces } = this.topology;
    const selectedSet = new Set(ids);
    const center = this._meshCenter();

    // Calculate outward normal for each selected face
    const faceNormals = new Map();
    ids.forEach(id => {
      const face = faces[id];
      if (!face) return;
      const [pa, pb, pc] = face.vertices.map(v => vertices[v]);
      const ab = new THREE.Vector3(...pb).sub(new THREE.Vector3(...pa));
      const ac = new THREE.Vector3(...pc).sub(new THREE.Vector3(...pa));
      const cross = new THREE.Vector3().crossVectors(ab, ac);
      const faceCenter = new THREE.Vector3(...pa).add(new THREE.Vector3(...pb)).add(new THREE.Vector3(...pc)).divideScalar(3);
      if (cross.dot(faceCenter.sub(center)) < 0) cross.negate();
      cross.normalize().multiplyScalar(distance);
      faceNormals.set(id, cross);
    });

    // Average normals for shared vertices
    const vertexOffsets = new Map();
    ids.forEach(id => {
      const face = faces[id];
      if (!face) return;
      const n = faceNormals.get(id);
      face.vertices.forEach(vId => {
        if (!vertexOffsets.has(vId)) vertexOffsets.set(vId, new THREE.Vector3());
        vertexOffsets.get(vId).add(n);
      });
    });
    vertexOffsets.forEach(n => n.normalize().multiplyScalar(distance));

    // Create new vertices (one per unique old vertex)
    const vertexMap = new Map();
    vertexOffsets.forEach((offset, vId) => {
      const v = vertices[vId];
      vertices.push([v[0] + offset.x, v[1] + offset.y, v[2] + offset.z]);
      vertexMap.set(vId, vertices.length - 1);
    });

    // Remove old selected faces
    this.topology.faces = faces.filter((_, faceId) => !selectedSet.has(faceId));

    // Add new top faces
    ids.forEach(id => {
      const face = faces[id];
      if (!face) return;
      this.topology.faces.push({ vertices: face.vertices.map(v => vertexMap.get(v)), edges: [], materialIndex: face.materialIndex ?? 0 });
    });

    // Add side faces only for boundary edges (exactly one selected face)
    const processedEdges = new Set();
    ids.forEach(id => {
      const face = faces[id];
      if (!face) return;
      face.vertices.forEach((vA, i) => {
        const vB = face.vertices[(i + 1) % 3];
        const edgeId = face.edges[i];
        if (processedEdges.has(edgeId)) return;
        processedEdges.add(edgeId);
        const edge = this.topology.edges[edgeId];
        if (!edge) return;
        const sharedCount = edge.faces.filter(f => selectedSet.has(f)).length;
        if (sharedCount !== 1) return;
        const nA = vertexMap.get(vA);
        const nB = vertexMap.get(vB);
        this.topology.faces.push({ vertices: [vA, vB, nB], edges: [], materialIndex: face.materialIndex ?? 0 });
        this.topology.faces.push({ vertices: [vA, nB, nA], edges: [], materialIndex: face.materialIndex ?? 0 });
      });
    });

    this.clearSelection();
    return this._commitOrRollback(before);
  }

  _meshCenter() {
    const sphere = this.mesh.geometry.boundingSphere;
    if (sphere) return sphere.center.clone();
    const center = new THREE.Vector3();
    this.topology.vertices.forEach(v => center.add(new THREE.Vector3(...v)));
    return center.divideScalar(Math.max(this.topology.vertices.length, 1));
  }

  _commitOrRollback(before) {
    if (this.commit()) { this.lastError = ''; return true; }
    this.lastError = '拓扑校验失败，操作已回滚';
    this.topology = before;
    this.halfEdge = new HalfEdgeMesh(this.topology);
    this._writeGeometry();
    return false;
  }

  commit() {
    // 统一在这里重建边、校验拓扑并重建 HalfEdgeMesh，避免各操作函数重复执行。
    this._rebuildEdges();
    if (!this.diagnose().valid) return false;
    this._writeGeometry();
    this.revision++;
    this.halfEdge = new HalfEdgeMesh(this.topology);
    return true;
  }

  commitToScene(sceneManager) {
    const id = this.mesh.userData?.sceneObjectId;
    if (!id || !sceneManager?.syncGeometryFromMesh(id)) return false;
    return true;
  }

  _capture() { return clone(this.topology); }

  _rebuildEdges() {
    const edges = []; const edgeMap = new Map();
    this.topology.faces.forEach((face, faceId) => {
      face.edges = face.vertices.map((a, n) => {
        const b = face.vertices[(n + 1) % 3];
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        if (!edgeMap.has(key)) { edgeMap.set(key, edges.length); edges.push({ vertices: [a, b], faces: [] }); }
        const id = edgeMap.get(key); edges[id].faces.push(faceId); return id;
      });
    });
    this.topology.edges = edges;
    // 注意：这里不再重建 this.halfEdge。HalfEdgeMesh 构建成本高，
    // 统一由 commit()/rollback/undo/redo 在验证通过后重建一次，避免重复构建。
  }

  /** 拖拽期间轻量写入 — 仅原地更新选中移动顶点的 position，不重算法线/包围盒/分组 */
  _writePositionsOnly(ids) {
    const { vertices } = this.topology;
    const attr = this.geometry.attributes.position;
    if (!attr) {
      // 缺少 position 属性时退化为全量重建
      const positions = new Float32Array(vertices.length * 3);
      vertices.forEach((v, i) => positions.set(v, i * 3));
      this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      return;
    }
    for (const id of ids) {
      const v = vertices[id];
      if (!v) continue;
      attr.setXYZ(id, v[0], v[1], v[2]);
    }
    attr.needsUpdate = true;
  }

  _writeGeometry() {
    const { vertices, faces } = this.topology;
    const positions = new Float32Array(vertices.length * 3);
    vertices.forEach((v, i) => positions.set(v, i * 3));
    const indices = new Uint32Array(faces.flatMap(face => face.vertices));
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    const sameVertexCount = this._attributes.positionCount === vertices.length;
    if (sameVertexCount && this._attributes.uv && this._attributes.uv.length === vertices.length * 2) {
      this.geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this._attributes.uv), 2));
    } else {
      this.geometry.deleteAttribute('uv');
    }
    this.geometry.deleteAttribute('tangent');
    this.geometry.clearGroups();
    const indexCount = indices.length;
    let current = null;
    this.topology.faces.forEach((face, faceId) => {
      const materialIndex = face.materialIndex ?? 0;
      if (!current || current.materialIndex !== materialIndex) {
        if (current) this.geometry.addGroup(current.start, current.count, current.materialIndex);
        current = { start: faceId * 3, count: 3, materialIndex };
      } else current.count += 3;
    });
    if (current && current.count <= indexCount) this.geometry.addGroup(current.start, current.count, current.materialIndex);
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingBox();
    this.geometry.computeBoundingSphere();
    this._attributes = this._captureAttributes();
  }

  _captureAttributes() {
    const uv = this.geometry.attributes.uv;
    return {
      positionCount: this.geometry.attributes.position.count,
      uv: uv ? new Float32Array(uv.array) : null,
    };
  }
}
