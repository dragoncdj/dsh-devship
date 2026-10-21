/**
 * dsh-devship 的同源 HTTP 路由（Host 半）。
 *
 * 全部挂在 /dsh-devship 前缀下，浏览器 fetch 直接调用，不需要 Remote 通道；
 * 任何失败都回 200 + { ok:false, error }，客户端只看 ok。
 * createRoutes(ctx, core) 的 core 是 lib/state.js + lib/scan.js + lib/build.js + lib/deploy.js 的能力集合。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { portBusy } from './lib/net.js';
import { createWarn } from './lib/log.js';
import { AUTO_CLEAR_DELAYS, normalizeAutoClear, readDeployConfig, readPrefs, readSshHosts, writeDeployConfig, writePrefs } from './lib/prefs.js';
import { logFileFor, pidAliveAsync, publicEntry, tailOf } from './lib/state.js';
import { readTail } from './lib/util.js';

const PREFIX = '/dsh-devship';

/**
 * 协议版本：路由路径或响应结构变了就 +1，Host 与 client.js 必须同步改。
 * /version 与 /diagnostics 里的版本号都从这里取，不再各写一份。
 */
const PROTOCOL = 4;

/** /log 一次最多回给浏览器多少字节（只读文件尾部，不整文件进内存）。 */
const LOG_TAIL_BYTES = 3_000_000;

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value !== null && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

/**
 * 生成路由表。
 * @param {object} ctx 插件上下文（要 webServer / subprocess / sandboxPolicy）
 * @param {object} core 各 lib 模块提供的状态与工作区、启动、打包、部署能力
 * @returns {Array<{ path: string, handler: Function }>} 路由表，由 index.js 逐条注册
 */
