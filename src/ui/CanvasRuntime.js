import { sanitizeCanvasHtml, sanitizeCanvasStyle, isSafeUrl } from '../shared/utils.js';

/**
 * 画布运行时 — 轻量 DOM 编辑器
 * 只在指针交互时更新元素，避免画布模式维持独立动画循环。
 */
export class CanvasRuntime {
  constructor(resourceStore = null) {
    this.viewport = null;
    this.page = null;
    this.activeTool = 'select';
    this.selected = null;
    this.selectedSet = new Set();
    this.drag = null;
    this._imageInput = null;
    this._resizeHandle = null;
    this._history = [];
    this._future = [];
    this._maxHistory = 100;
    this._handles = [];
    this.onChange = null;
    this.resourceStore = resourceStore;
    this._resourceUrls = new Map();
    this._canvasOverlay = null;   // L6: 缓存 canvasOverlay 引用，避免每次 keydown 查询
    this._notifyToken = 0;        // L2: 状态提示版本号，仅最新一次恢复旧文案
    this._notifyPrevious = null;  // L2: 同一批提示开始前的原始文案
    this._notifyTimer = 0;        // L2: notify 的 setTimeout 句柄，dispose 时清理
    this._disposed = false;       // 异步任务（图片/PSD 导入）完成前可被 dispose 的存活标志
  }

  init(viewport, page) {
    this.viewport = viewport;
    this.page = page;
    if (!viewport || !page) return this;

    // L6: init 时缓存 overlay 引用，之后复用
    this._canvasOverlay = document.getElementById('canvasOverlay');

    this._onPointerDown = (e) => this._pointerDown(e);
    this._onPointerMove = (e) => this._pointerMove(e);
    this._onPointerUp = () => this._pointerUp();
    this._onDoubleClick = (e) => this._doubleClick(e);
    viewport.addEventListener('pointerdown', this._onPointerDown);
    viewport.addEventListener('pointermove', this._onPointerMove);
    viewport.addEventListener('pointerup', this._onPointerUp);
    viewport.addEventListener('pointercancel', this._onPointerUp);
    page.addEventListener('dblclick', this._onDoubleClick);
    return this;
  }

  serialize() {
    if (!this.page) return { version: 1, elements: [] };
    return { version: 3, grid: this.page.classList.contains('show-grid'), elements: [...this.page.querySelectorAll('.page-element')].map(element => ({ tag: element.tagName.toLowerCase(), className: String(element.className), text: element.textContent, html: element.innerHTML, resourceId: element.dataset.resourceId || '', src: element.dataset.resourceId ? '' : (element.src?.startsWith('data:') ? '' : (element.src || '')), alt: element.alt || '', style: element.getAttribute('style') || '' })) };
  }

  getResourceIds() { return [...new Set([...this.page?.querySelectorAll('[data-resource-id]') || []].map(el => el.dataset.resourceId).filter(Boolean))]; }

  async restore(data) {
    if (!this.page || !data?.elements) return;
    this._clearHistoryAndResources();
    this.page.querySelectorAll('.page-element').forEach(element => element.remove());
    this.page.classList.toggle('show-grid', Boolean(data.grid));
    // 性能：先同步建元素并按序插入，仅对资源 attach 做并发限制，
    // 避免大画布一次性并发拉取全部 IndexedDB 资源造成尖峰与渲染阻塞。
    const pending = [];
    for (const item of data.elements) {
      const tag = ['div', 'img', 'p', 'span'].includes(item.tag) ? item.tag : 'div';
      const element = document.createElement(tag);
      element.className = 'page-element ' + String(item.className || '').split(/\s+/).filter(c => /^[a-zA-Z0-9_-]+$/.test(c) && c !== 'selected').join(' ');
      // 富文本编辑记录 innerHTML；旧存档没有 html 时回退到纯文本。
      // HTML 与 style 均来自持久化存档，需净化防存储型 XSS。
      if (typeof item.html === 'string') element.innerHTML = sanitizeCanvasHtml(item.html);
      else element.textContent = item.text || '';
      if (item.resourceId) {
        element.dataset.resourceId = item.resourceId;
        pending.push(this._attachResource(element, item.resourceId));
      } else if (item.src && isSafeUrl(item.src)) element.src = item.src;
      if (item.alt) element.alt = item.alt;
      if (item.style) element.setAttribute('style', sanitizeCanvasStyle(item.style));
      this.page.appendChild(element);
    }
    const CONCURRENCY = 6;
    for (let i = 0; i < pending.length; i += CONCURRENCY) {
      await Promise.all(pending.slice(i, i + CONCURRENCY));
    }
    this._clearSelection();
    this._notifyChange();
  }

