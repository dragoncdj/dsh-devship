/**
 * dsh-devship 配置读取（Host 半）。
 *
 * 全部是「读一个 JSON 文件 + 校验形状」，坏文件一律回落默认值，绝不抛。
 * 落盘位置：
 *   <工作区>/.dsh-devship/prefs.json    隐藏服务列表 + 任务完成自动清除
 *   <工作区>/.dsh-devship/deploy.json   部署服务器与各包远端目录
 *   ~/.dsh/dsh-ssh.json                 dsh-ssh 插件的主机表（只读）
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readText } from './util.js';

/** 「任务完成自动清除」的默认值：默认关闭，行为与旧版一致。 */
export const AUTO_CLEAR_DEFAULT = { build: false, deploy: false, release: false, delayMs: 15000 };
/** 自动清除延迟只认这几档（面板下拉里就是这几项）。 */
export const AUTO_CLEAR_DELAYS = [0, 5000, 15000, 30000, 60000];

/** 延迟取值：只认整数和纯数字字符串，其它（null / true / 'abc'）一律 NaN → 回落默认。 */
function delayOf(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d+$/u.test(value.trim())) return Number(value.trim());
  return Number.NaN;
}

/** 校验偏好里的 autoClear：开关只认真布尔，延迟只认白名单里的值。 */
export function normalizeAutoClear(value) {
  const raw = value !== null && typeof value === 'object' ? value : {};
  const delay = delayOf(raw.delayMs);
  return {
    build: raw.build === true,
    deploy: raw.deploy === true,
    release: raw.release === true,
    delayMs: AUTO_CLEAR_DELAYS.includes(delay) ? delay : AUTO_CLEAR_DEFAULT.delayMs,
  };
}

/** 只留字符串项：偏好里的数组都是这么洗的。 */
function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

/**
 * 工作区级偏好，存在 <工作区>/.dsh-devship/prefs.json：
 *   hidden      —— 面板里折叠起来的服务
 *   autoClear   —— 打包 / 部署 / 发布跑完后自动从任务列表收起
 *   extraRoots  —— 额外允许面板指定的工作区路径（逃生口，手改文件用；默认空）
 */
export async function readPrefs(root) {
  const fallback = { hidden: [], extraRoots: [], autoClear: { ...AUTO_CLEAR_DEFAULT } };
  const text = await readText(join(root, '.dsh-devship', 'prefs.json'));
  if (text === undefined) return fallback;
  try {
    const value = JSON.parse(text);
    return {
      hidden: stringList(value?.hidden),
      extraRoots: stringList(value?.extraRoots),
      autoClear: normalizeAutoClear(value?.autoClear),
    };
  } catch {
    return fallback;
  }
}

export async function writePrefs(root, prefs) {
  const dir = join(root, '.dsh-devship');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'prefs.json'), `${JSON.stringify(prefs, null, 2)}\n`, 'utf8');
}

/**
 * 部署配置：<工作区>/.dsh-devship/deploy.json（多台服务器 + 每个包的远端目录）。
 *
 * 新形状是一组环境（开发 / 测试 / 生产 …），每个环境一台机器、一套远端目录覆盖：
 *   { defaultServer, servers: [ { id, label, host, port, user, password, alias, restartCommand, protected, targets } ], targets }
 * 老形状（顶层一台 + 一份 targets）读进来时合成成 id 为 default 的一个环境，
 * 下游只有一条代码路径，任务 id 与日志文件名也照旧。
 */
export const SERVER_ID_PATTERN = /^[a-z0-9-]{1,24}$/u;
/** 老 deploy.json 合成出来的那一台：任务 id 用它就不加后缀，与旧版逐字节一致。 */
export const LEGACY_SERVER_ID = 'default';
/** 环境上限：面板一屏放得下，也防手改文件塞进几百台。 */
export const SERVER_MAX = 12;
const LABEL_MAX = 24;
/** 连接参数就这几个，读、写、回传浏览器都按这一份口径洗。 */
const CONNECTION_KEYS = ['host', 'user', 'password', 'alias', 'restartCommand'];

const EMPTY_DEPLOY_CONFIG = { servers: [], defaultServer: '', targets: {} };

