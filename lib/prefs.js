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

/** 部署配置：<工作区>/.dsh-devship/deploy.json（服务器别名 + 每个包的远端目录）。 */
export async function readDeployConfig(root) {
  const text = await readText(join(root, '.dsh-devship', 'deploy.json'));
  if (text === undefined) return { targets: {} };
  try {
    const value = JSON.parse(text);
    const targets = {};
    if (value !== null && typeof value === 'object' && value.targets !== null && typeof value.targets === 'object') {
      for (const [id, target] of Object.entries(value.targets)) {
        if (target === null || typeof target !== 'object') continue;
        targets[id] = {
          ...typeof target.remoteDir === 'string' && target.remoteDir !== '' ? { remoteDir: target.remoteDir } : {},
          ...typeof target.artifact === 'string' && target.artifact !== '' ? { artifact: target.artifact } : {},
          ...typeof target.container === 'string' && target.container !== '' ? { container: target.container } : {},
        };
      }
    }
    return {
      ...typeof value?.alias === 'string' && value.alias !== '' ? { alias: value.alias } : {},
      ...typeof value?.host === 'string' && value.host !== '' ? { host: value.host } : {},
      ...Number.isInteger(value?.port) ? { port: value.port } : {},
      ...typeof value?.user === 'string' && value.user !== '' ? { user: value.user } : {},
      ...typeof value?.password === 'string' && value.password !== '' ? { password: value.password } : {},
      ...typeof value?.restartCommand === 'string' && value.restartCommand !== '' ? { restartCommand: value.restartCommand } : {},
      targets,
    };
  } catch {
    return { targets: {} };
  }
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
