/**
 * 运行状态（Host 内部）：进程表 / 任务表、日志落盘与尾部采集、pid 判活、
 * state.json 持久化、自动清除调度。不依赖扫描 / 打包 / 部署，谁要任务条目都从这里拿。
 */
import { execFile } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { autoClearKind, isFinishedEntry } from './auto-clear.js';
import { pruneLogs } from './fs-scan.js';
import { invalidatePortProbe, portBusy } from './net.js';
import { readPrefs } from './prefs.js';
import { readText, sleep, slug } from './util.js';

/** 单个进程 / 打包任务保留的日志尾部字符数。 */
const MAX_TAIL = 100000;
const PID_ALIVE_TTL_MS = 4000;
const PID_ALIVE_CACHE_MAX = 128;

/** 日志落盘目录：<工作区>/.dsh-devship/logs。 */
export function logDir(root) {
  return join(root, '.dsh-devship', 'logs');
}

export function logFileFor(root, id) {
  return join(logDir(root), `${slug(id)}.log`);
}

const logDirReady = new Set();

/** 运行状态持久化：<工作区>/.dsh-devship/state.json（DSH 重启后据此接管）。 */
export async function readRunState(root) {
  const text = await readText(join(root, '.dsh-devship', 'state.json'));
  if (text === undefined) return {};
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

export async function writeRunState(root, value) {
  const dir = join(root, '.dsh-devship');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'state.json'), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** 按端口找监听进程的 pid（Windows: netstat -ano / POSIX: lsof）。 */
export function pidByPort(port) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, timeout: 15000 }, (error, stdout) => {
        if (error !== undefined && error !== null) {
          resolve(undefined);
          return;
        }
        const pattern = new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'u');
        for (const line of String(stdout).split(/\r?\n/u)) {
          const matched = pattern.exec(line);
          if (matched !== null) {
            resolve(Number(matched[1]));
            return;
          }
        }
        resolve(undefined);
      });
      return;
    }
    execFile('lsof', ['-ti', `:${port}`], { timeout: 15000 }, (error, stdout) => {
      const pid = Number(String(stdout ?? '').trim().split(/\s+/u)[0]);
      resolve(Number.isInteger(pid) && pid > 0 ? pid : undefined);
    });
  });
}

/** 结束整棵进程树。 */
export function killTree(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 20000 }, () => resolve());
      return;
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已退出 */
    }
    resolve();
  });
}

/**
 * 异步判活 + 4s 缓存。
 * /status 每 2.5s 调一次，之前每个 detached 条目都同步跑一次 tasklist（7 个服务≈1.5s），
 * 直接把宿主事件循环堵住，所有接口都变慢。
 */
const pidAliveCache = new Map();

/** 条目被删掉后那个 pid 就没人再问了：过期的一律清掉，缓存别无限涨。 */
function prunePidAliveCache(now) {
  if (pidAliveCache.size < PID_ALIVE_CACHE_MAX) return;
  for (const [pid, hit] of pidAliveCache) {
    if (now - hit.at > PID_ALIVE_TTL_MS) pidAliveCache.delete(pid);
  }
  // 还挤就按插入顺序从最老的开始扔
  while (pidAliveCache.size >= PID_ALIVE_CACHE_MAX) {
    const oldest = pidAliveCache.keys().next();
    if (oldest.done === true) return;
    pidAliveCache.delete(oldest.value);
  }
}

export function pidAliveAsync(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(false);
  const hit = pidAliveCache.get(pid);
  const now = Date.now();
  if (hit !== undefined && now - hit.at < PID_ALIVE_TTL_MS) return Promise.resolve(hit.alive);
  if (process.platform !== 'win32') {
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    prunePidAliveCache(now);
    pidAliveCache.set(pid, { alive, at: now });
    return Promise.resolve(alive);
  }
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      // 取不到答案时不给「已死」的结论（否则一次 tasklist 抖动就把 state.json 里的记录删了）
      const alive = error === null || error === undefined ? String(stdout ?? '').includes(String(pid)) : undefined;
      const at = Date.now();
      prunePidAliveCache(at);
      pidAliveCache.set(pid, { alive, at });
      resolve(alive);
    });
  });
}

/** 把一条已存在日志文件的尾部读进内存（不截断文件）。 */
export function seedTailFromLog(entry) {
  if (typeof entry.logFile !== 'string' || entry.logFile === '' || !existsSync(entry.logFile)) return;
  try {
    const info = statSync(entry.logFile);
    const from = Math.max(0, info.size - 30000);
    const length = info.size - from;
    const buffer = Buffer.alloc(length);
    const fd = openSync(entry.logFile, 'r');
    try {
      readSync(fd, buffer, 0, length, from);
    } finally {
      closeSync(fd);
    }
    entry.tail = buffer.toString('utf8');
    entry.logOffset = info.size;
  } catch {
    /* 忽略 */
  }
}

