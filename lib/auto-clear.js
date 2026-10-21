/**
 * dsh-devship「任务完成自动清除」的判定部分（纯函数，可单测）。
 *
 * 有状态的部分（定时器表、builds 任务表）留在 index.js 里，这里只回答两个问题：
 *   - 这条任务属于哪一类（打包 / 部署 / 发布）
 *   - 这条任务算不算「跑完了」（成功 / 已停止；失败的不算）
 */

/** 条目属于哪一类任务：打包 / 部署 / 发布（自动清除开关按这三类分）。 */
export function autoClearKind(entry) {
  return entry.kind === 'deploy' || entry.kind === 'release' ? entry.kind : 'build';
}

/** 跑完的条目（成功 / 已停止）；失败的留在列表里，免得错误信息跟着条目一起消失。 */
export function isFinishedEntry(entry) {
  return entry.state === 'success' || entry.state === 'stopped';
}
