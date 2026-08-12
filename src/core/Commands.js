/**
 * 命令模式 — 撤销/重做命令对象
 * 每个命令存储完整数据快照，通过工厂重建网格
 */
import { clone, sanitizeColor } from '../shared/utils.js';
import { isValidTopology, writeTopologyToGeometry } from '../shared/topology.js';
import { isTextureUsedByAnyOther } from '../shared/textureUtils.js';

function disposeObjectResources(object, isTextureShared = null) {
  const textures = new Set();
  object?.traverse?.(node => {
    node.geometry?.dispose();
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    materials.forEach(material => {
      if (!material) return;
      Object.values(material).forEach(value => {
        if (value?.isTexture && !isTextureShared?.(value)) textures.add(value);
      });
      material.dispose();
    });
  });
  textures.forEach(texture => texture.dispose());
}

/** 外部对象命令的共享 dispose：先展开一次场景对象集复用，再统一释放资源 */
function disposeExternalObject(command) {
  if (!command.object || command._disposed) return;
  const others = command.sceneManager?.objects?.values?.() || [];
  disposeObjectResources(command.object, texture => isTextureUsedByAnyOther(others, texture));
  command.object = null;
  command._disposed = true;
}

/** 将已保存的拓扑数据写入网格几何体（编辑后的顶点/索引可能与工厂默认值不同） */
function applyTopology(mesh, data) {
  const topology = data.geometry?.topology;
  if (!isValidTopology(topology)) return;
  writeTopologyToGeometry(mesh.geometry, topology);
}

function applyState(mesh, data) {
  const t = data.transform;
  if (t) {
    mesh.position.set(t.position[0] ?? 0, t.position[1] ?? 0, t.position[2] ?? 0);
    mesh.rotation.set(t.rotation[0] ?? 0, t.rotation[1] ?? 0, t.rotation[2] ?? 0);
    mesh.scale.set(t.scale[0] ?? 1, t.scale[1] ?? 1, t.scale[2] ?? 1);
  }
  const mat = data.material;
  if (mat && mesh.material) {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.forEach(material => {
      material.color?.set(sanitizeColor(mat.color));
      if ('metalness' in material) material.metalness = mat.metalness ?? 0.1;
      if ('roughness' in material) material.roughness = mat.roughness ?? 0.7;
    });
  }
}

function recreate(sceneManager, factory, data) {
  const result = factory.create(data.type, data.geometry || {});
  if (!result) return null;
  applyTopology(result.mesh, data);
  applyState(result.mesh, data);
  sceneManager.addObject(result.mesh, clone(data));
  return result;
}

export class AddObjectCommand {
  constructor(sceneManager, factory, data) {
    this.sceneManager = sceneManager;
    this.factory = factory;
    this.data = clone(data);
  }

  redo() {
    if (this.data && !this.sceneManager.getObject(this.data.id)) {
      recreate(this.sceneManager, this.factory, this.data);
    }
  }

  undo() {
    // 空值安全：redo/undo 均先判 data，避免构造期 data 缺失时解引用崩裸
    if (this.data) this.sceneManager.removeObject(this.data.id);
  }
}

export class RemoveObjectCommand {
  constructor(sceneManager, factory, id) {
    this.sceneManager = sceneManager;
    this.factory = factory;
    const obj = sceneManager.getObject(id);
    this.data = obj ? clone(obj.data) : null;
    this.object = obj?.external ? obj.mesh : null;
    this._disposed = false;
  }

  redo() {
    if (this.data) this.sceneManager.removeObject(this.data.id, { dispose: !this.object });
  }

  undo() {
    if (!this.data) return;
    if (this.object) this.sceneManager.addExternalObject(this.object, this.data);
    else recreate(this.sceneManager, this.factory, this.data);
  }

  dispose() {
    disposeExternalObject(this);
  }
}

export class TopologyEditCommand {
  constructor(sceneManager, id, before, after) {
    this.sceneManager = sceneManager;
    this.id = id;
    this.before = clone(before);
    this.after = clone(after);
  }

  undo() { this.sceneManager.applyTopologyData(this.id, this.before); }
  redo() { this.sceneManager.applyTopologyData(this.id, this.after); }
}

export class UpdateObjectCommand {
  constructor(sceneManager, id, before, after) {
    this.sceneManager = sceneManager;
    this.id = id;
    this.before = clone(before);
    this.after = clone(after);
  }

  undo() { this.sceneManager.applyObjectData(this.id, this.before); }
  redo() { this.sceneManager.applyObjectData(this.id, this.after); }
}

export class AddExternalObjectCommand {
  constructor(sceneManager, object, data) {
    this.sceneManager = sceneManager;
    this.object = object;
    this.data = clone(data);
    this._disposed = false;
  }

  redo() {
    if (this.object && !this.sceneManager.getObject(this.data.id)) {
      this.sceneManager.addExternalObject(this.object, this.data);
    }
  }

  undo() {
    this.sceneManager.removeObject(this.data.id, { dispose: false });
  }

  dispose() {
    disposeExternalObject(this);
  }
}
