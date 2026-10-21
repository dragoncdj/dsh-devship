import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { jdkRootHints } from '../lib/scan.js';
import { createState, logFileFor, publicEntry } from '../lib/state.js';

const base = { id: 'build:x', name: '打包 x', kind: 'build', state: 'success', startedAt: 1, tail: 'done' };

test('publicEntry 的字段集合：客户端就认这几个', () => {
  assert.deepEqual(Object.keys(publicEntry({ ...base }, 8000)), ['id', 'name', 'kind', 'state', 'startedAt', 'tail']);
});

test('publicEntry 只带条目上真有的字段', () => {
  const out = publicEntry({
    ...base,
    tool: 'pnpm',
    phase: 'package',
    exitCode: 0,
    error: 'boom',
    containerStatus: 'Up 3 minutes',
    adopted: true,
    port: 8080,
    pid: 4212,
    detached: true,
  }, 8000);
  assert.equal(out.tool, 'pnpm');
  assert.equal(out.phase, 'package');
  assert.equal(out.exitCode, 0);
  assert.equal(out.error, 'boom');
  assert.equal(out.containerStatus, 'Up 3 minutes');
  assert.deepEqual([out.adopted, out.port], [true, 8080]);
  assert.equal(out.pid, 4212);
  assert.equal(out.detached, true);
});

test('publicEntry 的 tail 截到上限；omitTail 时整个不带', () => {
  const long = 'x'.repeat(500);
  const cut = publicEntry({ ...base, tail: long }, 100);
  assert.equal(cut.tail.length, 100);
  assert.equal(cut.tail, long.slice(-100));
  assert.equal('tail' in publicEntry({ ...base, tail: long }, 100, true), false);
});

test('clearAt：排上了自动清除才露出来，没排上就没有这个字段', () => {
  assert.equal('clearAt' in publicEntry({ ...base }, 8000), false);
  assert.equal(publicEntry({ ...base, clearAt: 123456 }, 8000).clearAt, 123456);
  assert.equal('clearAt' in publicEntry({ ...base, clearAt: '123456' }, 8000), false);
});

test('progress：条目上有上传进度才带出去，没有就不加这个字段', () => {
  assert.equal('progress' in publicEntry({ ...base }, 8000), false);
  const progress = { uploaded: 100, total: 400, percent: 25, bytesPerSecond: 1024 };
  assert.deepEqual(publicEntry({ ...base, progress }, 8000).progress, progress);
});

test('JDK 常见目录按平台给，不跨平台乱扫', () => {
  const hints = jdkRootHints().map((hint) => hint());
  const windowsDirs = hints.some((hint) => typeof hint === 'string' && hint.includes('Program Files'));
  assert.ok(hints.some((hint) => typeof hint === 'string' && hint.includes('.jdks')), '各平台都该看 ~/.jdks（IDEA 下载的 JDK）');
  if (process.platform === 'win32') {
    assert.ok(windowsDirs, 'Windows 上应包含 Program Files 里的 JDK 目录');
  } else {
    assert.equal(windowsDirs, false, '非 Windows 上不该扫 Windows 安装目录');
  }
  if (process.platform === 'darwin') {
    assert.ok(hints.includes('/Library/Java/JavaVirtualMachines'), 'macOS 应扫 /Library/Java/JavaVirtualMachines');
  }
  if (process.platform === 'linux') {
    assert.ok(hints.includes('/usr/lib/jvm'), 'Linux 应扫 /usr/lib/jvm');
  }
});

test('日志文件名走 slug：任务 id 里的冒号不能变成非法文件名', () => {
  const file = logFileFor('E:/workspace/demo', 'build:pos-server');
  assert.ok(file.endsWith('build-pos-server.log'), file);
  assert.ok(!file.includes(':pos'), file);
});

test('isLiveEntry：running / building / stopping 算活着', () => {
  const state = createState();
  for (const kind of ['running', 'building', 'stopping']) {
    assert.equal(state.isLiveEntry({ id: 'x', state: kind }), true, kind);
  }
  for (const kind of ['success', 'failed', 'stopped', 'exited']) {
    assert.equal(state.isLiveEntry({ id: 'x', state: kind }), false, kind);
  }
  assert.equal(state.isLiveEntry(undefined), false);
});

