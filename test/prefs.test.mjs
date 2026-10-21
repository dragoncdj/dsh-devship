import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTO_CLEAR_DEFAULT,
  AUTO_CLEAR_DELAYS,
  normalizeAutoClear,
  readDeployConfig,
  readPrefs,
  writeDeployConfig,
  writePrefs,
} from '../lib/prefs.js';

const OFF = { build: false, deploy: false, release: false, delayMs: 15000 };

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-devship-prefs-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeRaw(root, file, text) {
  const dir = join(root, '.dsh-devship');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), text, 'utf8');
}

test('normalizeAutoClear：默认关闭，非法值一律回落', () => {
  assert.deepEqual(normalizeAutoClear(undefined), OFF);
  assert.deepEqual(normalizeAutoClear(null), OFF);
  assert.deepEqual(normalizeAutoClear('nope'), OFF);
  assert.deepEqual(normalizeAutoClear(42), OFF);
  assert.deepEqual(normalizeAutoClear([]), OFF);
});

test('normalizeAutoClear：开关只认真布尔', () => {
  assert.deepEqual(normalizeAutoClear({ build: 'true', deploy: 1, release: 'yes' }), OFF);
  assert.deepEqual(normalizeAutoClear({ build: true, deploy: true, release: true }), {
    build: true, deploy: true, release: true, delayMs: 15000,
  });
  assert.equal(normalizeAutoClear({ build: false }).build, false);
});

test('normalizeAutoClear：延迟只认白名单里的档位', () => {
  assert.equal(normalizeAutoClear({ delayMs: 0 }).delayMs, 0);
  assert.equal(normalizeAutoClear({ delayMs: 60000 }).delayMs, 60000);
  assert.equal(normalizeAutoClear({ delayMs: '15000' }).delayMs, 15000);
  for (const bad of [7, -1, 1000, 99999999, 'abc', NaN, undefined, null, true]) {
    assert.equal(normalizeAutoClear({ delayMs: bad }).delayMs, AUTO_CLEAR_DEFAULT.delayMs, `delayMs=${String(bad)}`);
  }
  assert.ok(AUTO_CLEAR_DELAYS.includes(AUTO_CLEAR_DEFAULT.delayMs), '默认延迟必须在白名单里');
});

test('readPrefs：没有 prefs.json 给全默认', async () => await withRoot(async (root) => {
  assert.deepEqual(await readPrefs(root), { hidden: [], extraRoots: [], autoClear: { ...OFF } });
}));

test('readPrefs：坏文件与形状不对都回落，不抛', async () => await withRoot(async (root) => {
  await writeRaw(root, 'prefs.json', '{ 这不是 JSON');
  assert.deepEqual(await readPrefs(root), { hidden: [], extraRoots: [], autoClear: { ...OFF } });

  await writeRaw(root, 'prefs.json', JSON.stringify({ hidden: 'ui/admin', autoClear: 'nope' }));
  assert.deepEqual(await readPrefs(root), { hidden: [], extraRoots: [], autoClear: { ...OFF } });

  // hidden 里混进非字符串：只留字符串
  await writeRaw(root, 'prefs.json', JSON.stringify({ hidden: ['ui/admin', 7, null, 'api'], autoClear: { build: 'true', delayMs: 5000 } }));
  assert.deepEqual(await readPrefs(root), { hidden: ['ui/admin', 'api'], extraRoots: [], autoClear: { ...OFF, delayMs: 5000 } });

  // 只有 hidden 的老文件（1.1.x 写的）：autoClear 补默认，不丢隐藏项
  await writeRaw(root, 'prefs.json', JSON.stringify({ hidden: ['old/service'] }));
  assert.deepEqual(await readPrefs(root), { hidden: ['old/service'], extraRoots: [], autoClear: { ...OFF } });
}));

