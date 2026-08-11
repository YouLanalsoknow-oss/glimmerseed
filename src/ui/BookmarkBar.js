import { BookmarkSystem } from './BookmarkSystem.js';
import { AddObjectCommand, AddExternalObjectCommand, RemoveObjectCommand } from '../core/Commands.js';
import { CanvasRuntime } from './CanvasRuntime.js';
import { MODE_NAMES } from '../shared/constants.js';
import { dependencyName } from '../shared/utils.js';

/**
 * 界面层 — 书签条：渲染常驻/概念书签，处理父子层级与动作执行
 * 便签纸管理：属性面板、场景大纲以浮动便签纸形式展开
 * 画布覆盖层：点击"画布"常驻书签后覆盖在 3D 视口上方
 */
export class BookmarkBar {
  constructor({ sceneManager, factory, transformController, meshEditController, exporter, persistence, viewport, savedData = null }) {
    this.sceneManager = sceneManager;
    this.factory = factory;
    this.transformController = transformController;
    this.meshEditController = meshEditController;
    this.exporter = exporter;
    this.persistence = persistence;
    this.viewport = viewport;
    this.system = new BookmarkSystem();
    this._canUndo = false;
    this._canRedo = false;
    this._inspectorUserClosed = false;
    this.canvasRuntime = new CanvasRuntime(persistence.resources);
    this.savedData = savedData;
  }

  async init() {
    this._registerBookmarks();
    this._bindClick();
    this.canvasRuntime.init(document.getElementById('canvasViewport'), document.getElementById('pageCanvas'));
    if (this.savedData?.canvas) await this.canvasRuntime.restore(this.savedData.canvas);
    this.canvasRuntime.onChange = () => this.persistence.autoSave(this.sceneManager, this.viewport, this.canvasRuntime);
    this._render();

    this._offSystemState = this.system.on('statechange', () => this._render());
    this._offSystemAction = this.system.on('action', (action) => this._executeAction(action));

    this._offHistory = this.sceneManager.on('historychange', ({ canUndo, canRedo }) => {
      this._canUndo = canUndo;
      this._canRedo = canRedo;
      this._render();
    });

    // ===== 选中对象时自动展开属性便签 =====
    this._offSelection = this.sceneManager.on('selectionchange', () => {
      const selected = this.sceneManager.getSelectedObjects();
      if (selected.length > 0) {
        this._inspectorUserClosed = false;
        this._showNote('inspector');
      } else {
        this._hideNote('inspector');
      }
    });

    // ===== 便签纸关闭按钮（保存引用以便 dispose 时移除监听）=====
    this._inspectorCloseHandler = () => {
      this._hideNote('inspector');
      this._inspectorUserClosed = true;
    };
    this._outlineCloseHandler = () => {
      this._hideNote('outline');
    };
    this._elInspectorClose = document.getElementById('inspectorClose');
    this._elOutlineClose = document.getElementById('outlineClose');
    this._elInspectorClose?.addEventListener('click', this._inspectorCloseHandler);
    this._elOutlineClose?.addEventListener('click', this._outlineCloseHandler);
  }

