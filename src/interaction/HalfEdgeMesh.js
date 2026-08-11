import * as THREE from 'three';

/**
 * 半边拓扑核心。渲染使用 BufferGeometry，编辑使用稳定的半边关系。
 * 当前导入边界统一三角化，但不再依赖“全邻接 BFS”推断拓扑语义。
 */
export class HalfEdgeMesh {
  constructor(options = {}) {
    const { vertices = [], faces = [] } = options || {};
    const sourceVertices = Array.isArray(vertices) ? vertices : [];
    this.vertices = sourceVertices.map((position, id) => ({
      id,
      position: Array.isArray(position) && position.length >= 3
        ? [Number(position[0]), Number(position[1]), Number(position[2])].map(value => Number.isFinite(value) ? value : 0)
        : [0, 0, 0],
      halfedge: -1,
    }));
    const sourceFaces = Array.isArray(faces) ? faces : [];
    this.faces = sourceFaces.reduce((result, face) => {
      const indices = Array.isArray(face) ? face : face?.vertices;
      if (!Array.isArray(indices) || indices.length < 3) return result;
      const normalized = indices.map(Number);
      if (normalized.some(index => !Number.isInteger(index) || index < 0 || index >= this.vertices.length)
        || new Set(normalized).size !== normalized.length) return result;
      result.push({ id: result.length, vertices: normalized, halfedge: -1 });
      return result;
    }, []);
    this.halfedges = [];
    this.edges = [];
    this.rebuild();
  }

  static fromBufferGeometry(geometry) {
    const position = geometry?.attributes?.position;
    if (!position || !Number.isInteger(position.count) || position.count < 3) return new HalfEdgeMesh();
    const vertices = Array.from({ length: position.count }, (_, id) => [position.getX(id), position.getY(id), position.getZ(id)]);
    const index = geometry.index ? [...geometry.index.array] : [...Array(position.count).keys()];
    const faces = [];
    for (let i = 0; i + 2 < index.length; i += 3) faces.push([index[i], index[i + 1], index[i + 2]]);
    return new HalfEdgeMesh({ vertices, faces });
  }

  rebuild() {
    this.halfedges = [];
    this.edges = [];
    // rebuild 后旧 halfedge 索引全部失效，必须清零
    this.vertices.forEach(vertex => { vertex.halfedge = -1; });
    this.faces.forEach(face => { face.halfedge = -1; });
    const directed = new Map();
    this.faces.forEach(face => {
      const local = [];
      face.vertices.forEach((vertex, index) => {
        const halfedge = { id: this.halfedges.length, vertex, face: face.id, next: -1, prev: -1, twin: -1, edge: -1 };
        this.halfedges.push(halfedge); local.push(halfedge.id);
        const nextVertex = face.vertices[(index + 1) % face.vertices.length];
        const directedKey = `${vertex}:${nextVertex}`;
        if (!directed.has(directedKey)) directed.set(directedKey, halfedge.id);
        if (this.vertices[vertex] && this.vertices[vertex].halfedge === -1) this.vertices[vertex].halfedge = halfedge.id;
      });
      local.forEach((id, index) => {
        this.halfedges[id].next = local[(index + 1) % local.length];
        this.halfedges[id].prev = local[(index + local.length - 1) % local.length];
      });
      face.halfedge = local[0];
    });
    this.halfedges.forEach(halfedge => {
      const target = this.halfedges[halfedge.next]?.vertex;
      const twin = directed.get(`${target}:${halfedge.vertex}`);
      if (twin != null && twin !== halfedge.id) halfedge.twin = twin;
    });
    const undirected = new Map();
    this.halfedges.forEach(halfedge => {
      const target = this.halfedges[halfedge.next]?.vertex;
      if (target == null) return;
      const key = halfedge.vertex < target ? `${halfedge.vertex}:${target}` : `${target}:${halfedge.vertex}`;
      if (!undirected.has(key)) { undirected.set(key, this.edges.length); this.edges.push({ id: this.edges.length, halfedges: [] }); }
      const edgeId = undirected.get(key); halfedge.edge = edgeId; this.edges[edgeId].halfedges.push(halfedge.id);
    });
  }

  toTopology() {
    return {
      vertices: this.vertices.map(vertex => [...vertex.position]),
      faces: this.faces.map(face => ({
        vertices: [...face.vertices],
        edges: face.vertices.map((_, index) => this.halfedges[face.halfedge + index]?.edge ?? -1),
      })),
      edges: this.edges.map(edge => ({
        vertices: this.edgeVertices(edge.id),
        faces: edge.halfedges.map(id => this.halfedges[id]?.face).filter(Number.isInteger),
      })),
    };
  }

  edgeVertices(edgeId) {
    const halfedge = this.halfedges[this.edges[edgeId]?.halfedges[0]];
    const target = halfedge && this.halfedges[halfedge.next]?.vertex;
    if (!halfedge || target == null) return [];
    return [halfedge.vertex, target];
  }

  boundaryEdges() { return this.edges.filter(edge => edge.halfedges.length === 1); }
  nonManifoldEdges() { return this.edges.filter(edge => edge.halfedges.length > 2); }

  collectEdgeLoop(start) {
    if (!this.edges[start]) return new Set();
    const result = new Set([start]);
    const queue = [start];
    let head = 0;
    while (head < queue.length) {
      const edge = this.edges[queue[head++]];
      edge.halfedges.forEach(halfedgeId => {
        const halfedge = this.halfedges[halfedgeId];
        const face = this.faces[halfedge.face];
        if (!face || face.vertices.length !== 4) return;
        const local = face.vertices.findIndex(vertex => vertex === halfedge.vertex);
        const opposite = (local + 2) % face.vertices.length;
        const nextHalfedge = this.halfedges[face.halfedge + opposite];
        if (nextHalfedge && !result.has(nextHalfedge.edge)) { result.add(nextHalfedge.edge); queue.push(nextHalfedge.edge); }
      });
    }
    return result;
  }

  toBufferGeometry() {
    const geometry = new THREE.BufferGeometry();
    const position = new Float32Array(this.vertices.flatMap(vertex => vertex.position));
    const indices = new Uint32Array(this.faces.flatMap(face => face.vertices));
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    return geometry;
  }
}
