/** HTML 转义 — 将文本安全插入 DOM 属性/文本时使用，防止注入 */
export function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s || '';
  return div.innerHTML;
}