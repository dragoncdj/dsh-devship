// 本机端口探测：面板要能标出「这个端口的服务不是我起的」（IDEA / 终端里跑的那些）。
// /status 每 2.5s 一轮、每个项目一次 connect，所以结果缓存 3 秒；端口状态刚变时由调用方作废。

import { connect } from 'node:net';

const PORT_PROBE_TTL_MS = 3000;
const PORT_PROBE_MAX = 64;
const portProbeCache = new Map();

/** 端口状态刚变（刚启动 / 刚停掉）时把缓存里那条抹掉，别让面板拿旧答案。 */
export function invalidatePortProbe(port) {
  if (Number.isInteger(port)) portProbeCache.delete(port);
}

/** 探测本机端口是否已被占用（启动前提示「服务可能已在运行」；状态里标记外部实例）。 */
export function portBusy(port, timeoutMs = 800) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return Promise.resolve(false);
  const hit = portProbeCache.get(port);
  const now = Date.now();
  if (hit !== undefined && now - hit.at < PORT_PROBE_TTL_MS) return Promise.resolve(hit.busy);
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const settle = (value) => {
      socket.destroy();
      portProbeCache.set(port, { busy: value, at: Date.now() });
      if (portProbeCache.size > PORT_PROBE_MAX) {
        // 探测过的端口就那么多；超了从最老的开始扔
        const oldest = portProbeCache.keys().next();
        if (oldest.done !== true) portProbeCache.delete(oldest.value);
      }
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}