test('readPrefs：extraRoots（工作区白名单的逃生口）只认字符串数组', async () => await withRoot(async (root) => {
  await writeRaw(root, 'prefs.json', JSON.stringify({ extraRoots: ['E:/other/project', 7, null, 'E:/another'] }));
  assert.deepEqual((await readPrefs(root)).extraRoots, ['E:/other/project', 'E:/another']);

  await writeRaw(root, 'prefs.json', JSON.stringify({ extraRoots: 'E:/not-an-array' }));
  assert.deepEqual((await readPrefs(root)).extraRoots, []);

  // 改 autoClear 时把 extraRoots 一起写回去（/prefs 路由就是 {...prefs, autoClear}）
  const prefs = await readPrefs(root);
  await writePrefs(root, { ...prefs, autoClear: { ...OFF, build: true } });
  const again = await readPrefs(root);
  assert.deepEqual(again.extraRoots, []);
  assert.equal(again.autoClear.build, true);
}));

test('writePrefs → readPrefs 往返；改 autoClear 不会把 hidden 洗掉', async () => await withRoot(async (root) => {
  await writePrefs(root, { hidden: ['ui/admin'], autoClear: { build: true, deploy: false, release: false, delayMs: 30000 } });
  const first = await readPrefs(root);
  assert.deepEqual(first.hidden, ['ui/admin']);
  assert.deepEqual(first.autoClear, { build: true, deploy: false, release: false, delayMs: 30000 });

  // /prefs 路由就是这么合并的
  await writePrefs(root, { ...first, autoClear: normalizeAutoClear({ build: true, deploy: true, release: true, delayMs: 0 }) });
  const second = await readPrefs(root);
  assert.deepEqual(second.hidden, ['ui/admin']);
  assert.deepEqual(second.autoClear, { build: true, deploy: true, release: true, delayMs: 0 });
}));

test('writePrefs 落盘：缩进 JSON + 结尾换行，手改也看得懂', async () => await withRoot(async (root) => {
  await writePrefs(root, { hidden: [], extraRoots: [], autoClear: { ...OFF } });
  const text = await readFile(join(root, '.dsh-devship', 'prefs.json'), 'utf8');
  assert.ok(text.endsWith('\n'), '结尾要有换行');
  assert.ok(text.includes('\n  "autoClear"'), '要带缩进');
}));

test('readDeployConfig：只认形状对的字段，空串和多余字段都丢掉', async () => await withRoot(async (root) => {
  await writeRaw(root, 'deploy.json', JSON.stringify({
    alias: 'prod',
    host: '',
    port: 22,
    user: 'deploy',
    password: 's3cret',
    restartCommand: 'docker restart api',
    junk: { a: 1 },
    targets: {
      api: { remoteDir: '/srv/api', container: 'api', artifact: 'api.jar', extra: 'x' },
      web: { remoteDir: '', container: null, artifact: 7 },
      bad: 'not an object',
    },
  }));
  const config = await readDeployConfig(root);
  assert.equal(config.alias, 'prod');
  assert.equal('host' in config, false);
  assert.equal(config.port, 22);
  assert.equal(config.user, 'deploy');
  assert.equal(config.password, 's3cret');
  assert.equal(config.restartCommand, 'docker restart api');
  assert.equal('junk' in config, false);
  assert.deepEqual(config.targets.api, { remoteDir: '/srv/api', artifact: 'api.jar', container: 'api' });
  assert.deepEqual(config.targets.web, {});
  assert.equal('bad' in config.targets, false);
}));

test('readDeployConfig：坏文件回落 { targets: {} }', async () => await withRoot(async (root) => {
  assert.deepEqual(await readDeployConfig(root), { targets: {} });
  await writeRaw(root, 'deploy.json', 'nope');
  assert.deepEqual(await readDeployConfig(root), { targets: {} });
  await writeRaw(root, 'deploy.json', JSON.stringify({ targets: 'x' }));
  assert.deepEqual(await readDeployConfig(root), { targets: {} });
}));

test('writeDeployConfig → readDeployConfig 往返：密码留在盘上（不回传浏览器是路由层的事）', async () => await withRoot(async (root) => {
  await writeDeployConfig(root, {
    alias: 'prod',
    user: 'deploy',
    password: 's3cret',
    targets: { api: { remoteDir: '/srv/api', container: 'api' } },
  });
  const config = await readDeployConfig(root);
  assert.equal(config.password, 's3cret');
  assert.equal(config.targets.api.container, 'api');
  assert.ok((await readFile(join(root, '.dsh-devship', 'deploy.json'), 'utf8')).endsWith('\n'));
}));
