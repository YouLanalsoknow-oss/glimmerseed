/**
 * 共享事件发射器 — 统一 on/emit 实现，供 SceneManager 与 BookmarkSystem 复用。
 * on 返回 off 令牌；emit 带 args，内部 try/catch 吞错（BookmarkSystem 原有行为）。
 */
export function createEmitter() {
  const listeners = new Map();
  return {
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(cb);
      return () => listeners.get(event)?.delete(cb);
    },
    emit(event, data) {
      listeners.get(event)?.forEach(cb => { try { cb(data); } catch (e) { console.error('[events]', event, e); } });
    },
    clear() {
      listeners.clear();
    },
  };
}