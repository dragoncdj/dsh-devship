import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isDirectory,
  javaMajorOf,
  listDirectories,
  normalizeRootPath,
  readTail,
  readText,
  shellQuote,
  sleep,
  splitCommandLine,
} from '../lib/util.js';

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-devship-util-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('readText：读得到给内容，读不到给 undefined（不抛）', async () => await withTempDir(async (dir) => {
  await writeFile(join(dir, 'a.txt'), '你好\n', 'utf8');
  assert.equal(await readText(join(dir, 'a.txt')), '你好\n');
  assert.equal(await readText(join(dir, 'missing.txt')), undefined);
  assert.equal(await readText(dir), undefined);
}));

test('isDirectory / listDirectories：任何异常都回落，不抛', async () => await withTempDir(async (dir) => {
  await mkdir(join(dir, 'sub'));
  await mkdir(join(dir, 'sub/deeper'));
  await writeFile(join(dir, 'f.txt'), 'x', 'utf8');
  assert.equal(await isDirectory(join(dir, 'sub')), true);
  assert.equal(await isDirectory(join(dir, 'f.txt')), false);
  assert.equal(await isDirectory(join(dir, 'nope')), false);
  assert.deepEqual(await listDirectories(dir), ['sub']);
  assert.deepEqual(await listDirectories(join(dir, 'nope')), []);
  assert.deepEqual(await listDirectories(join(dir, 'f.txt')), []);
}));

test('shellQuote：远端 shell 里的单引号被安全转义', () => {
  assert.equal(shellQuote('app'), "'app'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(shellQuote('a b'), "'a b'");
  assert.equal(shellQuote(123), "'123'");
  assert.equal(shellQuote(''), "''");
});

test('splitCommandLine：引号里的空格不拆', () => {
  assert.deepEqual(
    splitCommandLine('java -jar "C:\\Program Files\\app.jar" -Dx=1'),
    ['java', '-jar', 'C:\\Program Files\\app.jar', '-Dx=1'],
  );
  assert.deepEqual(splitCommandLine('  a   b  '), ['a', 'b']);
  assert.deepEqual(splitCommandLine(''), []);
  assert.deepEqual(splitCommandLine('"a b"'), ['a b']);
});

test('javaMajorOf：JDK 目录名 → 主版本号', () => {
  assert.equal(javaMajorOf('jdk-25.0.4'), 25);
  assert.equal(javaMajorOf('ms-25.0.4'), 25);
  assert.equal(javaMajorOf('jdk1.8.0_492'), 8);
  assert.equal(javaMajorOf('jre1.8.0_492'), 8);
  assert.equal(javaMajorOf('openjdk-26'), 26);
  assert.equal(javaMajorOf('C:\\Java\\jdk-17.0.2'), 17);
  assert.equal(javaMajorOf('/usr/lib/jvm/jdk-21.0.3+9'), 21);
  assert.equal(javaMajorOf('jdk-25.0.4/'), 25);
  assert.equal(javaMajorOf('jdk-25.0.4\\'), 25);
  // 不像版本号的目录名一律不认
  assert.equal(javaMajorOf('gradle'), undefined);
  assert.equal(javaMajorOf('jdk-7'), undefined);
  assert.equal(javaMajorOf('jdk-100'), undefined);
  assert.equal(javaMajorOf(''), undefined);
});

test('sleep：真的等一会儿，且定时器不拖住事件循环', async () => {
  // sleep 的定时器是 unref 的：没有别的东西吊着事件循环，进程会直接退出（这正是我们要的行为）。
  const keepAlive = setTimeout(() => {}, 500);
  const started = Date.now();
  await sleep(40);
  const elapsed = Date.now() - started;
  clearTimeout(keepAlive);
  assert.ok(elapsed >= 30, `sleep 只等了 ${elapsed}ms`);
});

test('normalizeRootPath：去尾部分隔符；Windows 下大小写不敏感', () => {
  const win32 = process.platform === 'win32';
  assert.equal(normalizeRootPath('E:\\workspace\\dsh-devship\\'), win32 ? 'e:\\workspace\\dsh-devship' : 'E:\\workspace\\dsh-devship');
  assert.equal(normalizeRootPath('/a/b///'), '/a/b');
  assert.equal(normalizeRootPath('E:\\A') === normalizeRootPath('e:\\a'), win32, '只有 Windows 把大小写当同一回事');
});

test('readTail：只回文件尾部，size 仍是整个文件的大小', async () => await withTempDir(async (dir) => {
  const file = join(dir, 'log.txt');
  const full = `head\n${'x'.repeat(1000)}\ntail\n`;
  await writeFile(file, full, 'utf8');

  const tail = await readTail(file, 10);
  assert.equal(tail.text, 'xxxx\ntail\n');
  assert.equal(tail.size, full.length);
  assert.equal(tail.clipped, true);

  const whole = await readTail(file, 10_000);
  assert.equal(whole.text, full);
  assert.equal(whole.size, full.length);
  assert.equal(whole.clipped, false);

  await writeFile(join(dir, 'empty.txt'), '', 'utf8');
  assert.deepEqual(await readTail(join(dir, 'empty.txt'), 100), { text: '', size: 0, clipped: false });
}));

test('readTail：尾部正好劈开多字节字符时，不把乱码留在开头', async () => await withTempDir(async (dir) => {
  const file = join(dir, 'utf8.txt');
  await writeFile(file, 'ab你好世界', 'utf8');
  const tail = await readTail(file, 5);
  assert.equal(tail.text, '界');
  assert.equal(tail.size, 14);
  assert.equal(tail.clipped, true);
}));

test('readTail：文件不存在就抛（调用方自己先判断存在性）', async () => await withTempDir(async (dir) => {
  await assert.rejects(() => readTail(join(dir, 'nope.txt'), 100), /ENOENT/u);
}));
