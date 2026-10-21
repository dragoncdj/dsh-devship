import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import plugin from '../index.js';

/**
 * 用假 ctx 把插件的 apply() 跑起来，直接调路由处理函数。
 * 只覆盖不碰外部世界的路由（配置读写、白名单），不启动真进程、不连 SSH。
 */
function fakeRes() {
  const chunks = [];
  return {
    statusCode: 0,
    writeHead(status) {
      this.statusCode = status;
    },
    end(body) {
      if (body !== undefined) chunks.push(Buffer.from(body));
    },
    json() {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    },
  };
}

function fakeReq(body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  // for await 允许异步迭代器返回普通（同步）迭代器
  return { method: 'POST', [Symbol.asyncIterator]: () => chunks[Symbol.iterator]() };
}

async function withPlugin(run) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-devship-routes-'));
  const routes = new Map();
  const stops = [];
  const services = {
    workspaceRegistry: { list: () => [{ path: root, sessionIds: ['s1'], updatedAt: 1 }] },
    sessions: { list: () => [{ id: 's1', header: { cwd: root } }] },
    sandboxPolicy: { workspaceRoot: root },
  };
  const ctx = {
    get: (name) => services[name],
    sandboxPolicy: services.sandboxPolicy,
    subprocess: {
      spawn: () => {
        throw new Error('路由测试里不该启动进程');
      },
      resolveExecutable: async (name) => name,
    },
    effect: (fn) => {
      const stop = fn();
      if (typeof stop === 'function') stops.push(stop);
    },
    webServer: {
      register: ({ path, handler }) => {
        routes.set(path, handler);
        return () => routes.delete(path);
      },
    },
  };
  plugin.apply(ctx);
  const call = async (path, body) => {
    const res = fakeRes();
    await routes.get(path)(fakeReq(body), res);
    return res.json();
  };
  try {
    return await run({ root, call, routes });
  } finally {
    for (const stop of stops) {
      try {
        await stop();
      } catch {
        /* 已经停了 */
      }
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function writePrefsFile(root, value) {
  const dir = join(root, '.dsh-devship');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'prefs.json'), JSON.stringify(value), 'utf8');
}

test('路由都注册上了', async () => await withPlugin(async ({ call, routes }) => {
  assert.ok(routes.size >= 20, `只注册了 ${routes.size} 条路由`);
  assert.ok(routes.has('/dsh-devship/deploy-config'));
  assert.ok(routes.has('/dsh-devship/prefs'));
  assert.equal(typeof call, 'function');
}));

test('路由表与协议版本：路径清单是硬约束（改了必须同步 client.js）', async () => await withPlugin(async ({ call, routes }) => {
  const expected = [
    'build', 'clear-tasks', 'client-report', 'deploy', 'deploy-batch', 'deploy-config', 'forget', 'hide',
    'launch', 'launch-batch', 'list', 'log', 'log-open', 'prefs', 'release', 'release-batch',
    'status', 'stop', 'stop-batch', 'version',
  ].map((name) => `/dsh-devship/${name}`).sort();
  assert.deepEqual([...routes.keys()].sort(), expected);

  // 版本号只有一个来源（routes.js 的 PROTOCOL），/version 与 /diagnostics 必须一致
  const version = await call('/dsh-devship/version');
  assert.equal(version.ok, true);
  assert.equal(version.version, '4');
  assert.equal(version.diagnostics.code, 'dsh-devship/4');
  assert.ok(Array.isArray(version.clientReports));
}));

test('/deploy-config：密码不回传浏览器，只回 hasPassword', async () => await withPlugin(async ({ root, call }) => {
  const saved = await call('/dsh-devship/deploy-config', {
    root,
    config: { user: 'deploy', password: 's3cret', targets: { api: { remoteDir: '/srv/api', container: 'api' } } },
  });
  assert.equal(saved.ok, true);
  assert.equal('password' in saved.config, false, '明文密码不能出现在响应里');
  assert.equal(saved.config.hasPassword, true);
  assert.equal(saved.config.user, 'deploy');

  const read = await call('/dsh-devship/deploy-config', { root });
  assert.equal(read.ok, true);
  assert.equal('password' in read.config, false);
  assert.equal(read.config.hasPassword, true);
  assert.equal(read.config.targets.api.container, 'api');
  // 盘上还是有的（部署要用），只是不出门
  const onDisk = await readFile(join(root, '.dsh-devship', 'deploy.json'), 'utf8');
  assert.ok(onDisk.includes('s3cret'), 'deploy.json 里应留着密码');
}));

