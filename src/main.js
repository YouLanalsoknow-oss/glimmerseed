/**
 * 入口 — 串联五层架构 + 书签系统，启动渲染循环与交互系统
 */
import { Renderer } from './core/Renderer.js';
import { Viewport } from './core/Viewport.js';
import { SceneManager } from './core/SceneManager.js';
import { GeometryFactory } from './factories/GeometryFactory.js';
import { SelectionController } from './interaction/SelectionController.js';
import { TransformController } from './interaction/TransformController.js';
import { MeshEditController } from './interaction/MeshEditController.js';
import { Persistence } from './io/Persistence.js';
import { Exporter } from './io/Exporter.js';
import { BookmarkBar } from './ui/BookmarkBar.js';
import { Inspector } from './ui/Inspector.js';
import { Outline } from './ui/Outline.js';
import { StatusBar } from './ui/StatusBar.js';

async function main() {
  const canvas = document.getElementById('renderCanvas');
  const loadingOverlay = document.getElementById('loadingOverlay');

  // ===== 视口层 =====
  const renderer = new Renderer();
  await renderer.init(canvas);

  const viewport = new Viewport();
  viewport.init(renderer.domElement);

  const factory = new GeometryFactory();
  const sceneManager = new SceneManager(viewport.scene, factory);

  // ===== 交互层 =====
  const transformController = new TransformController();
  transformController.init(renderer, viewport, sceneManager);

  const selectionController = new SelectionController();
  selectionController.init(renderer, viewport, sceneManager, transformController);
  const meshEditController = new MeshEditController();
  meshEditController.init(renderer, viewport, sceneManager, transformController);

  // ===== IO 层 =====
  const persistence = new Persistence();
  const exporter = new Exporter();
  await persistence.init();
  sceneManager.resourceStore = persistence.resources;
  const savedData = await persistence.load();

  persistence.setSaveStatusCallback((status) => {
    const el = document.getElementById('saveStatus');
    if (!el) return;
    const map = { saving: '保存中…', saved: '已保存', error: '保存失败' };
    el.textContent = map[status] || status;
    el.style.color = status === 'error' ? '#c44' : status === 'saving' ? '#9a7a40' : '#73887c';
  });

  // ===== 界面层 =====
  const bookmarkBar = new BookmarkBar({
    sceneManager, factory, transformController, meshEditController, exporter, persistence, viewport, savedData,
  });
  await bookmarkBar.init();

  const inspector = new Inspector({ sceneManager });
  inspector.init();

  const outline = new Outline({ sceneManager, factory });
  outline.init();

  const statusBar = new StatusBar({ sceneManager, transformController, renderer });
  statusBar.init();

  // ===== 自动保存 =====
  const offAutoSave = sceneManager.on('scenechanged', () => {
    persistence.autoSave(sceneManager, viewport, bookmarkBar.canvasRuntime);
  });

  // ===== 按需渲染 — 脏标记驱动，静止时跳过渲染节省资源 =====
  let needsRender = true;
  let _pageVisible = true;
  let _rafId = 0;
  let _loopRunning = false;
  const markDirty = () => {
    needsRender = true;
    startRenderLoop();
  };
  const offSceneDirty = sceneManager.on('scenechanged', markDirty);
  const offObjectDirty = sceneManager.on('objectchanged', markDirty);
  const offSelectionDirty = sceneManager.on('selectionchange', markDirty);
  const offOverlayDirty = sceneManager.on('topologyoverlay', markDirty);
  // OrbitControls 阻尼动画期间持续触发 change → 保持渲染
  viewport.controls?.addEventListener('change', markDirty);
  // TransformControls gizmo 悬停高亮也需要渲染
  transformController.controls?.addEventListener('change', markDirty);

  // ===== 加载存档 =====
  if (savedData) {
    await sceneManager.restoreSceneData(savedData);
    if (savedData.camera) viewport.setCameraData(savedData.camera);
  }

  // ===== 窗口缩放 — rAF 节流，避免高频 resize 卡顿 =====
  let _resizeRAF = 0;
  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h);
    viewport.resize(w, h);
    markDirty();
  }
  function scheduleResize() {
    if (_resizeRAF) return;
    _resizeRAF = requestAnimationFrame(() => {
      _resizeRAF = 0;
      resize();
    });
  }
  window.addEventListener('resize', scheduleResize);
  resize();

  // ===== 键盘快捷键 =====
  function onKeyDown(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
    if (bookmarkBar.canvasRuntime?.handleKey(e)) return;
    if (meshEditController.handleKey(e)) return;

    switch (e.key) {
      case '1': bookmarkBar.createObject('cube'); break;
      case '2': bookmarkBar.createObject('sphere'); break;
      case '3': bookmarkBar.createObject('cylinder'); break;
      case '4': bookmarkBar.createObject('plane'); break;
      case 'w': case 'W': bookmarkBar.setMode('translate'); break;
      case 'e': case 'E': bookmarkBar.setMode('rotate'); break;
      case 'r': case 'R': bookmarkBar.setMode('scale'); break;
      case 'f': case 'F': bookmarkBar.focusSelected(); break;
      case 'v': case 'V': meshEditController.setMode('vertex'); break;
      case 'b': case 'B': meshEditController.setMode('edge'); break;
      case 'p': case 'P': meshEditController.setMode('face'); break;
      case 'x': case 'X': meshEditController.deleteSelected(); break;
      case 'Delete': case 'Backspace':
        e.preventDefault();
        bookmarkBar.deleteSelected();
        break;
      case 'Escape': sceneManager.deselectAll(); break;
      case 'z': case 'Z':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          if (e.shiftKey) sceneManager.redo();
          else sceneManager.undo();
        }
        break;
      case 'y': case 'Y':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          sceneManager.redo();
        }
        break;
    }
  }
  document.addEventListener('keydown', onKeyDown);

  // ===== 渲染循环 — 有工作时运行，静止时完全停止 rAF =====
  function startRenderLoop() {
    if (!_pageVisible || _loopRunning) return;
    _loopRunning = true;
    _rafId = requestAnimationFrame(animate);
  }

  function animate() {
    _rafId = 0;
    if (!_pageVisible) {
      _loopRunning = false;
      return;
    }

    // controls.update() 返回阻尼是否仍在变化
    const controlsChanged = viewport.update();
    if (needsRender) {
      renderer.render(viewport.scene, viewport.camera);
      needsRender = false;
    }

    if (controlsChanged || needsRender) {
      _rafId = requestAnimationFrame(animate);
    } else {
      _loopRunning = false;
    }
  }
  startRenderLoop();

  // ===== 页面可见性 — 切到后台时暂停渲染，回到前台立即恢复 =====
  function onVisibilityChange() {
    if (document.hidden) {
      _pageVisible = false;
      _loopRunning = false;
      cancelAnimationFrame(_rafId);
    } else {
      _pageVisible = true;
      markDirty(); // 恢复后立即重绘一帧
      startRenderLoop();
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange);

  // ===== 统一资源释放 =====
  function disposeAll() {
    if (disposeAll.done) return;
    disposeAll.done = true;
    // 先同步写入元数据，避免卸载阶段因 Promise 未被等待而丢失最后一次编辑。
    persistence.saveSnapshotSync(sceneManager, viewport, bookmarkBar.canvasRuntime);
    // IndexedDB 资源清理仍异步执行，作为补充而非最后一次保存的唯一保障。
    persistence.flush(sceneManager, viewport, bookmarkBar.canvasRuntime).catch(error => console.error('[Main] final save failed:', error));
    _loopRunning = false;
    cancelAnimationFrame(_rafId);
    if (_resizeRAF) cancelAnimationFrame(_resizeRAF);
    window.removeEventListener('resize', scheduleResize);
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('beforeunload', disposeAll);
    offAutoSave?.();
    offSceneDirty?.();
    offObjectDirty?.();
    offSelectionDirty?.();
    offOverlayDirty?.();
    viewport.controls?.removeEventListener('change', markDirty);
    transformController.controls?.removeEventListener('change', markDirty);
    selectionController.dispose?.();
    meshEditController.dispose();
    bookmarkBar.dispose?.();
    inspector.dispose?.();
    outline.dispose?.();
    statusBar.dispose?.();
    transformController.dispose();
    persistence.dispose?.();
    sceneManager.dispose();
    viewport.dispose();
    renderer.dispose();
  }
  window.addEventListener('beforeunload', disposeAll);
  window.addEventListener('pagehide', disposeAll, { once: true });

  // ===== 就绪 =====
  loadingOverlay.classList.add('hidden');
  document.getElementById('viewportHint').textContent =
    '左键选中 \u00b7 拖拽旋转 \u00b7 右键平移 \u00b7 滚轮缩放';
}

function showBootError(err) {
  console.error('[Main] boot failed:', err);
  const overlay = document.getElementById('loadingOverlay');
  if (overlay) {
    overlay.classList.remove('hidden');
    const text = overlay.querySelector('.loading-text');
    if (text) text.textContent = `初始化失败：${err?.message || err}`;
    overlay.setAttribute('role', 'alert');
  }
  const backend = document.getElementById('statusBackend');
  if (backend) backend.textContent = '渲染后端: 初始化失败';
}

window.addEventListener('error', event => {
  if (event.error) console.error('[Main] uncaught error:', event.error);
});
window.addEventListener('unhandledrejection', event => {
  console.error('[Main] unhandled rejection:', event.reason);
});
main().catch(showBootError);