/** 非空字符串才留，其它（undefined / 数字 / 对象）一律不算配了。 */
function textOf(value) {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function labelOf(value, fallback) {
  const raw = textOf(value);
  return raw === undefined ? fallback : raw.slice(0, LABEL_MAX);
}

/** 环境 id：小写化后必须匹配形状，并且不许带下划线（下划线是任务 id 的分隔符，见 lib/deploy.js）。 */
function serverIdOf(value) {
  const raw = textOf(value);
  if (raw === undefined) return undefined;
  const trimmed = raw.trim().toLowerCase();
  return SERVER_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

/** 一台机器的连接参数：只留形状对的字段，乱七八糟的丢掉（与旧版逐字段过滤口径一致）。 */
function connectionOf(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const key of CONNECTION_KEYS) {
    const value = textOf(source[key]);
    if (value !== undefined) out[key] = value;
  }
  if (Number.isInteger(source.port)) out.port = source.port;
  return out;
}

/** 远端目录表：口径与旧版逐字节一致（条目里三个字段各自过滤，空对象也留着）。 */
function targetsOf(value) {
  const targets = {};
  if (value === null || typeof value !== 'object') return targets;
  for (const [id, target] of Object.entries(value)) {
    if (target === null || typeof target !== 'object') continue;
    targets[id] = {
      ...typeof target.remoteDir === 'string' && target.remoteDir !== '' ? { remoteDir: target.remoteDir } : {},
      ...typeof target.artifact === 'string' && target.artifact !== '' ? { artifact: target.artifact } : {},
      ...typeof target.container === 'string' && target.container !== '' ? { container: target.container } : {},
    };
  }
  return targets;
}

/** 没给 targets 字段 = 保持已存的；给了空对象 = 真清空。 */
function targetsField(incoming, stored) {
  return incoming !== undefined && incoming !== null ? targetsOf(incoming) : targetsOf(stored);
}

export async function readDeployConfig(root) {
  const text = await readText(join(root, '.dsh-devship', 'deploy.json'));
  if (text === undefined) return { ...EMPTY_DEPLOY_CONFIG };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ...EMPTY_DEPLOY_CONFIG };
  }
  const servers = [];
  const seen = new Set();
  for (const raw of Array.isArray(value?.servers) ? value.servers : []) {
    const id = serverIdOf(raw?.id);
    if (id === undefined || seen.has(id) || servers.length >= SERVER_MAX) continue;
    seen.add(id);
    servers.push({
      id,
      label: labelOf(raw?.label, id),
      protected: raw?.protected === true,
      ...connectionOf(raw),
      targets: targetsOf(raw?.targets),
    });
  }
  const targets = targetsOf(value?.targets);
  const legacy = connectionOf(value);
  if (servers.length === 0) {
    if (Object.keys(legacy).length === 0) return { servers: [], defaultServer: '', targets };
    // 老形状：顶层那一台合成成 id 为 default 的环境，顶层字段一个不动地留着。
    servers.push({ id: LEGACY_SERVER_ID, label: '默认', protected: false, ...legacy, targets: {} });
    return { servers, defaultServer: LEGACY_SERVER_ID, targets, ...legacy };
  }
  const base = servers.find((item) => item.id === serverIdOf(value?.defaultServer)) ?? servers[0];
  const mirror = connectionOf(base);
  delete mirror.password;
  // 顶层 host/port/user/alias 镜像默认那一台：老面板和新配置还能按老形状对话。
  return { servers, defaultServer: base.id, targets, ...mirror };
}

/**
 * 回给浏览器的形状：明文密码只留在 Host 侧，每台环境只回「有没有存过」。
 * 顶层 hasPassword 跟的是默认那台（老面板读的就是它）。
 */
export function publicDeployConfig(config) {
  const { password, ...rest } = config;
  const defaultId = typeof config.defaultServer === 'string' ? config.defaultServer : '';
  const servers = (Array.isArray(config.servers) ? config.servers : []).map((server) => {
    const { password: serverPassword, ...publicServer } = server;
    return {
      ...publicServer,
      hasPassword: typeof serverPassword === 'string' && serverPassword !== '',
      isDefault: server.id === defaultId,
    };
  });
  const base = servers.find((server) => server.id === defaultId);
  return {
    ...rest,
    hasPassword: (typeof password === 'string' && password !== '') || base?.hasPassword === true,
    servers,
    defaultServer: defaultId,
  };
}

/**
 * 校验并合并面板送上来的环境列表，返回能直接落盘的那一份。
 * 密码与重启命令沿用旧口径：留空 = 保持已存值，clearPassword / clearRestartCommand 才真删。
 * 校验不过就抛，交给路由变成 {ok:false,error}。
 */
export function mergeServers(incomingServers, stored) {
  if (!Array.isArray(incomingServers)) throw new Error('缺少 servers 数组');
  if (incomingServers.length > SERVER_MAX) throw new Error(`最多 ${SERVER_MAX} 个环境`);
  const storedServers = Array.isArray(stored?.servers) ? stored.servers : [];
  const out = [];
  const seen = new Set();
  for (const raw of incomingServers) {
    if (raw === null || typeof raw !== 'object') continue;
    const id = serverIdOf(raw.id);
    if (id === undefined) throw new Error(`环境 id 不合法（只能用字母、数字、- 和 _，最长 24）: ${String(raw.id ?? '')}`);
    if (seen.has(id)) throw new Error(`环境 id 重复: ${id}`);
    seen.add(id);
    const was = storedServers.find((item) => item.id === id);
    const server = {
      id,
      label: labelOf(raw.label, id),
      protected: raw.protected === true,
      ...connectionOf(raw),
      targets: targetsField(raw.targets, was?.targets),
    };
    if (raw.clearPassword === true) {
      // 什么都不写：这次就是要把这台存着的密码删掉
    } else if (typeof raw.password === 'string' && raw.password !== '') {
      server.password = raw.password;
    } else if (typeof was?.password === 'string' && was.password !== '') {
      server.password = was.password;
    }
    if (raw.clearRestartCommand === true) {
      // 同上：显式清除
    } else if (typeof raw.restartCommand === 'string' && raw.restartCommand !== '') {
      server.restartCommand = raw.restartCommand;
    } else if (typeof was?.restartCommand === 'string' && was.restartCommand !== '') {
      server.restartCommand = was.restartCommand;
    }
    out.push(server);
  }
  if (out.length === 0) throw new Error('至少要有 1 个环境');
  return out;
}