/** 追加日志：内存尾部（限长）+ 落盘（全量）。 */
export function appendLog(entry, text) {
  if (typeof text !== 'string' || text === '') return;
  entry.tail += text;
  if (entry.tail.length > MAX_TAIL) entry.tail = entry.tail.slice(-MAX_TAIL);
  if (typeof entry.logFile === 'string' && entry.logFile !== '') {
    try {
      appendFileSync(entry.logFile, text, 'utf8');
    } catch {
      /* 落盘失败不影响面板 */
    }
  }
}

/** 给任务条目挂上日志文件（首次调用时建目录 + 清理旧文件）。 */
export async function attachLogFile(entry, root, name) {
  const dir = logDir(root);
  if (!logDirReady.has(dir)) {
    await mkdir(dir, { recursive: true }).catch(() => {});
    logDirReady.add(dir);
    void pruneLogs(dir);
  }
  entry.logFile = logFileFor(root, name);
  try {
    writeFileSync(entry.logFile, '', 'utf8');
  } catch {
    /* 忽略 */
  }
  return entry;
}

/**
 * 追加日志尾部：
 *  - 脱离模式没有管道，启动脚本把 stdout/stderr 重定向到文件，从文件按偏移读；
 *  - 其它情况读子进程的 collected stdout/stderr。
 */
export function tailOf(entry) {
  if (typeof entry.logPath === 'string' && entry.logPath !== '') {
    try {
      const info = statSync(entry.logPath);
      const from = entry.logOffset ?? 0;
      if (info.size > from) {
        const length = Math.min(info.size - from, 64 * 1024);
        const buffer = Buffer.alloc(length);
        const fd = openSync(entry.logPath, 'r');
        try {
          readSync(fd, buffer, 0, length, from);
        } finally {
          closeSync(fd);
        }
        entry.logOffset = from + length;
        appendLog(entry, buffer.toString('utf8'));
      }
    } catch {
      /* 文件还没创建 */
    }
    return entry.tail;
  }
  if (entry.handle === undefined) return entry.tail;
  let collected = {};
  try {
    collected = entry.handle.collected ?? {};
  } catch {
    collected = {};
  }
  const stdout = collected.stdout;
  if (stdout !== undefined) {
    const chunk = stdout.readFrom(entry.stdoutOffset ?? 0);
    entry.stdoutOffset = chunk.nextOffset;
    if (chunk.text) appendLog(entry, chunk.text);
  }
  const stderr = collected.stderr;
  if (stderr !== undefined) {
    const chunk = stderr.readFrom(entry.stderrOffset ?? 0);
    entry.stderrOffset = chunk.nextOffset;
    if (chunk.text) appendLog(entry, chunk.text);
  }
  return entry.tail;
}

/** 任务条目回给浏览器的形状（字段顺序客户端就认这几个）。 */
export function publicEntry(entry, tailLimit, omitTail = false) {
  const full = tailOf(entry);
  const tail = Number.isInteger(tailLimit) && full.length > tailLimit ? full.slice(-tailLimit) : full;
  return {
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    ...entry.tool === undefined ? {} : { tool: entry.tool },
    state: entry.state,
    ...entry.phase === undefined ? {} : { phase: entry.phase },
    startedAt: entry.startedAt,
    ...entry.exitCode === undefined ? {} : { exitCode: entry.exitCode },
    ...entry.error === undefined ? {} : { error: entry.error },
    ...entry.containerStatus === undefined ? {} : { containerStatus: entry.containerStatus },
    ...entry.adopted === true ? { adopted: true, port: entry.port } : {},
    ...Number.isInteger(entry.pid) ? { pid: entry.pid } : {},
    ...entry.detached === true ? { detached: true } : {},
    ...Number.isInteger(entry.clearAt) ? { clearAt: entry.clearAt } : {},
    ...entry.progress === undefined ? {} : { progress: entry.progress },
    ...omitTail ? {} : { tail },
  };
}