  async _attachResource(element, id) {
    try {
      const record = await this.resourceStore?.get(id);
      if (!record?.blob) throw new Error('资源不存在');
      if (this._disposed || !this.page) return; // 资源就绪前画布已释放，丢弃
      const url = URL.createObjectURL(record.blob);
      this._trackResourceUrl(id, url);
      element.src = url;
    } catch (error) {
      element.removeAttribute('src');
      element.classList.add('resource-missing');
      console.warn('[CanvasRuntime] resource restore skipped:', id, error);
    }
  }

  /** 记录 id -> Set<url>：同一资源被多个元素引用时保留全部 blob URL，释放时统一回收 */
  _trackResourceUrl(id, url) {
    if (!this._resourceUrls.has(id)) this._resourceUrls.set(id, new Set());
    this._resourceUrls.get(id).add(url);
  }

  /** 遍历全部 Set 值逐个 revoke 后清空映射 */
  _revokeResourceUrls() {
    this._resourceUrls.forEach(set => {
      if (!set || typeof set.forEach !== 'function') return;
      set.forEach(url => { if (typeof url === 'string' && url.startsWith('blob:')) URL.revokeObjectURL(url); });
    });
    this._resourceUrls.clear();
  }

  setTool(tool) {
    this.activeTool = tool || 'select';
    if (this.viewport) this.viewport.dataset.tool = this.activeTool;
    if (this.activeTool !== 'select') this._clearSelection();
  }

  get hasSelection() { return Boolean(this.selected); }

