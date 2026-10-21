/**
 * dsh-devship 通用小工具（Host 半）。
 *
 * 这里只放**无状态、不依赖插件上下文**的函数，方便直接单测（test/util.test.mjs）。
 * 有状态的东西（进程表、扫描缓存、日志文件）留在 index.js / 后续的状态模块里。
 */
import { open, readFile, readdir, stat } from 'node:fs/promises';

/** 读文本文件；读不到返回 undefined，调用方按「没有这个文件」处理。 */
export async function readText(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** 目录判定；任何异常一律 false。 */
export async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** 文件判定；任何异常一律 false。 */
export async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** 列一层目录名；读不到给空表。 */
export async function listDirectories(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * 只读文件尾部：日志可能几百 MB，整文件读进内存没必要。
 * 返回 { text, size, clipped }；size 是整个文件的大小。
 */
export async function readTail(file, maxBytes) {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    const length = Math.min(info.size, maxBytes);
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, info.size - length);
    // 从中间切一刀可能正好劈开一个多字节字符：开头那些孤立的替换符（每个坏字节一个）丢掉就行
    const text = buffer.toString('utf8').replace(/^\uFFFD+/u, '');
    return { text, size: info.size, clipped: info.size > length };
  } finally {
    await handle.close();
  }
}

/** 定时器：不拖住事件循环。 */
export function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/** POSIX 单引号转义（远端 shell 用）。 */
export function shellQuote(value) {
  return `'${String(value).replace(/'/gu, `'\\''`)}'`;
}

/** 按 Windows 命令行规则粗略拆分（够用于我们生成的 "exe arg arg" 形式）。 */
export function splitCommandLine(line) {
  const words = [];
  let current = '';
  let quoted = false;
  for (const char of String(line)) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === ' ' && !quoted) {
      if (current !== '') {
        words.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current !== '') words.push(current);
  return words;
}

/** 从 JDK 目录名解析主版本号（jdk-25.0.4 / ms-25.0.4 / jdk1.8.0_492 / openjdk-26 → 25/25/8/26）。 */
export function javaMajorOf(dir) {
  const name = dir.replace(/[\\/]+$/u, '').split(/[\\/]/u).pop() ?? '';
  const legacy = /(?:jdk|jre)[-_]?1\.(\d+)/iu.exec(name);
  if (legacy !== null) return Number(legacy[1]);
  const match = /(?:^|[^\d])(\d{2,3})(?:\.\d+)*/u.exec(name);
  if (match === null) return undefined;
  const major = Number(match[1]);
  return major >= 8 && major <= 99 ? major : undefined;
}

/**
 * 工作区路径归一化：去掉尾部分隔符；Windows 下大小写不敏感（E:\\A 和 e:\\a 是同一条）。
 * 只用于「这个路径在不在白名单里」的比对，用不用原样路径由调用方决定。
 */
export function normalizeRootPath(path) {
  const trimmed = String(path).replace(/[\\/]+$/u, '');
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

/** 把任务 id 变成能当文件名的片段（日志文件、启动脚本都用它）。 */
export function slug(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'task';
}