  _registerBookmarks() {
    // ===== 常驻书签 =====
    this.system.registerPermanent({ id: '3d', label: '3D', material: 'wood', action: 'mode:3d' });
    this.system.registerPermanent({ id: 'canvas', label: '画布', material: 'ginkgo', action: 'mode:canvas' });
    this.system.registerPermanent({ id: 'export', label: '导出', material: 'wax', action: 'export' });

    // ===== 概念书签 =====
    this.system.registerConcept({
      id: 'create', label: '创建', material: 'stone',
      children: [
        { id: 'cube', label: '立方体', action: 'create:cube' },
        { id: 'sphere', label: '球体', action: 'create:sphere' },
        { id: 'cylinder', label: '圆柱', action: 'create:cylinder' },
        { id: 'plane', label: '平面', action: 'create:plane' },
        { id: 'lowcube', label: '低面立方体', action: 'create:lowcube' },
        { id: 'lowsphere', label: '低面球体', action: 'create:lowsphere' },
        { id: 'lowcylinder', label: '低面圆柱', action: 'create:lowcylinder' },
      ],
    });

    this.system.registerConcept({
      id: 'transform', label: '变换', material: 'metal',
      children: [
        { id: 'translate', label: '移动', action: 'mode:translate' },
        { id: 'rotate', label: '旋转', action: 'mode:rotate' },
        { id: 'scale', label: '缩放', action: 'mode:scale' },
      ],
    });

    this.system.registerConcept({
      id: 'topology', label: '拓扑', material: 'stone',
      children: [
        { id: 'topology-vertex', label: '顶点', action: 'topology:vertex' },
        { id: 'topology-edge', label: '边', action: 'topology:edge' },
        { id: 'topology-face', label: '面', action: 'topology:face' },
        { id: 'topology-object', label: '对象', action: 'topology:object' },
        { id: 'topology-cut', label: '环切', action: 'topology:cut' },
        { id: 'topology-bridge', label: '桥接', action: 'topology:bridge' },
        { id: 'topology-check', label: '检查拓扑', action: 'topology:diagnose' },
        { id: 'topology-xray', label: '透视选择', action: 'topology:xray' },
        { id: 'topology-box', label: '框选模式', action: 'topology:box' },
      ],
    });

    this.system.registerConcept({
      id: 'material', label: '材质', material: 'fern',
      children: [
        { id: 'color', label: '颜色', action: 'material:color' },
        { id: 'metalness', label: '金属度', action: 'material:metalness' },
        { id: 'roughness', label: '粗糙度', action: 'material:roughness' },
      ],
    });

    this.system.registerConcept({
      id: 'scene', label: '场景', material: 'paper',
      children: [
        { id: 'outline', label: '大纲', action: 'scene:outline' },
        { id: 'layers', label: '图层', action: 'scene:layers' },
      ],
    });

    this.system.registerConcept({
      id: 'history', label: '历史', material: 'ink',
      children: [
        { id: 'undo', label: '撤销', action: 'history:undo' },
        { id: 'redo', label: '重做', action: 'history:redo' },
      ],
    });

    // ===== 画布工具书签（画布模式下显示）=====
    this.system.registerCanvasTool({ id: 'ct-select', label: '选择', action: 'ctool:select' });
    this.system.registerCanvasTool({ id: 'ct-text', label: '文字', action: 'ctool:text' });
    this.system.registerCanvasTool({ id: 'ct-image', label: '图片', action: 'ctool:image' });
    this.system.registerCanvasTool({ id: 'ct-psd', label: 'PSD', action: 'ctool:psd' });
    this.system.registerCanvasTool({ id: 'ct-shape', label: '形状', action: 'ctool:shape' });
    this.system.registerCanvasTool({ id: 'ct-grid', label: '网格', action: 'ctool:grid' });
    this.system.registerConcept({
      id: 'import', label: '导入', material: 'paper',
      children: [
        { id: 'model', label: '模型', action: 'import:model' },
        { id: 'lowmodel', label: '低面模型', action: 'import:model-low' },
      ],
    });
  }

  _render() {
    const state = this.system.getRenderState();

    // ===== 常驻书签 =====
    const permTargets = state.permanent.map(p => {
      const classes = ['bookmark', 'permanent'];
      if (p.isActive) classes.push('active');
      return { id: p.id, label: p.label, classes: classes.join(' '), title: p.label };
    });
    this._syncBookmarks(document.getElementById('permanentBookmarks'), permTargets);

    // ===== 概念书签 =====
    let targets;
    if (state.activeParent && state.activeChildren.length > 0) {
      // 父级展开：父书签及之前的概念书签保持原位，之后的概念书签被替换为子项
      const parentIdx = state.concepts.findIndex(c => c.id === state.activeParent);
      // 父书签及之前的概念书签（保持原位不动）
      targets = state.concepts.slice(0, parentIdx + 1).map(c => {
        const classes = ['bookmark', 'concept'];
        if (c.id === state.activeParent) classes.push('parent');
        if (c.isActive) classes.push('active');
        return { id: c.id, label: c.label, classes: classes.join(' '), title: c.label };
      });
      // 子项替换父书签之后的概念书签
      state.activeChildren.forEach(ch => {
        const dis = (ch.id === 'undo' && !this._canUndo) || (ch.id === 'redo' && !this._canRedo);
        const chClasses = ['bookmark', 'concept'];
        if (dis) chClasses.push('disabled');
        targets.push({ id: ch.id, label: ch.label, classes: chClasses.join(' '), title: ch.label });
      });
    } else {
      // 平级状态：显示所有概念书签
      targets = state.concepts.map(c => {
        const classes = ['bookmark', 'concept'];
        if (c.isActive) classes.push('active');
        return { id: c.id, label: c.label, classes: classes.join(' '), title: c.label };
      });
    }
    this._syncBookmarks(document.getElementById('conceptBookmarks'), targets);
  }

