/** 模块级单例 div — 复用做 HTML 转义，避免每次调用 createElement 分配节点 */
const _div = typeof document !== 'undefined' ? document.createElement('div') : null;

/** HTML 转义 — 将文本安全插入 DOM 属性/文本时使用，防止注入 */
export function escapeHtml(s) {
  if (!_div) return String(s ?? '');
  _div.textContent = s == null ? '' : String(s);
  return _div.innerHTML;
}