test('/deploy-config：留空 = 保持已存密码；clearPassword 才真删', async () => await withPlugin(async ({ root, call }) => {
  await call('/dsh-devship/deploy-config', { root, config: { user: 'deploy', password: 's3cret', targets: {} } });

  // 面板保存时不带 password（用户没改）：旧密码必须还在
  const kept = await call('/dsh-devship/deploy-config', { root, config: { user: 'ops', targets: {} } });
  assert.equal(kept.config.hasPassword, true, '保存别的字段不该把密码洗掉');
  const read = await call('/dsh-devship/deploy-config', { root });
  assert.equal(read.config.user, 'ops');

  // 换密码
  const replaced = await call('/dsh-devship/deploy-config', { root, config: { password: 'new-pass', targets: {} } });
  assert.equal(replaced.config.hasPassword, true);

  // 显式清除
  const cleared = await call('/dsh-devship/deploy-config', { root, config: { targets: {} }, clearPassword: true });
  assert.equal(cleared.config.hasPassword, false);
  const after = await call('/dsh-devship/deploy-config', { root });
  assert.equal(after.config.hasPassword, false);
  assert.equal('password' in after.config, false);
}));

test('/deploy-config：restartCommand 同样是留空保持、显式清除', async () => await withPlugin(async ({ root, call }) => {
  const first = await call('/dsh-devship/deploy-config', { root, config: { restartCommand: 'docker restart api', targets: {} } });
  assert.equal(first.config.restartCommand, 'docker restart api');

  const kept = await call('/dsh-devship/deploy-config', { root, config: { user: 'ops', targets: {} } });
  assert.equal(kept.config.restartCommand, 'docker restart api');

  const cleared = await call('/dsh-devship/deploy-config', { root, config: { targets: {} }, clearRestartCommand: true });
  assert.equal('restartCommand' in cleared.config, false);
}));

test('effectiveRoot：白名单外的 root 回落到工作区，不会被采纳', async () => await withPlugin(async ({ root, call }) => {
  const outside = await mkdtemp(join(tmpdir(), 'dsh-devship-outside-'));
  try {
    const response = await call('/dsh-devship/deploy-config', { root: outside, config: { user: 'deploy', targets: {} } });
    assert.equal(response.ok, true);
    assert.equal(existsSync(join(outside, '.dsh-devship', 'deploy.json')), false, '陌生目录不该被写');
    assert.ok(existsSync(join(root, '.dsh-devship', 'deploy.json')), '应该落在工作区');

    // 相对路径、空串同样不采纳
    const relative = await call('/dsh-devship/deploy-config', { root: 'some/relative/path', config: { user: 'ops', targets: {} } });
    assert.equal(relative.ok, true);
    assert.equal(existsSync(join(process.cwd(), 'some', 'relative', 'path', '.dsh-devship', 'deploy.json')), false);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
}));

test('effectiveRoot：prefs.json 的 extraRoots 是逃生口，列进去的目录能用', async () => await withPlugin(async ({ root, call }) => {
  const extra = await mkdtemp(join(tmpdir(), 'dsh-devship-extra-'));
  try {
    await writePrefsFile(root, { extraRoots: [extra] });
    const response = await call('/dsh-devship/deploy-config', { root: extra, config: { user: 'deploy', targets: {} } });
    assert.equal(response.ok, true);
    assert.ok(existsSync(join(extra, '.dsh-devship', 'deploy.json')), 'extraRoots 里的目录应该被接受');
    assert.equal(existsSync(join(root, '.dsh-devship', 'deploy.json')), false, '不该再回落到工作区');
  } finally {
    await rm(extra, { recursive: true, force: true });
  }
}));

test('/prefs：自动清除开关与延迟档位都校验', async () => await withPlugin(async ({ root, call }) => {
  const bad = await call('/dsh-devship/prefs', { root, autoClear: { build: true, delayMs: 7000 } });
  assert.equal(bad.ok, false);
  assert.equal(typeof bad.error, 'string');

  const good = await call('/dsh-devship/prefs', { root, autoClear: { build: true, deploy: true, release: false, delayMs: 30000 } });
  assert.equal(good.ok, true);
  assert.deepEqual(good.autoClear, { build: true, deploy: true, release: false, delayMs: 30000 });

  const readBack = await call('/dsh-devship/prefs', { root });
  assert.deepEqual(readBack.autoClear, { build: true, deploy: true, release: false, delayMs: 30000 });
}));