  /**
   * 增量同步书签 DOM — 新书签播放入场动画，移除的书签播放离场动画后删除
   * @param {HTMLElement} container 书签组容器
   * @param {Array<{id,label,classes,title}>} targets 目标书签列表
   */
  _syncBookmarks(container, targets) {
    if (!container) return;
    const existing = new Map();
    container.querySelectorAll('.bookmark[data-id]:not(.leaving)').forEach(el => {
      existing.set(el.dataset.id, el);
    });
    const targetIds = new Set(targets.map(t => t.id));

    // ===== 离场：存在于 DOM 但不在目标列表中 =====
    existing.forEach((el, id) => {
      if (!targetIds.has(id)) {
        const rect = el.getBoundingClientRect();
        const cRect = container.getBoundingClientRect();
        el.style.left = (rect.left - cRect.left) + 'px';
        el.style.top = (rect.top - cRect.top) + 'px';
        el.style.width = rect.width + 'px';
        el.style.height = rect.height + 'px';
        el.classList.add('leaving');
        el.addEventListener('animationend', () => el.remove(), { once: true });
      }
    });

    // ===== 入场 + 更新（已存在元素固定原位，不移动 DOM）=====
    targets.forEach((t, idx) => {
      let el = existing.get(t.id);
      if (el) {
        // 已存在：仅更新类与标题，保持原 DOM 位置不动
        el.className = t.classes;
        el.title = t.title;
      } else {
        // 新建：加入场动画（stagger 错开），追加到容器末尾
        el = document.createElement('div');
        el.className = t.classes + ' entering';
        el.dataset.id = t.id;
        el.title = t.title;
        el.style.animationDelay = (idx * 0.04) + 's';
        el.innerHTML = `<div class="bookmark-shape"></div><span class="bookmark-label">${t.label}</span>`;
        el.addEventListener('animationend', () => {
          el.classList.remove('entering');
          el.style.animationDelay = '';
        }, { once: true });
        container.appendChild(el);
      }
    });
  }

  /**
   * 事件委托 — 书签点击（绑定一次，DOM 增删无需重绑）
   */
  _bindClick() {
    this._barEl = document.getElementById('bookmarkBar');
    if (!this._barEl) return;
    this._barClickHandler = (e) => {
      const el = e.target.closest('.bookmark[data-id]');
      if (!el || el.classList.contains('disabled') || el.classList.contains('leaving')) return;
      e.stopPropagation();
      this.system.activate(el.dataset.id);
    };
    this._barEl.addEventListener('click', this._barClickHandler);
  }

  _executeAction(action) {
    const [type, value] = action.split(':');
    switch (type) {
      case 'create': this.createObject(value); break;
      case 'mode':
        if (value === '3d') { this._hideCanvas(); }
        else if (value === 'canvas') { this._showCanvas(); }
        else { this.setMode(value); }
        break;
      case 'ctool': this._canvasTool(value); break;
      case 'import': if (value === 'model') this._importModel(false); else if (value === 'model-low') this._importModel(true); break;
      case 'export': this._export(); break;
      case 'history':
        if (value === 'undo') this.sceneManager.undo();
        else if (value === 'redo') this.sceneManager.redo();
        break;
      case 'material':
        this._inspectorUserClosed = false;
        this._showNote('inspector');
        break;
      case 'scene':
        if (value === 'outline') { this._toggleNote('outline'); }
        break;
      case 'topology':
        if (value === 'cut') this.meshEditController?.cutLoop();
        else if (value === 'bridge') this.meshEditController?.bridge();
        else if (value === 'diagnose') this.meshEditController?.diagnose();
        else if (value === 'xray') this.meshEditController?.setXRay();
        else if (value === 'box') this.meshEditController?.toggleBoxSelect();
        else {
          this._hideCanvas();
          this.meshEditController?.setMode(value);
        }
        break;
    }
  }

