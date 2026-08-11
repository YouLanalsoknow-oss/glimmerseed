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