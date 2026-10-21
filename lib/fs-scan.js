// 文件系统扫描：日志目录清理 + 部署目录列文件。
// 共同点：一个个 await 就是几十次串行往返（sandbox 下每次 readdir/stat 都有额外开销），所以按 32 个一批并发。

import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const STAT_BATCH = 32;

/** 清掉老日志：超过 60 个文件或超过 7 天的删掉（只保留最近的）。 */
export async function pruneLogs(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const paths = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.log'))
      .map((entry) => join(dir, entry.name));
    const files = [];
    for (let start = 0; start < paths.length; start += STAT_BATCH) {
      const batch = await Promise.all(paths.slice(start, start + STAT_BATCH).map(async (path) => {
        try {
          return { path, time: (await stat(path)).mtimeMs };
        } catch {
          return undefined;
        }
      }));
      for (const file of batch) {
        if (file !== undefined) files.push(file);
      }
    }
    files.sort((left, right) => right.time - left.time);
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    const doomed = files.filter((file, index) => index >= 60 || file.time <= cutoff);
    for (let start = 0; start < doomed.length; start += STAT_BATCH) {
      await Promise.all(doomed.slice(start, start + STAT_BATCH).map((file) => unlink(file.path).catch(() => {})));
    }
  } catch {
    /* 目录不存在 */
  }
}

const LIST_MAX_DEPTH = 20;

/** 版本库 / IDE 的元数据目录：既不是要部署的东西，也不该被数进「几个文件、多少 MB」。 */
const LIST_SKIP_DIRS = new Set(['.git', '.svn', '.idea', '__pycache__']);

/**
 * 递归列出一个目录下的文件（相对路径 + 绝对路径 + 大小）。
 * 深度封顶 20 层；`.git` 这类元数据目录不进去；stat 并发。
 */
export async function listFilesDeep(dir, base = dir, out = [], depth = 0) {
  if (depth > LIST_MAX_DEPTH) return out;
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  for (let start = 0; start < files.length; start += STAT_BATCH) {
    const batch = await Promise.all(files.slice(start, start + STAT_BATCH).map(async (entry) => {
      const abs = join(dir, entry.name);
      const info = await stat(abs).catch(() => undefined);
      if (info === undefined) return undefined;
      return { abs, rel: abs.slice(base.length + 1).replace(/\\/gu, '/'), size: info.size };
    }));
    for (const file of batch) {
      if (file !== undefined) out.push(file);
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || LIST_SKIP_DIRS.has(entry.name)) continue;
    await listFilesDeep(join(dir, entry.name), base, out, depth + 1);
  }
  return out;
}
