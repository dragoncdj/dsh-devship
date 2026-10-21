/**
 * 上传进度与速度（纯计算，不碰网络，好测）。
 *
 * 用法：上传前 createUploadProgress(总字节, { onTick })，
 * 每个文件 beginFile(key, 大小) → 若干次 stepFile(key, 已传字节) → endFile(key)。
 * key 只是给同一个文件用的编号，并发上传（兜底的 8 路 SFTP）各占一格，互不干扰。
 * onTick 最多每 tickMs 收到一次快照（某个文件传完那次一定会收到），
 * 免得 SFTP 每几 KB 回调一次就把日志刷爆。
 */

/** 快照回调节流：默认半秒一次。 */
const DEFAULT_TICK_MS = 500;
/** 算速度只用最近这段时间的样本，整轮平均会把速度算得偏低。 */
const SPEED_WINDOW_MS = 5000;
/** 最多留多少个采样点。 */
const SAMPLE_MAX = 40;

function positive(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * @param {number} totalBytes 总字节（不知道就先给 0，之后 setTotal）
 * @param {object} [options] onTick(快照) / tickMs / now（测试注入时钟）
 */
export function createUploadProgress(totalBytes, options = {}) {
  const onTick = typeof options.onTick === 'function' ? options.onTick : undefined;
  const tickMs = Number.isInteger(options.tickMs) && options.tickMs > 0 ? options.tickMs : DEFAULT_TICK_MS;
  const now = typeof options.now === 'function' ? options.now : Date.now;

  let total = positive(totalBytes);
  /** 已经传完的文件字节合计。 */
  let done = 0;
  /** 正在传的文件：key → { size, done }。 */
  const active = new Map();
  /** { at, bytes } 累计已传采样点。 */
  const samples = [];
  // 初始成 -∞：第一次有进度就一定报一次，不用等满一个节流窗口
  let lastTickAt = Number.NEGATIVE_INFINITY;

  const transferred = () => {
    let sum = done;
    for (const item of active.values()) sum += item.done;
    return sum;
  };

  const snapshot = (at) => {
    const uploaded = transferred();
    // 基准取「窗口起点之前最近的那个点」：只用窗口内两点相减，样本少时速度会算飞
    let base;
    for (const item of samples) {
      if (at - item.at > SPEED_WINDOW_MS) base = item;
      else break;
    }
    const from = base ?? (samples.length > 0 ? samples[0] : { at, bytes: 0 });
    const seconds = (at - from.at) / 1000;
    const bytesPerSecond = seconds <= 0 ? 0 : Math.max(0, (uploaded - from.bytes) / seconds);
    return {
      uploaded,
      total,
      percent: total > 0 ? Math.min(100, Math.round((uploaded / total) * 100)) : 0,
      bytesPerSecond,
    };
  };

  const sample = (at) => {
    samples.push({ at, bytes: transferred() });
    if (samples.length > SAMPLE_MAX) samples.shift();
  };

  const tick = (at, force) => {
    if (!force && at - lastTickAt < tickMs) return;
    lastTickAt = at;
    onTick?.(snapshot(at));
  };

  return {
    /** 总大小要等本地 tar 打完才知道，所以允许后补。 */
    setTotal(value) {
      total = positive(value);
    },
    beginFile(key, size) {
      active.set(key, { size: positive(size), done: 0 });
    },
    stepFile(key, bytes) {
      const item = active.get(key);
      if (item === undefined) return;
      item.done = Math.min(positive(bytes), item.size);
      const at = now();
      sample(at);
      tick(at, false);
    },
    endFile(key) {
      const item = active.get(key);
      if (item === undefined) return;
      done += item.size;
      active.delete(key);
      const at = now();
      sample(at);
      tick(at, true);
    },
    snapshot(at = now()) {
      return snapshot(at);
    },
  };
}

/** 12.3 MB / 512 KB 这样的人类可读大小。 */
export function formatBytes(value) {
  const bytes = positive(value);
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
}

/** 4.8 MB/s 这样的速度；没数据时给一个短横。 */
export function formatSpeed(bytesPerSecond) {
  const bytes = positive(bytesPerSecond);
  if (bytes === 0) return '—';
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB/s`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB/s`;
  return `${Math.round(bytes)} B/s`;
}