  _canvasTool(tool) {
    if (tool === 'psd') { this._importPSD(); return; }
    this.canvasRuntime.setTool(tool);
  }

  _pickFile(accept, callback) {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = accept;
    input.addEventListener('change', () => { const file = input.files?.[0]; if (file) callback(file); input.remove(); }, { once: true });
    input.click();
  }

  _pickFiles(accept, callback) {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = accept; input.multiple = true;
    input.addEventListener('change', () => { const files = [...(input.files || [])]; if (files.length) callback(files); input.remove(); }, { once: true });
    input.click();
  }

  _importPSD() {
    this._pickFile('.psd,image/vnd.adobe.photoshop', (file) => this.canvasRuntime.importPSD(file));
  }

  async _importModel(lowPoly = false) {
    this._pickFiles('.glb,.gltf,.obj,.bin,.png,.jpg,.jpeg,.webp,.mtl,model/gltf-binary,model/gltf+json,text/plain,image/*', async (files) => {
      const file = files.find(item => /\.(glb|gltf|obj)$/i.test(item.name));
      if (!file) return this.canvasRuntime.notify('未找到模型文件');
      let objectUrl = null;
      const dependencyUrls = new Map();
      try {
        const ext = file.name.toLowerCase().split('.').pop();
        let object;
        objectUrl = URL.createObjectURL(file);
        if (ext === 'obj') {
          const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
          const loader = new OBJLoader();
          const mtl = files.find(item => /\.mtl$/i.test(item.name));
          if (mtl) {
            const { MTLLoader } = await import('three/addons/loaders/MTLLoader.js');
            const mtlUrl = dependencyUrls.get(dependencyName(mtl.name));
            if (mtlUrl) {
              const materials = await new MTLLoader().loadAsync(mtlUrl);
              materials.preload();
              loader.setMaterials(materials);
            }
          }
          object = await loader.loadAsync(objectUrl);
        } else {
          const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
          const loader = new GLTFLoader();
          files.forEach(item => { if (item !== file) dependencyUrls.set(dependencyName(item.name), URL.createObjectURL(item)); });
          loader.setURLModifier(url => dependencyUrls.get(dependencyName(url)) || url);
          const result = await loader.loadAsync(objectUrl);
          object = result.scene;
        }
        object.name = file.name.replace(/\.[^.]+$/, '');
        object.position.y = 0;
        object.traverse(child => { if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; } });
        if (lowPoly) await this._makeLowPoly(object);
        const sourceResources = [];
        for (const item of files) {
          const resource = await this.persistence.resources?.put(item, { name: item.name, type: item.type || 'application/octet-stream' });
          if (resource) sourceResources.push({ id: resource.id, name: item.name, type: item.type || '' });
        }
        const source = sourceResources.find(item => item.name === file.name);
        const data = { name: file.name.replace(/\.[^.]+$/, ''), sourceResourceId: source?.id || '', sourceName: file.name, sourceType: file.type || '', sourceResources };
        const id = this.sceneManager.addExternalObject(object, data);
        data.id = id;
        this.sceneManager.pushCommand(new AddExternalObjectCommand(this.sceneManager, object, data));
        this.sceneManager.selectObject(id);
        this.canvasRuntime.notify(`${lowPoly ? '已导入低面模型' : '已导入模型'}：${file.name}`);
      } catch (error) {
        console.error('[BookmarkBar] model import failed:', error);
        this.canvasRuntime.notify(`模型导入失败：${error.message}`);
      } finally {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        dependencyUrls.forEach(url => URL.revokeObjectURL(url));
      }
    });
  }

  async _makeLowPoly(object) {
    let SimplifyModifier = null;
    try {
      ({ SimplifyModifier } = await import('three/addons/modifiers/SimplifyModifier.js'));
    } catch (error) {
      console.warn('[BookmarkBar] SimplifyModifier unavailable, using flat shading only');
    }
    object.traverse(child => {
      if (!child.isMesh || !child.geometry) return;
      const source = child.geometry;
      let geometry = source;
      if (SimplifyModifier && source.attributes.position.count > 24) {
        const removeCount = Math.floor(source.attributes.position.count * 0.45);
        try { geometry = new SimplifyModifier().modify(source, removeCount); } catch (error) { geometry = source; }
      }
      // 非索引几何体配合平面法线，保留硬朗的低面数视觉。
      geometry = geometry.index ? geometry.toNonIndexed() : geometry.clone();
      geometry.computeVertexNormals();
      if (geometry !== source) source.dispose();
      child.geometry = geometry;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      const mappedMaterials = materials.map(material => {
        const clone = material.clone();
        clone.flatShading = true;
        clone.needsUpdate = true;
        return clone;
      });
      // 克隆材质后旧材质已不再挂载到网格，及时释放其 GPU 材质资源。
      materials.forEach(material => material?.dispose?.());
      child.material = Array.isArray(child.material) ? mappedMaterials : mappedMaterials[0];
    });
  }

  // ===== 便签纸管理 =====

  _showNote(name) {
    const note = document.getElementById(name + 'Note');
    if (note) note.classList.remove('hidden');
  }

  _hideNote(name) {
    const note = document.getElementById(name + 'Note');
    if (note) note.classList.add('hidden');
  }

  _toggleNote(name) {
    const note = document.getElementById(name + 'Note');
    if (note) note.classList.toggle('hidden');
  }

  // ===== 画布覆盖层 =====

  _showCanvas() {
    const overlay = document.getElementById('canvasOverlay');
    if (overlay) overlay.classList.remove('hidden');
    this.canvasRuntime.setTool('select');
  }

  _hideCanvas() {
    const overlay = document.getElementById('canvasOverlay');
    if (overlay) overlay.classList.add('hidden');
    this.canvasRuntime.drag = null;
  }

  // ===== 公开方法（供 main.js 键盘快捷键调用）=====

  createObject(type) {
    const result = this.factory.create(type);
    if (!result) return;
    const { mesh, data } = result;
    const id = this.sceneManager.addObject(mesh, data);
    this.sceneManager.pushCommand(new AddObjectCommand(this.sceneManager, this.factory, data));
    this.sceneManager.selectObject(id);
  }

  setMode(mode) {
    this.transformController.setMode(mode);
    const modeEl = document.getElementById('statusMode');
    if (modeEl) modeEl.textContent = `${MODE_NAMES[mode] || mode}模式`;
  }

  focusSelected() {
    const selected = this.sceneManager.getPrimarySelection();
    if (selected) this.viewport.focusObject(selected.mesh);
  }

  deleteSelected() {
    const selected = this.sceneManager.getSelectedObjects();
    if (selected.length === 0) return;
    for (const obj of selected) {
      const cmd = new RemoveObjectCommand(this.sceneManager, this.factory, obj.data.id);
      this.sceneManager.removeObject(obj.data.id, { dispose: !obj.external });
      this.sceneManager.pushCommand(cmd);
    }
  }

  dispose() {
    this._offSystemState?.(); this._offSystemState = null;
    this._offSystemAction?.(); this._offSystemAction = null;
    this._offHistory?.(); this._offHistory = null;
    this._offSelection?.(); this._offSelection = null;
    this._elInspectorClose?.removeEventListener('click', this._inspectorCloseHandler);
    this._elOutlineClose?.removeEventListener('click', this._outlineCloseHandler);
    this._barEl?.removeEventListener('click', this._barClickHandler);
    this.canvasRuntime.dispose();
  }
}