test('sweepAutoClear 只清开关打开的同类已完成任务，失败的一律留着', () => {
  const state = createState();
  state.builds.set('build:a', { id: 'build:a', kind: 'build', state: 'success' });
  state.builds.set('build:b', { id: 'build:b', kind: 'build', state: 'failed' });
  state.builds.set('build:c', { id: 'build:c', kind: 'build', state: 'running' });
  state.builds.set('deploy:d', { id: 'deploy:d', kind: 'deploy', state: 'success' });
  state.builds.set('release:e', { id: 'release:e', kind: 'release', state: 'stopped' });
  state.sweepAutoClear({ build: true, deploy: false, release: true, delayMs: 0 });
  assert.deepEqual([...state.builds.keys()], ['build:b', 'build:c', 'deploy:d']);
});

test('rememberRun / forgetRun：state.json 写进去再删掉', async () => {
  const root = join(process.cwd(), '.tmp-state-root');
  const state = createState();
  try {
    await state.rememberRun(root, { id: 'pos-server', name: 'POS 服务', kind: 'java', port: 8080 }, { startedAt: 111, pid: 4242 });
    const onDisk = JSON.parse(await readFile(join(root, '.dsh-devship', 'state.json'), 'utf8'));
    assert.deepEqual(onDisk['pos-server'], { name: 'POS 服务', kind: 'java', port: 8080, startedAt: 111, pid: 4242 });
    await state.forgetRun(root, 'pos-server');
    const after = JSON.parse(await readFile(join(root, '.dsh-devship', 'state.json'), 'utf8'));
    assert.deepEqual(after, {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scheduleAutoClear：开关开了才排定时器，到点把任务从列表里删掉', async () => {
  const root = join(process.cwd(), '.tmp-state-root-2');
  const state = createState();
  try {
    await mkdir(join(root, '.dsh-devship'), { recursive: true });
    await writeFile(join(root, '.dsh-devship', 'prefs.json'), JSON.stringify({ autoClear: { build: true, delayMs: 5000 } }), 'utf8');
    const entry = { id: 'build:x', kind: 'build', state: 'success' };
    state.builds.set(entry.id, entry);
    await state.scheduleAutoClear(entry, root);
    assert.ok(Number.isInteger(entry.clearAt), '应排上 clearAt（面板据此显示「N 秒后收起」）');
    assert.ok(entry.clearAt > Date.now(), '延迟没到之前任务还在列表里');
    assert.ok(state.autoClearTimers.has(entry.id), '定时器排上了');
    state.clearAutoClearTimer(entry.id);
    assert.equal(entry.clearAt, undefined, '撤掉定时器后 clearAt 也清掉，面板不再显示倒计时');
    assert.ok(state.builds.has(entry.id), '撤掉后任务仍留在列表里');

    // 延迟 0 档：真的到点收起
    await writeFile(join(root, '.dsh-devship', 'prefs.json'), JSON.stringify({ autoClear: { build: true, delayMs: 0 } }), 'utf8');
    const now = { id: 'build:now', kind: 'build', state: 'stopped' };
    state.builds.set(now.id, now);
    await state.scheduleAutoClear(now, root);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(state.builds.has(now.id), false, '到点应自动收起');

    // 开关没开的类别不动
    const deploy = { id: 'deploy:y', kind: 'deploy', state: 'success' };
    state.builds.set(deploy.id, deploy);
    await state.scheduleAutoClear(deploy, root);
    assert.equal('clearAt' in deploy, false);
    assert.ok(state.builds.has(deploy.id));

    // 同一个 key 开了新一轮：旧定时器不能把新任务删掉
    const fresh = { id: 'build:now', kind: 'build', state: 'building' };
    state.builds.set('build:now', fresh);
    state.clearAutoClearTimer('build:now');
    assert.equal(state.builds.get('build:now'), fresh);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