/** 把面板的一份 config 拼成能落盘的完整形状（新形状写入走这里）。 */
export function buildDeployConfig(incoming, stored) {
  const servers = mergeServers(incoming?.servers, stored);
  const base = servers.find((item) => item.id === serverIdOf(incoming?.defaultServer)) ?? servers[0];
  const mirror = connectionOf(base);
  delete mirror.password;
  return {
    defaultServer: base.id,
    servers,
    targets: targetsField(incoming?.targets, stored?.targets),
    ...mirror,
  };
}

/** 按 serverId 挑一台：没给就用默认那台。挑不到返回 {ok:false,error}。 */
export function resolveServer(config, serverId) {
  const servers = Array.isArray(config?.servers) ? config.servers : [];
  const wanted = textOf(serverId) ?? (typeof config?.defaultServer === 'string' ? config.defaultServer : '');
  if (servers.length === 0) return { ok: false, error: '还没有配置部署服务器：点「部署配置」填服务器地址，或者填 dsh-ssh 的 alias' };
  const server = servers.find((item) => item.id === wanted);
  if (server === undefined) return { ok: false, error: `未知环境: ${String(wanted)}` };
  return { ok: true, server };
}

/** 这个项目的远端目录：这个环境的覆盖优先，没有就用公共那份（口径与旧版一致）。 */
export function deployTargetOf(config, server, projectId) {
  const own = server?.targets?.[projectId];
  if (own !== undefined) return own;
  return config?.targets?.[projectId];
}

/** 默认那一台：老形状写入时要从它身上继承密码。 */
function defaultServerOf(config) {
  const servers = Array.isArray(config?.servers) ? config.servers : [];
  return servers.find((server) => server.id === config?.defaultServer) ?? servers[0];
}

/**
 * 老形状写入（一台机器 + 一份公共目录），语义与旧版逐字节一致：
 * `host/port/user/alias` 照旧「没送就没配」，密码与重启命令「留空保持、显式清除」。
 *
 * 多出来的那一条：老面板只会发顶层字段，它读到的密码本来就是「hasPassword」，所以顶层
 * `stored.password` 在新形状下是空的——这时从默认那一台继承，别让一次老面板保存把
 * 已经配好的环境密码擦掉。
 */
export function buildLegacyDeployConfig(body, incoming, stored) {
  const base = defaultServerOf(stored);
  const config = {
    ...typeof incoming.alias === 'string' && incoming.alias !== '' ? { alias: incoming.alias } : {},
    ...typeof incoming.host === 'string' && incoming.host !== '' ? { host: incoming.host } : {},
    ...Number.isInteger(incoming.port) ? { port: incoming.port } : {},
    ...typeof incoming.user === 'string' && incoming.user !== '' ? { user: incoming.user } : {},
    targets: {},
  };
  const storedPassword = textOf(stored?.password) ?? textOf(base?.password);
  const storedRestart = textOf(stored?.restartCommand) ?? textOf(base?.restartCommand);
  if (body?.clearPassword === true) {
    // 什么都不写：这次就是要把存着的密码删掉
  } else if (typeof incoming.password === 'string' && incoming.password !== '') {
    config.password = incoming.password;
  } else if (storedPassword !== undefined) {
    config.password = storedPassword;
  }
  if (body?.clearRestartCommand === true) {
    // 同上：显式清除
  } else if (typeof incoming.restartCommand === 'string' && incoming.restartCommand !== '') {
    config.restartCommand = incoming.restartCommand;
  } else if (storedRestart !== undefined) {
    config.restartCommand = storedRestart;
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
  return config;
}

export async function writeDeployConfig(root, config) {
  const dir = join(root, '.dsh-devship');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'deploy.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

/** 读 dsh-ssh 的主机表（~/.dsh/dsh-ssh.json），部署时按 alias 取连接参数。 */
export async function readSshHosts() {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');
  const text = await readText(join(home, 'dsh-ssh.json'));
  if (text === undefined) return [];
  try {
    const value = JSON.parse(text);
    return Array.isArray(value?.hosts) ? value.hosts : [];
  } catch {
    return [];
  }
}