/** 建一套运行状态：进程表 + 任务表 + 自动清除定时器。 */
export function createState() {
  const processes = new Map();
  const builds = new Map();
  const autoClearTimers = new Map();

  async function rememberRun(root, project, entry) {
    // 刚起的服务得能被探到：把几秒前「端口还空着」的旧答案作废
    invalidatePortProbe(project.port);
    try {
      const saved = await readRunState(root);
      saved[project.id] = {
        name: project.name,
        kind: project.kind,
        ...Number.isInteger(project.port) ? { port: project.port } : {},
        startedAt: entry.startedAt,
        ...Number.isInteger(entry.pid) ? { pid: entry.pid } : {},
        ...typeof entry.logPath === 'string' ? { logPath: entry.logPath } : {},
        ...typeof entry.logFile === 'string' ? { logFile: entry.logFile } : {},
      };
      await writeRunState(root, saved);
    } catch {
      /* 持久化失败不影响启动 */
    }
  }

  async function forgetRun(root, projectId) {
    try {
      const saved = await readRunState(root);
      if (saved[projectId] === undefined) return;
      delete saved[projectId];
      await writeRunState(root, saved);
    } catch {
      /* 忽略 */
    }
  }

  /** 任务是否还在跑（清除这类任务需要先中断）。 */
  function isLiveEntry(entry) {
    return entry !== undefined
      && (entry.state === 'running' || entry.state === 'building' || entry.state === 'stopping');
  }

  /**
   * 中断一个任务：
   *  - 打包：结束子进程；
   *  - 部署：断开正在上传的 SSH 连接；
   *  - 发布：递归中断当前阶段的子任务。
   * 注意：只把条目从列表里删掉不会停进程，所以「清除运行中的任务」必须先走这里。
   */
  async function cancelTask(entry, seen) {
    if (entry === undefined || entry === null) return;
    const visited = seen ?? new Set();
    if (visited.has(entry)) return;
    visited.add(entry);
    entry.cancelRequested = true;
    if (entry.handle !== undefined) {
      try { entry.handle.terminate(); } catch { /* 已退出 */ }
    }
    if (entry.client !== undefined) {
      try { entry.client.end(); } catch { /* 已断开 */ }
    }
    if (typeof entry.childId === 'string') {
      const child = builds.get(entry.childId);
      if (child !== undefined) await cancelTask(child, visited);
    }
    if (entry.handle !== undefined && typeof entry.handle.waitForExit === 'function') {
      try {
        await Promise.race([entry.handle.waitForExit(), sleep(2500)]);
      } catch {
        /* 已退出 */
      }
    }
  }

  /**
   * DSH 重启后接管仍在本机跑着的服务：state.json 里有记录 + 端口仍在监听 → 建一条
   * 「接管」条目放进 processes，面板就能显示成运行中，并能直接停止。
   */
  async function adoptRuns(root, projects, ports) {
    const saved = await readRunState(root);
    let changed = false;
    for (const [id, run] of Object.entries(saved)) {
      if (processes.has(id)) continue;
      const project = projects.find((candidate) => candidate.id === id);
      const port = Number.isInteger(run?.port) ? run.port : project?.port;
      // 存活判据：优先 pid（脱离模式一定记录 pid），没有 pid 再看端口
      const pid = Number.isInteger(run?.pid) && await pidAliveAsync(run.pid) ? run.pid : undefined;
      const busy = pid !== undefined
        ? true
        : Number.isInteger(port) ? ports[project?.id ?? id] === true || (await portBusy(port, 200)) : false;
      if (!busy) {
        delete saved[id];
        changed = true;
        continue;
      }
      const entry = {
        id,
        name: run?.name ?? project?.name ?? id,
        kind: project?.kind ?? run?.kind ?? 'java',
        state: 'running',
        adopted: true,
        ...pid === undefined ? {} : { pid, detached: true },
        startedAt: typeof run?.startedAt === 'number' ? run.startedAt : Date.now(),
        ...Number.isInteger(port) ? { port } : {},
        tail: '',
        ...typeof run?.logPath === 'string' ? { logPath: run.logPath } : {},
        ...typeof run?.logFile === 'string' ? { logFile: run.logFile } : {},
      };
      seedTailFromLog(entry);
      processes.set(id, entry);
    }
    if (changed) await writeRunState(root, saved);
  }

  /** 撤掉某个任务待执行的自动清除定时器。 */
  function clearAutoClearTimer(id) {
    const timer = autoClearTimers.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    autoClearTimers.delete(id);
    const entry = builds.get(id);
    if (entry !== undefined) entry.clearAt = undefined;
  }

  /**
   * 任务跑完后按偏好自动从「执行任务」列表里移除（日志文件保留，随时能翻）。
   * 延迟到 delayMs 之后再删，面板上先看到「打包完成 / 已停止」，再收起来；
   * clearAt 一并写进条目，面板据此显示「N 秒后收起」。
   */
  async function scheduleAutoClear(entry, root) {
    if (!isFinishedEntry(entry)) return;
    const prefs = await readPrefs(root).catch(() => undefined);
    if (prefs === undefined || prefs.autoClear[autoClearKind(entry)] !== true) return;
    clearAutoClearTimer(entry.id);
    const delayMs = prefs.autoClear.delayMs;
    entry.clearAt = Date.now() + delayMs;
    const timer = setTimeout(() => {
      autoClearTimers.delete(entry.id);
      entry.clearAt = undefined;
      // 同一个 key 可能已经开了新一轮任务：只有还是这一条时才删
      if (builds.get(entry.id) === entry) builds.delete(entry.id);
    }, delayMs);
    if (typeof timer.unref === 'function') timer.unref();
    autoClearTimers.set(entry.id, timer);
  }

  /** 开关刚打开时，把已经跑完的同类任务立刻清掉（失败的不动）。 */
  function sweepAutoClear(autoClear) {
    for (const [id, entry] of [...builds.entries()]) {
      if (autoClear[autoClearKind(entry)] !== true) continue;
      if (!isFinishedEntry(entry)) continue;
      clearAutoClearTimer(id);
      builds.delete(id);
    }
  }

  return {
    processes,
    builds,
    autoClearTimers,
    rememberRun,
    forgetRun,
    isLiveEntry,
    cancelTask,
    adoptRuns,
    clearAutoClearTimer,
    scheduleAutoClear,
    sweepAutoClear,
  };
}
