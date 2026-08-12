import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/**
 * 视口渲染层 — 场景骨架：相机、地面网格、坐标轴、环境光与平行光
 */
export class Viewport {
  constructor() {
    this.scene = null;
    this.camera = null;
    this.controls = null;
    this.grid = null;
    this.axes = null;
    this.ambient = null;
    this.directional = null;
  }

  init(canvas) {
    if (!canvas) throw new Error('Viewport.init: canvas is required');

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xd8d0c5);

    // Camera
    // 控制远距离，同时缩小深度范围，改善 z-fighting 精度
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
    this.camera.position.set(6, 5, 8);
    this.camera.lookAt(0, 0, 0);

    // Orbit controls
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 2;
    this.controls.maxDistance = 100;
    this.controls.target.set(0, 0, 0);

    // Ground grid
    this.grid = new THREE.GridHelper(20, 20, 0x6c5a91, 0xc4b8a8);
    this.grid.material.opacity = 0.35;
    this.grid.material.transparent = true;
    this.scene.add(this.grid);

    // Axes helper
    this.axes = new THREE.AxesHelper(2);
    this.scene.add(this.axes);

    // Ambient light
    this.ambient = new THREE.AmbientLight(0xffffff, 0.5);
    this.scene.add(this.ambient);

    // Directional light (sun) — 启用阴影投射
    this.directional = new THREE.DirectionalLight(0xfff5e8, 1.0);
    this.directional.position.set(10, 15, 8);
    this.directional.castShadow = true;
    // 1024 足够覆盖当前编辑范围，避免 2048 阴影贴图长期占用过多显存
    this.directional.shadow.mapSize.set(1024, 1024);
    this.directional.shadow.camera.near = 0.5;
    this.directional.shadow.camera.far = 50;
    this.directional.shadow.camera.left = -15;
    this.directional.shadow.camera.right = 15;
    this.directional.shadow.camera.top = 15;
    this.directional.shadow.camera.bottom = -15;
    this.directional.shadow.bias = -0.0001;
    this.scene.add(this.directional);

    return this;
  }

  resize(w, h) {
    if (this.camera && w > 0 && h > 0) {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
  }

  update() {
    return this.controls?.update() ?? false;
  }

  getCameraData() {
    if (!this.camera || !this.controls) return null;
    return {
      position: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      target: [this.controls.target.x, this.controls.target.y, this.controls.target.z],
    };
  }

  setCameraData(data) {
    if (!data || !this.camera || !this.controls) return;
    if (data.position) this.camera.position.set(data.position[0] ?? 0, data.position[1] ?? 0, data.position[2] ?? 0);
    if (data.target) this.controls.target.set(data.target[0] ?? 0, data.target[1] ?? 0, data.target[2] ?? 0);
    this.controls.update();
  }

  focusObject(object, padding = 1.8) {
    if (!object || !this.camera || !this.controls) return;
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z, 0.5);
    const distance = radius * padding / Math.tan((this.camera.fov * Math.PI / 180) / 2);
    // 相机与 target 重合时方向向量为 (0,0,0)，normalize 后相机会被乘回 center；
    // 此时回退到默认观察方向 (0,0,1)，保证 focusObject 仍能把相机放到合理位置。
    const direction = this.camera.position.clone().sub(this.controls.target);
    if (direction.lengthSq() < 1e-8) direction.set(0, 0, 1);
    else direction.normalize();
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(direction.multiplyScalar(distance));
    this.controls.update();
  }

  dispose() {
    const disposeMaterial = (material) => {
      if (Array.isArray(material)) material.forEach(m => m?.dispose());
      else material?.dispose();
    };
    // 释放网格
    if (this.grid) {
      this.grid.geometry?.dispose();
      disposeMaterial(this.grid.material);
      this.scene?.remove(this.grid);
      this.grid = null;
    }
    // 释放坐标轴
    if (this.axes) {
      this.axes.geometry?.dispose();
      disposeMaterial(this.axes.material);
      this.scene?.remove(this.axes);
      this.axes = null;
    }
    // 释放光源（AmbientLight / DirectionalLight 无 geometry，仅从场景移除）
    if (this.ambient) { this.scene?.remove(this.ambient); this.ambient = null; }
    if (this.directional) { this.scene?.remove(this.directional); this.directional = null; }
    // 释放 OrbitControls
    this.controls?.dispose();
    this.controls = null;
    // 场景内残留对象由 SceneManager 负责
    this.camera = null;
    this.scene = null;
  }
}
