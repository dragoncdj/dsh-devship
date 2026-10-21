import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { listFilesDeep, pruneLogs } from '../lib/fs-scan.js';

async function tempDir(prefix) {
  return mkdtemp(join(tmpdir(), `dsh-devship-${prefix}-`));
}

test('listFilesDeep：相对路径用 / 分隔，.git 之类不进去', async () => {
  const dir = await tempDir('scan-');
  try {
    await writeFile(join(dir, 'a.txt'), 'a');
    await mkdir(join(dir, 'sub', 'deep'), { recursive: true });
    await writeFile(join(dir, 'sub', 'deep', 'b.txt'), 'bb');
    await mkdir(join(dir, '.git', 'objects'), { recursive: true });
    await writeFile(join(dir, '.git', 'objects', 'x.bin'), 'xxxxxxxx');
    await mkdir(join(dir, '__pycache__'), { recursive: true });
    await writeFile(join(dir, '__pycache__', 'p.pyc'), 'pp');

    const files = await listFilesDeep(dir);
    assert.deepEqual(files.map((file) => file.rel).sort(), ['a.txt', 'sub/deep/b.txt']);
    assert.deepEqual(files.map((file) => file.size).sort((left, right) => left - right), [1, 2]);
    assert.ok(files.every((file) => file.abs.startsWith(dir)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listFilesDeep：深度封顶，再深的目录不进去', async () => {
  const dir = await tempDir('deep-');
  try {
    let deepest = dir;
    for (let index = 0; index < 25; index += 1) {
      deepest = join(deepest, `d${index}`);
      await mkdir(deepest, { recursive: true });
    }
    await writeFile(join(dir, 'top.txt'), 't');
    await writeFile(join(deepest, 'deep.txt'), 'd');

    const rels = (await listFilesDeep(dir)).map((file) => file.rel);
    assert.ok(rels.includes('top.txt'), '浅的文件要列出来');
    assert.ok(!rels.includes('deep.txt'), '25 层深的文件不该被列出来');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pruneLogs：只留最近 60 个 .log，非 .log 文件不动', async () => {
  const dir = await tempDir('logs-');
  try {
    const now = Date.now();
    for (let index = 0; index < 70; index += 1) {
      const file = join(dir, `run-${index}.log`);
      await writeFile(file, 'x');
      // 最老的 10 个（index 0..9）mtime 最旧，应该被删掉
      const time = new Date(now - (70 - index) * 1000);
      await utimes(file, time, time);
    }
    await writeFile(join(dir, 'keep.txt'), '不是日志');

    await pruneLogs(dir);

    const left = await readdir(dir);
    assert.equal(left.filter((name) => name.endsWith('.log')).length, 60, '日志只留最近 60 个');
    assert.ok(left.includes('keep.txt'), '非 .log 文件不该被删');
    assert.ok(!left.includes('run-0.log'), '最老的日志该被删');
    assert.ok(left.includes('run-69.log'), '最新的日志要留着');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pruneLogs：目录不存在也不炸', async () => {
  await pruneLogs(join(await tempDir('nodir-'), 'missing'));
});