export function createRoutes(ctx, core) {
  const {
    adoptRuns,
    build,
    buildNode,
    builds,
    clearTasks,
    deployProject,
    effectiveRoot,
    forgetRun,
    invalidateExtraRoots,
    launch,
    processes,
    releaseProject,
    resolveExecutable,
    resolveJavaHome,
    scan,
    scanCache,
    stop,
    sweepAutoClear,
    workspaceRoot,
  } = core;

  /** 端口探测 / 接管失败这类「只影响界面」的问题写进 Host 日志。 */
  const warn = createWarn(ctx);

  async function status(root, logFor) {
    // 端口探测：让面板也能标出「已被外部实例占用」的服务（IDEA/终端起的那些）
    const ports = {};
    let scannedProjects = [];
    try {
      // 只用已有缓存：/status 每 2.5s 调一次，绝不能再触发一次扫描（sandbox 下要好几秒）
      const cached = scanCache.get(root);
      const projects = cached?.projects ?? [];
      scannedProjects = projects;
      if (cached === undefined) {
        // 还没有缓存（面板刚打开）：让客户端先请求 /list，这一轮不探测端口
        ports.__pending = true;
      }
      await Promise.all(projects
        .filter((project) => Number.isInteger(project.port))
        .map(async (project) => {
          ports[project.id] = await portBusy(project.port, 200);
        }));
    } catch (error) {
      // 端口探测失败：面板按「未知」处理，但 Host 日志里要留一条
      warn(`端口探测失败 (${root})`, error);
    }
    // DSH 重启后：把还在跑的服务认回来（state.json + 端口仍在监听）
    try {
      if (scannedProjects.length > 0) await adoptRuns(root, scannedProjects, ports);
    } catch (error) {
      warn(`接管已有进程失败 (${root})`, error);
    }
    // 脱离模式的进程没有 handle.done，靠 pid 判活
    for (const [id, entry] of processes.entries()) {
      if (entry.detached !== true || entry.state !== 'running') continue;
      const alive = Number.isInteger(entry.pid) ? await pidAliveAsync(entry.pid) : undefined;
      if (alive !== false) continue; // 活着或状态未知都先保留
      entry.state = 'exited';
      tailOf(entry);
      void forgetRun(root, id);
    }
    // 轮询响应不能带全量日志：7 个服务 × 100k 字符 ≈ 600KB/2.5s
    const STATUS_TAIL_MAX = 8000;
    // tailOf 照旧每条都调（日志采集、落盘靠它），这里只决定「响应对不对客户端露出来」
    const onlyFor = typeof logFor === 'string' ? logFor : undefined;
    const running = [];
    for (const entry of processes.values()) running.push(publicEntry(entry, STATUS_TAIL_MAX, onlyFor !== undefined && entry.id !== onlyFor));
    const building = [];
    for (const entry of builds.values()) building.push(publicEntry(entry, STATUS_TAIL_MAX, onlyFor !== undefined && entry.id !== onlyFor));
    return {
      root,
      running,
      builds: building,
      ports,
    };
  }

  /** 诊断：当前 Host 能看到的工作区来源，方便排查根目录解析问题。 */
  async function diagnostics() {
    const report = { code: `dsh-devship/${PROTOCOL}`, cwd: process.cwd(), registry: [], sessions: [], policy: undefined };
    try {
      const registry = ctx.get('workspaceRegistry');
      if (registry !== undefined && registry !== null && typeof registry.list === 'function') {
        for (const workspace of registry.list() ?? []) {
          let ids = [];
          try {
            ids = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];
          } catch {
            ids = [];
          }
          report.registry.push({
            path: typeof workspace?.path === 'string' ? workspace.path : '',
            title: typeof workspace?.title === 'string' ? workspace.title : '',
            sessions: ids.length,
          });
        }
      }
    } catch (error) {
      report.registryError = error instanceof Error ? error.message : String(error);
    }
    try {
      const sessions = ctx.get('sessions');
      if (sessions !== undefined && sessions !== null && typeof sessions.list === 'function') {
        for (const session of sessions.list().slice(-5)) {
          report.sessions.push({
            id: session?.id,
            cwd: session?.header?.cwd,
          });
        }
      }
    } catch (error) {
      report.sessionsError = error instanceof Error ? error.message : String(error);
    }
    try {
      const policy = ctx.get('sandboxPolicy');
      report.policy = policy?.workspaceRoot;
    } catch (error) {
      report.policyError = error instanceof Error ? error.message : String(error);
    }
    report.resolved = workspaceRoot();
    report.env = {
      platform: process.platform,
      mavenHome: process.env.MAVEN_HOME,
      m2Home: process.env.M2_HOME,
      pnpmHome: process.env.PNPM_HOME,
      pathMaven: (process.env.PATH ?? '').toLowerCase().includes('maven'),
    };
    try {
      report.mvn = await resolveExecutable('mvn', report.resolved);
    } catch (error) {
      report.mvnError = error instanceof Error ? error.message : String(error);
    }
    try {
      report.pnpm = await resolveExecutable('pnpm', report.resolved);
    } catch (error) {
      report.pnpmError = error instanceof Error ? error.message : String(error);
    }
    try {
      const jdk = await resolveJavaHome(report.resolved);
      report.java = { required: jdk.major, home: jdk.javaHome, envJavaHome: process.env.JAVA_HOME };
    } catch (error) {
      report.javaError = error instanceof Error ? error.message : String(error);
    }
    return report;
  }

  /** Client 半自检上报（最近 40 条），用来确认客户端模块是否真的加载了。 */
  const clientReports = [];

  const routes = [
    {
      path: `${PREFIX}/client-report`,
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            sendJson(res, 200, { ok: true, reports: clientReports });
            return;
          }
          const body = await readJsonBody(req);
          clientReports.push({ at: new Date().toISOString(), ...body });
          if (clientReports.length > 40) clientReports.shift();
          sendJson(res, 200, { ok: true });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      path: `${PREFIX}/version`,
      handler: async (req, res) => {
        sendJson(res, 200, { ok: true, version: String(PROTOCOL), diagnostics: await diagnostics(), clientReports });
      },
    },
    {
      path: `${PREFIX}/list`,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req);
          const root = await effectiveRoot(body.root);
          const scanned = await scan(root, body.force === true);
          const prefs = await readPrefs(root);
          const deploy = await readDeployConfig(root);
          const projects = scanned.projects.map((project) => {
            const target = deploy.targets[project.id];
            return target === undefined ? project : { ...project, deploy: target };
          });
          sendJson(res, 200, { ok: true, root: scanned.root, projects, hidden: prefs.hidden, autoClear: prefs.autoClear, deployAlias: deploy.alias ?? '' });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      // 偏好读写：不带 autoClear 字段 = 读取；带 = 校验后写入，并顺手清掉已完成的同类任务
      path: `${PREFIX}/prefs`,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req);
          const root = await effectiveRoot(body.root);
          const prefs = await readPrefs(root);
          if (req.method === 'GET' || body.autoClear === undefined) {
            sendJson(res, 200, { ok: true, hidden: prefs.hidden, autoClear: prefs.autoClear });
            return;
          }
          const incoming = body.autoClear;
          if (incoming === null || typeof incoming !== 'object') throw new Error('缺少 autoClear 对象');
          const merged = { ...prefs.autoClear };
          for (const key of ['build', 'deploy', 'release']) {
            if (typeof incoming[key] === 'boolean') merged[key] = incoming[key];
          }
          if (incoming.delayMs !== undefined) {
            const delay = Number(incoming.delayMs);
            if (!AUTO_CLEAR_DELAYS.includes(delay)) throw new Error('自动清除延迟不合法');
            merged.delayMs = delay;
          }
          const autoClear = normalizeAutoClear(merged);
          await writePrefs(root, { ...prefs, autoClear });
          invalidateExtraRoots();
          sweepAutoClear(autoClear);
          sendJson(res, 200, { ok: true, hidden: prefs.hidden, autoClear });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      path: `${PREFIX}/deploy-config`,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req);
          const root = await effectiveRoot(body.root);
          // 没有 config 字段 = 读取（客户端用 POST 带 root 来读，避免 GET 不能带 body）
          if (req.method === 'GET' || body.config === undefined) {
            const config = await readDeployConfig(root);
            // 明文密码只留在 Host 侧：回给浏览器的只有「有没有存过」
            const { password, ...publicConfig } = config;
            const hosts = await readSshHosts();
            sendJson(res, 200, {
              ok: true,
              config: { ...publicConfig, hasPassword: typeof password === 'string' && password !== '' },
              hosts: hosts.map((host) => ({ alias: host.alias, host: host.host, user: host.user, port: host.port, auth: host.auth?.kind ?? 'key' })),
            });
            return;
          }
          const incoming = body.config;
          if (incoming === null || typeof incoming !== 'object') throw new Error('缺少 config 对象');
          const stored = await readDeployConfig(root);
          const config = {
            ...typeof incoming.alias === 'string' && incoming.alias !== '' ? { alias: incoming.alias } : {},
            ...typeof incoming.host === 'string' && incoming.host !== '' ? { host: incoming.host } : {},
            ...Number.isInteger(incoming.port) ? { port: incoming.port } : {},
            ...typeof incoming.user === 'string' && incoming.user !== '' ? { user: incoming.user } : {},
            targets: {},
          };
          // 密码与重启命令：面板读回来的是 hasPassword，所以「留空 = 保持原值」，
          // 要清空得显式带 clearPassword / clearRestartCommand。
          if (body.clearPassword === true) {
            // 什么都不写：这次就是要把存着的密码删掉
          } else if (typeof incoming.password === 'string' && incoming.password !== '') {
            config.password = incoming.password;
          } else if (typeof stored.password === 'string' && stored.password !== '') {
            config.password = stored.password;
          }
          if (body.clearRestartCommand === true) {
            // 同上：显式清除
          } else if (typeof incoming.restartCommand === 'string' && incoming.restartCommand !== '') {
            config.restartCommand = incoming.restartCommand;
          } else if (typeof stored.restartCommand === 'string' && stored.restartCommand !== '') {
            config.restartCommand = stored.restartCommand;
          }
          for (const [id, target] of Object.entries(incoming.targets ?? {})) {
            if (target === null || typeof target !== 'object') continue;
            if (typeof target.remoteDir !== 'string' || target.remoteDir === '') continue;
            config.targets[id] = {
              remoteDir: target.remoteDir,
              ...typeof target.artifact === 'string' && target.artifact !== '' ? { artifact: target.artifact } : {},
              ...typeof target.container === 'string' && target.container !== '' ? { container: target.container } : {},
            };
          }
          await writeDeployConfig(root, config);
          const { password, ...publicConfig } = config;
          sendJson(res, 200, { ok: true, config: { ...publicConfig, hasPassword: typeof password === 'string' && password !== '' } });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      path: `${PREFIX}/deploy`,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req);
          const root = await effectiveRoot(body.root);
          const { projects } = await scan(root);
          const project = projects.find((candidate) => candidate.id === body.projectId);
          if (project === undefined) throw new Error(`未知项目: ${String(body.projectId)}`);
          const entry = await deployProject(project, root);
          sendJson(res, 200, { ok: true, entry: publicEntry(entry) });
        } catch (error) {
          sendJson(res, 200, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? String(error.stack ?? '').split('\n').slice(0, 6).join(' | ') : '',
          });
        }
      },
    },
    {
      path: `${PREFIX}/deploy-batch`,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req);
          const ids = Array.isArray(body.projectIds) ? body.projectIds.filter((item) => typeof item === 'string' && item !== '') : [];
          if (ids.length === 0) throw new Error('没有选中任何项目');
          const root = await effectiveRoot(body.root);
          const { projects } = await scan(root);
          const results = [];
          for (const id of ids.slice(0, 20)) {
            try {
              const project = projects.find((candidate) => candidate.id === id);
              if (project === undefined) throw new Error(`未知项目: ${id}`);
              await deployProject(project, root);
              results.push({ id, ok: true });
            } catch (error) {
              results.push({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
            }
          }
          sendJson(res, 200, { ok: true, results });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      path: `${PREFIX}/release`,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req);
          const root = await effectiveRoot(body.root);
          const { projects } = await scan(root);
          const project = projects.find((candidate) => candidate.id === body.projectId);
          if (project === undefined) throw new Error(`未知项目: ${String(body.projectId)}`);
          const entry = await releaseProject(project, root, { clean: body.clean === true, fast: body.fast === true });
          sendJson(res, 200, { ok: true, entry: publicEntry(entry) });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      path: `${PREFIX}/release-batch`,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req);
          const ids = Array.isArray(body.projectIds) ? body.projectIds.filter((item) => typeof item === 'string' && item !== '') : [];
          if (ids.length === 0) throw new Error('没有选中任何项目');
          const root = await effectiveRoot(body.root);
          const { projects } = await scan(root);
          const results = [];
          for (const id of ids.slice(0, 20)) {
            try {
              const project = projects.find((candidate) => candidate.id === id);
              if (project === undefined) throw new Error(`未知项目: ${id}`);
              await releaseProject(project, root, { clean: body.clean === true, fast: body.fast === true });
              results.push({ id, ok: true });
            } catch (error) {
              results.push({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
            }
          }
          sendJson(res, 200, { ok: true, results });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      path: `${PREFIX}/log`,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req);
          const id = typeof body.id === 'string' ? body.id : '';
          if (id === '') throw new Error('缺少 id');
          const root = await effectiveRoot(body.root);
          const entry = processes.get(id) ?? builds.get(id);
          const file = entry?.logFile ?? logFileFor(root, id);
          if (!existsSync(file)) {
            sendJson(res, 200, { ok: true, path: file, text: entry?.tail ?? '', bytes: 0 });
            return;
          }
          const { text, size, clipped } = await readTail(file, LOG_TAIL_BYTES);
          // 超大日志只回尾部 3MB，避免把浏览器卡死；文件本身不动
          sendJson(res, 200, { ok: true, path: file, text, bytes: size, clipped });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      path: `${PREFIX}/log-open`,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req);
          const id = typeof body.id === 'string' ? body.id : '';
          if (id === '') throw new Error('缺少 id');
          const root = await effectiveRoot(body.root);
          const entry = processes.get(id) ?? builds.get(id);
          const file = entry?.logFile ?? logFileFor(root, id);
          if (!existsSync(file)) throw new Error(`日志文件还不存在：${file}`);
          if (process.platform === 'win32') {
            execFile('explorer.exe', [`/select,${file}`], { windowsHide: false }, () => {});
          } else {
            execFile('xdg-open', [file], () => {});
          }
          sendJson(res, 200, { ok: true, path: file });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      path: `${PREFIX}/status`,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req);
          sendJson(res, 200, { ok: true, ...(await status(await effectiveRoot(body.root), body.logFor)) });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      path: `${PREFIX}/launch`,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req);
          if (typeof body.projectId !== 'string' || body.projectId === '') throw new Error('缺少 projectId');
          const entry = await launch(body.projectId, body.profile, await effectiveRoot(body.root), { detach: body.detach !== false });
          sendJson(res, 200, { ok: true, entry: publicEntry(entry) });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      path: `${PREFIX}/stop`,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req);
          if (typeof body.projectId !== 'string' || body.projectId === '') throw new Error('缺少 projectId');
          const entry = await stop(body.projectId, await effectiveRoot(body.root));
          sendJson(res, 200, { ok: true, entry: publicEntry(entry) });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      path: `${PREFIX}/build`,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req);
          const root = await effectiveRoot(body.root);
          // 按项目打包：Java 走 Maven，前端走 pnpm run build:prod
          if (typeof body.projectId === 'string' && body.projectId !== '') {
            const { projects } = await scan(root);
            const project = projects.find((candidate) => candidate.id === body.projectId);
            if (project === undefined) throw new Error(`未知项目: ${body.projectId}`);
            const built = project.kind === 'node'
              ? await buildNode(project, root)
              : await build(project.modulePath, body.clean === true, root, body.fast === true);
            sendJson(res, 200, { ok: true, entry: publicEntry(built) });
            return;
          }
          const modulePath = typeof body.modulePath === 'string' ? body.modulePath.trim() : '';
          const entry = await build(modulePath, body.clean === true, root, body.fast === true);
          sendJson(res, 200, { ok: true, entry: publicEntry(entry) });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      path: `${PREFIX}/forget`,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req);
          if (typeof body.id !== 'string' || body.id === '') throw new Error('缺少 id');
          const result = await clearTasks([body.id], body.force === true, await effectiveRoot(body.root));
          sendJson(res, 200, result);
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      path: `${PREFIX}/clear-tasks`,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req);
          const ids = Array.isArray(body.ids)
            ? body.ids.filter((item) => typeof item === 'string' && item !== '').slice(0, 200)
            : [];
          const result = await clearTasks(ids, body.force === true, await effectiveRoot(body.root));
          sendJson(res, 200, result);
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      path: `${PREFIX}/hide`,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req);
          if (typeof body.id !== 'string' || body.id === '') throw new Error('缺少 id');
          const root = await effectiveRoot(body.root);
          const prefs = await readPrefs(root);
          const next = new Set(prefs.hidden);
          if (body.hidden === false) next.delete(body.id);
          else next.add(body.id);
          await writePrefs(root, { ...prefs, hidden: [...next] });
          sendJson(res, 200, { ok: true, hidden: [...next] });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      path: `${PREFIX}/launch-batch`,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req);
          const ids = Array.isArray(body.projectIds) ? body.projectIds.filter((item) => typeof item === 'string' && item !== '') : [];
          if (ids.length === 0) throw new Error('没有选中任何项目');
          const root = await effectiveRoot(body.root);
          const results = [];
          for (const id of ids.slice(0, 20)) {
            try {
              const entry = await launch(id, body.profile, root, { detach: body.detach !== false });
              results.push({ id, ok: true, state: entry.state });
            } catch (error) {
              results.push({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
            }
          }
          sendJson(res, 200, { ok: true, results });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      path: `${PREFIX}/stop-batch`,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req);
          const ids = Array.isArray(body.projectIds) ? body.projectIds.filter((item) => typeof item === 'string' && item !== '') : [];
          if (ids.length === 0) throw new Error('没有选中任何项目');
          const stopRoot = await effectiveRoot(body.root);
          const results = [];
          for (const id of ids.slice(0, 20)) {
            try {
              const entry = await stop(id, stopRoot);
              results.push({ id, ok: true, state: entry.state });
            } catch (error) {
              results.push({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
            }
          }
          sendJson(res, 200, { ok: true, results });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
  ];

  return routes;
}
