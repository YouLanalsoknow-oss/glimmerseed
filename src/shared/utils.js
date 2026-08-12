/** structuredClone 优先，缺失时回退 JSON 序列化（比 JSON 快约 2-3 倍且支持更多类型） */
export function clone(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

/** 从 URL/路径中解析文件名（资源依赖名），解码失败时回退原始名称 */
export function dependencyName(url) {
  const raw = String(url).split(/[?#]/)[0].split(/[\\/]/).pop();
  try {
    return decodeURIComponent(raw);
  } catch (_) {
    return raw;
  }
}

/** 画布富文本允许保留的标签白名单（其余标签降级为纯文本） */
const CANVAS_SAFE_TAGS = new Set([
  'DIV', 'P', 'SPAN', 'BR', 'B', 'I', 'EM', 'STRONG', 'U', 'S', 'SUB', 'SUP',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'HR', 'IMG',
]);

function _isSafeAttrName(name) {
  // 丢弃全部事件处理器（on*）与可执行上下文属性；
  // srcset/usemap/poster/background/lowsrc 等可携带 data:/javascript: 载荷的 URL 属性一并移除
  return !name.startsWith('on')
    && !['style', 'srcdoc', 'formaction', 'xlink:href', 'srcset', 'usemap', 'poster', 'background', 'lowsrc', 'longdesc', 'dynsrc', 'xref'].includes(name);
}

function _isSafeUrl(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim().toLowerCase();
  return !(v.startsWith('javascript:') || v.startsWith('vbscript:') || v.startsWith('data:text/html') || v.startsWith('data:text/plain'));
}

function _isSafeStyle(value) {
  if (typeof value !== 'string') return false;
  const v = value.toLowerCase();
  return !(v.includes('javascript:') || v.includes('expression(') || v.includes('url('));
}

/** 净化内联 style 字符串：过滤可执行 CSS（javascript:/expression()/url()）。空值或危险样式返回空串。 */
export function sanitizeCanvasStyle(value) {
  if (typeof value !== 'string') return '';
  return _isSafeStyle(value) ? value : '';
}

/**
 * 净化画布存档中的富文本 HTML，防存储型 XSS。
 * - 非白名单标签降级为纯文本（丢弃其子结构与事件）
 * - 移除 on* 事件处理器、style/srcdoc/formaction 等危险属性
 * - src/href 仅允许非 javascript:/vbscript:/data:text 协议
 * 用于 restore 与 undo/redo 的 innerHTML 还原路径。
 */
export function sanitizeCanvasHtml(html) {
  if (typeof html !== 'string') return '';
  const template = document.createElement('template');
  template.innerHTML = html;
  const walk = (node) => {
    [...node.children].forEach(child => {
      if (!CANVAS_SAFE_TAGS.has(child.tagName)) {
        child.replaceWith(document.createTextNode(child.textContent || ''));
        return;
      }
      [...child.attributes].forEach(attr => {
        const name = attr.name.toLowerCase();
        if (!_isSafeAttrName(name)) { child.removeAttribute(attr.name); return; }
        if (name === 'src' && !_isSafeUrl(attr.value)) { child.removeAttribute(attr.name); return; }
        if (name === 'href' && !_isSafeUrl(attr.value)) { child.removeAttribute(attr.name); return; }
      });
      walk(child);
    });
  };
  walk(template.content);
  return template.innerHTML;
}