  handleKey(event) {
    if (!this._isVisible()) return false;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') {
      if (!this.selected) return true;
      event.preventDefault();
      this.duplicateSelected();
      return true;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      if (!this._history.length && !this._future.length) return false;
      event.preventDefault();
      event.shiftKey ? this.redo() : this.undo();
      return true;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
      if (!this._future.length) return false;
      event.preventDefault();
      this.redo();
      return true;
    }
    if (!this.selectedSet.size) return false;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      this.deleteSelected();
      return true;
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      this.resizeSelected(1.1);
      return true;
    }
    if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      this.resizeSelected(0.9);
      return true;
    }
    const step = event.shiftKey ? 10 : 2;
    const nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (nudge) {
      event.preventDefault();
      const items = [...this.selectedSet];
      const from = items.map(element => ({ element, left: element.offsetLeft, top: element.offsetTop }));
      items.forEach(element => {
        element.style.left = `${element.offsetLeft + nudge[0]}px`;
        element.style.top = `${element.offsetTop + nudge[1]}px`;
      });
      this._record('moveMany', { items: from.map(item => ({ ...item, toLeft: item.left + nudge[0], toTop: item.top + nudge[1] })) });
      return true;
    }
    return false;
  }

  async importPSD(file) {
    if (!file || !this.page) return;
    let url = null;
    try {
      const readPsd = globalThis.agPsd?.readPsd;
      if (typeof readPsd !== 'function') throw new Error('PSD 解析器未加载');
      const buffer = await file.arrayBuffer();
      if (this._disposed) return;
      const psd = readPsd(buffer, { skipLayerImageData: false, skipCompositeImageData: false });
      if (!psd.canvas) throw new Error('PSD 未生成合成预览');
      const image = document.createElement('img');
      image.className = 'page-element canvas-image canvas-psd';
      image.alt = file.name;
      const blob = await new Promise((resolve, reject) => psd.canvas.toBlob(result => result ? resolve(result) : reject(new Error('PSD 预览编码失败')), 'image/png'));
      if (this._disposed) return;
      const resource = await this.resourceStore?.put(blob, { name: file.name, type: 'image/png' });
      if (!resource) throw new Error('资源存储不可用');
      if (this._disposed) return;
      image.dataset.resourceId = resource.id;
      url = URL.createObjectURL(blob);
      image.src = url;
      this._trackResourceUrl(resource.id, url);
      image.onload = () => {
        if (this._disposed || !this.page) { URL.revokeObjectURL(url); url = null; return; }
        const maxW = Math.min(560, this.page.clientWidth * 0.82);
        const ratio = image.naturalHeight / image.naturalWidth || 1;
        this._place(image, { x: (this.page.clientWidth - maxW) / 2, y: (this.page.clientHeight - maxW * ratio) / 2 }, maxW, maxW * ratio);
        this.page.appendChild(image);
        this._select(image);
        this._record('create', { element: image });
      };
    } catch (error) {
      if (url) { URL.revokeObjectURL(url); url = null; }
      console.error('[CanvasRuntime] PSD import failed:', error);
      this.notify(`PSD 导入失败：${error.message}`);
    }
  }

  notify(message) {
    const status = document.getElementById('saveStatus');
    if (!status) return;
    // 仅在本次提示为一批的开始（无挂起 token）时记录初始文案
    const isFirst = this._notifyToken === 0;
    const previous = isFirst ? status.textContent : this._notifyPrevious;
    const token = (this._notifyToken += 1);
    if (isFirst) this._notifyPrevious = previous;
    status.textContent = message;
    clearTimeout(this._notifyTimer);
    this._notifyTimer = setTimeout(() => {
      // L2: 仅最新一次提示恢复旧文案，避免短间隔提示互相覆盖
      if (token !== this._notifyToken) return;
      this._notifyToken = 0;
      this._notifyPrevious = null;
      if (status.isConnected) status.textContent = previous;
    }, 2600);
  }

  _pointerDown(event) {
    if (event.button !== 0 || !this.page || !this._isVisible()) return;
    const handle = event.target.closest('.canvas-handle');
    if (handle && this.selected) {
      event.preventDefault();
      const point = this._pagePoint(event);
      const element = this.selected;
      this.drag = {
        type: 'resize', element, handle: handle.dataset.handle,
        x: point.x, y: point.y,
        left: element.offsetLeft, top: element.offsetTop,
        width: element.offsetWidth, height: element.offsetHeight,
        ratio: element.offsetWidth / Math.max(element.offsetHeight, 1),
        changed: false,
      };
      event.stopPropagation();
      handle.setPointerCapture?.(event.pointerId);
      return;
    }
    const element = event.target.closest('.page-element');
    if (this.activeTool !== 'select') {
      event.preventDefault();
      this._createWithTool(event);
      return;
    }
    if (!element) { this._clearSelection(); return; }
    event.preventDefault();
    this._select(element, event.shiftKey);
    const point = this._pagePoint(event);
    // 统一使用布局后的像素位置，兼容初始的百分比定位
    const left = element.offsetLeft;
    const top = element.offsetTop;
    this.drag = { element, x: point.x, y: point.y, left, top, changed: false };
    element.setPointerCapture?.(event.pointerId);
  }

  _pointerMove(event) {
    if (!this.drag) return;
    const point = this._pagePoint(event);
    const dx = point.x - this.drag.x;
    const dy = point.y - this.drag.y;
    if (this.drag.type === 'resize') {
      this._resizeFromDrag(dx, dy, event.shiftKey);
    } else {
      this.drag.element.style.left = `${this.drag.left + dx}px`;
      this.drag.element.style.top = `${this.drag.top + dy}px`;
    }
    this.drag.changed = true;
    this._positionHandles();
  }

  _pointerUp() {
    if (this.drag?.changed && this.drag.type === 'resize') {
      this._record('resize', {
        element: this.drag.element,
        from: { left: this.drag.left, top: this.drag.top, width: this.drag.width, height: this.drag.height },
        to: { left: this.drag.element.offsetLeft, top: this.drag.element.offsetTop, width: this.drag.element.offsetWidth, height: this.drag.element.offsetHeight },
      });
    } else if (this.drag?.changed) {
      this._record('move', {
        element: this.drag.element,
        from: { left: this.drag.left, top: this.drag.top },
        to: { left: this.drag.element.offsetLeft, top: this.drag.element.offsetTop },
      });
    }
    this.drag = null;
  }

  _resizeFromDrag(dx, dy, keepRatio) {
    const d = this.drag;
    let left = d.left; let top = d.top;
    let width = d.width; let height = d.height;
    const h = d.handle;
    if (h.includes('e')) width = Math.max(24, d.width + dx);
    if (h.includes('w')) { width = Math.max(24, d.width - dx); left = d.left + d.width - width; }
    if (h.includes('s')) height = Math.max(24, d.height + dy);
    if (h.includes('n')) { height = Math.max(24, d.height - dy); top = d.top + d.height - height; }
    if (keepRatio) {
      // 区分主导方向：handle 含 e/w 以 width 为基准反推 height；仅含 n/s 则以 height 为基准反推 width
      if (h.includes('e') || h.includes('w')) {
        width = Math.max(24, width);
        height = Math.max(24, width / d.ratio);
      } else {
        height = Math.max(24, height);
        width = Math.max(24, height * d.ratio);
      }
      if (h.includes('w')) left = d.left + d.width - width;
      if (h.includes('n')) top = d.top + d.height - height;
    }
    d.element.style.left = `${left}px`;
    d.element.style.top = `${top}px`;
    d.element.style.width = `${width}px`;
    d.element.style.height = `${height}px`;
  }

  _doubleClick(event) {
    const element = event.target.closest('.text-element');
    if (!element) return;
    element.contentEditable = 'true';
    element.focus();
    const before = element.innerHTML;
    let observer = null;
    // 编辑期拦截粘贴：剪贴板 HTML 先净化再插入，避免 <img onerror=...> 等在 blur 前当场执行
    const onPaste = (e) => {
      e.preventDefault();
      const html = e.clipboardData?.getData?.('text/html');
      const text = e.clipboardData?.getData?.('text/plain');
      const safe = html ? sanitizeCanvasHtml(html) : '';
      if (safe) document.execCommand('insertHTML', false, safe);
      else if (text) document.execCommand('insertText', false, text);
    };
    element.addEventListener('paste', onPaste);
    const finish = () => {
      element.contentEditable = 'false';
      element.removeEventListener('blur', finish);
      element.removeEventListener('paste', onPaste);
      if (observer) { observer.disconnect(); observer = null; }
      // 完成编辑时净化 innerHTML，兜底防止可编辑区被注入恶意标签/事件
      const sanitized = sanitizeCanvasHtml(element.innerHTML);
      if (before !== sanitized) {
        this._record('text', { element, from: before, to: sanitized });
        element.innerHTML = sanitized;
      }
    };
    element.addEventListener('blur', finish);
    // 监听元素被从 DOM 移除的情况，避免 blur 永不触发导致事件/observer 泄漏
    observer = new MutationObserver(() => {
      if (!element.isConnected) finish();
    });
    if (element.parentNode) {
      observer.observe(element.parentNode, { childList: true });
    }
  }

  _createWithTool(event) {
    if (this.activeTool === 'text') {
      const el = document.createElement('div');
      el.className = 'page-element text-element';
      el.textContent = '新的文字';
      this._place(el, event, 180, 44);
      this.page.appendChild(el);
      this._select(el);
      this._record('create', { element: el });
      return;
    }
    if (this.activeTool === 'shape') {
      const el = document.createElement('div');
      el.className = 'page-element canvas-shape';
      this._place(el, event, 110, 80);
      this.page.appendChild(el);
      this._select(el);
      this._record('create', { element: el });
      return;
    }
    if (this.activeTool === 'image') this._pickImage(event);
    if (this.activeTool === 'grid') {
      this.page.classList.toggle('show-grid');
      this._notifyChange();
    }
  }

  _pickImage(event) {
    if (!this._imageInput) {
      this._imageInput = document.createElement('input');
      this._imageInput.type = 'file';
      this._imageInput.accept = 'image/*';
      this._imageInput.addEventListener('change', () => {
        const file = this._imageInput.files?.[0];
        if (!file) return;
        const el = document.createElement('img');
        el.className = 'page-element canvas-image';
        el.alt = file.name;
        this.resourceStore?.put(file, { name: file.name, type: file.type }).then(resource => {
          if (!resource) throw new Error('资源存储不可用');
          if (this._disposed || !this.page) return; // 存储完成前画布已释放，丢弃
          el.dataset.resourceId = resource.id;
          el.src = URL.createObjectURL(file);
          this._trackResourceUrl(resource.id, el.src);
          this._place(el, this._pendingPoint, 220, 150);
          this.page.appendChild(el);
          this._select(el);
          this._record('create', { element: el });
          this._imageInput.value = '';
        }).catch(error => this.notify(`图片保存失败：${error.message}`));
      });
    }
    this._pendingPoint = this._pagePoint(event);
    this._imageInput.click();
  }

  _place(element, eventOrPoint, width, height) {
    const p = eventOrPoint?.clientX == null ? eventOrPoint : this._pagePoint(eventOrPoint);
    element.style.width = `${width}px`;
    element.style.height = `${height}px`;
    element.style.left = `${p.x - width / 2}px`;
    element.style.top = `${p.y - height / 2}px`;
  }

  _pagePoint(event) {
    const rect = this.page.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  _select(element, additive = false) {
    if (!additive) this._clearSelection();
    this.selected = element;
    this.selectedSet.add(element);
    element.classList.add('selected');
    this._renderHandles();
  }

  deleteSelected() {
    if (!this.selectedSet.size) return;
    const snapshots = [...this.selectedSet].map(element => ({ element, parent: element.parentNode, next: element.nextSibling }));
    this._clearSelection();
    snapshots.forEach(snapshot => snapshot.element.remove());
    this._pushHistory({ type: 'deleteMany', snapshots });
    this._future.length = 0;
  }

  duplicateSelected() {
    if (!this.selectedSet.size) return;
    const clones = [...this.selectedSet].map(element => {
      const clone = element.cloneNode(true);
      clone.style.left = `${element.offsetLeft + 20}px`;
      clone.style.top = `${element.offsetTop + 20}px`;
      clone.classList.remove('selected');
      this.page.appendChild(clone);
      return clone;
    });
    this._clearSelection();
    clones.forEach(element => this._select(element, true));
    this._record('createMany', { elements: clones });
  }

  resizeSelected(scale = 1.1) {
    if (!this.selectedSet.size) return;
    const items = [...this.selectedSet].map(el => ({ element: el, from: { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight } }));
    items.forEach(({ element: el, from }) => { el.style.width = `${Math.max(24, from.width * scale)}px`; el.style.height = `${Math.max(24, from.height * scale)}px`; });
    this._record('resizeMany', { items: items.map(({ element, from }) => ({ element, from, to: { left: from.left, top: from.top, width: Math.max(24, from.width * scale), height: Math.max(24, from.height * scale) } })) });
  }

  _record(type, data = {}) {
    this._pushHistory({ type, ...data });
  }

  bringForward() { this._changeLayer(1); }
  sendBackward() { this._changeLayer(-1); }
  _changeLayer(direction) {
    if (!this.selectedSet.size) return;
    const items = [...this.selectedSet].map(element => ({ element, parent: element.parentNode, next: element.nextSibling }));
    [...this.selectedSet].forEach(element => {
      if (!element.parentNode) return; // 元素已脱离 DOM 时跳过，避免崩溃
      if (direction > 0) element.parentNode.appendChild(element);
      else element.parentNode.insertBefore(element, element.parentNode.firstChild);
    });
    this._record('layer', { items, direction });
  }

  _pushHistory(action) {
    this._history.push(action);
    this._notifyChange();
    this._trimHistory();
    this._future.length = 0;
  }

  _appendHistory(action) {
    this._history.push(action);
    this._notifyChange();
    this._trimHistory();
  }

  _notifyChange() { this.onChange?.(this.serialize()); }

  _trimHistory() {
    while (this._history.length > this._maxHistory) this._history.shift();
  }

  /* 撤销/重做不回收 blob URL：redo 仍需要该 URL，且 createMany 克隆元素与原创共享同一 URL，
     误回收会破坏原创与 redo。blob URL 统一在 dispose/_clearHistoryAndResources 时回收。 */

  undo() {
    const action = this._history.pop();
    if (!action) return;
    if (action.type === 'create') {
      action.element.remove();
      this._clearSelection();
    } else if (action.type === 'delete') {
      const { element, parent, next } = action.snapshot;
      parent.insertBefore(element, next);
      this._select(element);
    } else if (action.type === 'deleteMany') {
      action.snapshots.forEach(({ element, parent, next }) => parent.insertBefore(element, next));
      action.snapshots.forEach(({ element }) => this._select(element, true));
    } else if (action.type === 'createMany') {
      action.elements.forEach(element => element.remove());
      this._clearSelection();
    } else if (action.type === 'move') {
      action.element.style.left = `${action.from.left}px`;
      action.element.style.top = `${action.from.top}px`;
    } else if (action.type === 'moveMany') {
      action.items.forEach(item => {
        item.element.style.left = `${item.left}px`;
        item.element.style.top = `${item.top}px`;
      });
    } else if (action.type === 'resize') {
      action.element.style.width = `${action.from.width}px`;
      action.element.style.height = `${action.from.height}px`;
      action.element.style.left = `${action.from.left ?? action.element.offsetLeft}px`;
      action.element.style.top = `${action.from.top ?? action.element.offsetTop}px`;
    } else if (action.type === 'resizeMany') {
      action.items.forEach(item => { item.element.style.left = `${item.from.left}px`; item.element.style.top = `${item.from.top}px`; item.element.style.width = `${item.from.width}px`; item.element.style.height = `${item.from.height}px`; });
    } else if (action.type === 'layer') {
      action.items.slice().reverse().forEach(item => item.parent.insertBefore(item.element, item.next));
    } else if (action.type === 'text') {
      action.element.innerHTML = sanitizeCanvasHtml(action.from);
    }
    this._future.push(action);
    this._notifyChange();
  }

  redo() {
    const action = this._future.pop();
    if (!action) return;
    if (action.type === 'create' && !action.element.isConnected) {
      this.page.appendChild(action.element);
      this._select(action.element);
    } else if (action.type === 'createMany') {
      action.elements.forEach(element => this.page.appendChild(element));
      action.elements.forEach(element => this._select(element, true));
    } else if (action.type === 'delete' && action.snapshot.element.isConnected) {
      action.snapshot.element.remove();
      this._clearSelection();
    } else if (action.type === 'deleteMany') {
      action.snapshots.forEach(({ element }) => element.remove());
      this._clearSelection();
    } else if (action.type === 'move') {
      action.element.style.left = `${action.to.left}px`;
      action.element.style.top = `${action.to.top}px`;
    } else if (action.type === 'moveMany') {
      action.items.forEach(item => {
        item.element.style.left = `${item.toLeft}px`;
        item.element.style.top = `${item.toTop}px`;
      });
    } else if (action.type === 'resize') {
      action.element.style.width = `${action.to.width}px`;
      action.element.style.height = `${action.to.height}px`;
      action.element.style.left = `${action.to.left ?? action.element.offsetLeft}px`;
      action.element.style.top = `${action.to.top ?? action.element.offsetTop}px`;
    } else if (action.type === 'resizeMany') {
      action.items.forEach(item => { item.element.style.left = `${item.to.left}px`; item.element.style.top = `${item.to.top}px`; item.element.style.width = `${item.to.width}px`; item.element.style.height = `${item.to.height}px`; });
    } else if (action.type === 'layer') {
      action.items.forEach(item => action.direction > 0 ? item.parent.appendChild(item.element) : item.parent.insertBefore(item.element, item.parent.firstChild));
    } else if (action.type === 'text') {
      action.element.innerHTML = sanitizeCanvasHtml(action.to);
    }
    this._positionHandles();
    this._appendHistory(action);
    this._notifyChange();
  }

  _clearHistoryAndResources() {
    const urls = new Set();
    [...this._history, ...this._future].forEach(action => this._collectBlobUrls(action, urls, new WeakSet()));
    this.page?.querySelectorAll('img').forEach(el => { if (el.src?.startsWith('blob:')) urls.add(el.src); });
    urls.forEach(url => URL.revokeObjectURL(url));
    // 清空资源 URL 映射，避免 blob 泄漏
    this._revokeResourceUrls();
    this._history.length = 0; this._future.length = 0;
  }

  _collectBlobUrls(value, urls, seen) {
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    if (value.src?.startsWith?.('blob:')) urls.add(value.src);
    Object.values(value).forEach(v => { if (v && typeof v === 'object') this._collectBlobUrls(v, urls, seen); });
  }

  _clearSelection() {
    this.selectedSet.forEach(element => element.classList.remove('selected'));
    this.selected?.classList.remove('selected');
    this.selected = null;
    this.selectedSet.clear();
    this._removeHandles();
  }

  _renderHandles() {
    this._removeHandles();
    if (!this.page || !this.selected || this.selectedSet.size !== 1) return;
    const names = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    this._handles = names.map(name => {
      const handle = document.createElement('div');
      handle.className = `canvas-handle handle-${name}`;
      handle.dataset.handle = name;
      this.page.appendChild(handle);
      return handle;
    });
    this._positionHandles();
  }

  _positionHandles() {
    if (!this.selected || this._handles.length !== 8) return;
    const el = this.selected;
    const x = el.offsetLeft; const y = el.offsetTop;
    const w = el.offsetWidth; const h = el.offsetHeight;
    const positions = [
      [x, y], [x + w / 2, y], [x + w, y], [x + w, y + h / 2],
      [x + w, y + h], [x + w / 2, y + h], [x, y + h], [x, y + h / 2],
    ];
    this._handles.forEach((handle, index) => {
      handle.style.left = `${positions[index][0]}px`;
      handle.style.top = `${positions[index][1]}px`;
    });
  }

  _removeHandles() {
    this._handles.forEach(handle => handle.remove());
    this._handles = [];
  }

  // L6: 复用 init 时缓存的引用；若 init 时尚未存在则按需查询并缓存
  _isVisible() {
    const overlay = this._canvasOverlay || (this._canvasOverlay = document.getElementById('canvasOverlay'));
    return !overlay?.classList.contains('hidden');
  }

  dispose() {
    this._disposed = true;
    clearTimeout(this._notifyTimer);
    this._notifyTimer = 0;
    this.drag = null;
    this._clearSelection();
    if (this.viewport) {
      this.viewport.removeEventListener('pointerdown', this._onPointerDown);
      this.viewport.removeEventListener('pointermove', this._onPointerMove);
      this.viewport.removeEventListener('pointerup', this._onPointerUp);
      this.viewport.removeEventListener('pointercancel', this._onPointerUp);
    }
    this.page?.removeEventListener('dblclick', this._onDoubleClick);
    this._imageInput?.remove();
    this._imageInput = null;
    // 统一回收历史/未来的 blob URL 与资源 URL 映射（复用 _clearHistoryAndResources 单一入口）
    this._clearHistoryAndResources();
    this.onChange = null;
    this.viewport = null;
    this.page = null;
  }
}
