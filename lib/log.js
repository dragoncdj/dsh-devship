/**
 * Host 侧的「别把异常吞了」。
 *
 * 插件里有很多 catch 是故意的（文件不存在、进程已经退出），那些不该写日志；
 * 但「扫描失败」「请求的目录不在白名单」这类问题只体现在界面上很难查，
 * 这里给一个统一的 warn：同一个 scope 30 秒内只写一次，日志本身失败绝不再抛。
 * DSH 没给 logger 时它就是个空操作，功能不受影响。
 */

/** 同一个 scope 的重复告警合并窗口。 */
const WARN_TTL_MS = 30_000;
/** 同时记住多少个 scope（超出就清掉过期的）。 */
const WARN_CACHE_MAX = 64;

/**
 * @param {object} ctx 插件上下文（可能带 logger / log）
 * @returns {(scope: string, error: unknown) => void} 告警函数
 */
export function createWarn(ctx) {
  const logger = ctx?.logger ?? ctx?.log ?? undefined;
  const methods = logger === undefined || logger === null
    ? []
    : ['warn', 'error', 'info'].map((name) => (typeof logger[name] === 'function' ? logger[name].bind(logger) : undefined)).filter(Boolean);
  const recent = new Map();

  return function warn(scope, error) {
    const key = typeof scope === 'string' ? scope : String(scope);
    const now = Date.now();
    const last = recent.get(key);
    if (last !== undefined && now - last < WARN_TTL_MS) return;
    recent.set(key, now);
    if (recent.size > WARN_CACHE_MAX) {
      for (const [name, at] of recent) if (now - at >= WARN_TTL_MS) recent.delete(name);
    }
    if (methods.length === 0) return;
    try {
      const message = error instanceof Error ? error.message : String(error);
      methods[0](`${key}: ${message}`);
    } catch {
      /* 写日志失败不能再抛出去 */
    }
  };
}
