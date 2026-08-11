/**
 * 共享工具 — 基于 requestAnimationFrame 的节流合并。
 * 同一帧内多次调用返回的调度函数只执行一次 fn，避免高频事件导致重复 DOM 更新/重绘。
 *
 * @param {Function} fn 待合并执行的回调
 * @returns {Function} throttled 可调用调度函数；附带 .cancel() 取消尚未执行的调度
 */
export function schedule(fn) {
  let rafId = 0;
  const run = () => {
    rafId = 0;
    fn();
  };
  const cancel = () => {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  };
  const throttled = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(run);
  };
  throttled.cancel = cancel;
  return throttled;
}