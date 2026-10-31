import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTO_CLEAR_DEFAULT,
  AUTO_CLEAR_DELAYS,
  LEGACY_SERVER_ID,
  buildDeployConfig,
  deployTargetOf,
  mergeServers,
  normalizeAutoClear,
  publicDeployConfig,
  readDeployConfig,
  readPrefs,
  resolveServer,
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

test('readDeployConfig：坏文件回落「没有环境」（顶层字段一个不多）', async () => await withRoot(async (root) => {
  const EMPTY = { servers: [], defaultServer: '', targets: {} };
  assert.deepEqual(await readDeployConfig(root), EMPTY);
  await writeRaw(root, 'deploy.json', 'nope');
  assert.deepEqual(await readDeployConfig(root), EMPTY);
  await writeRaw(root, 'deploy.json', JSON.stringify({ targets: 'x' }));
  assert.deepEqual(await readDeployConfig(root), EMPTY);
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

test('老 deploy.json 合成成一台 default 环境：顶层字段照旧，目录还走公共表', async () => await withRoot(async (root) => {
  await writeRaw(root, 'deploy.json', JSON.stringify({
    host: '10.0.0.5', port: 22, user: 'deploy', password: 'old-pass',
    restartCommand: 'docker restart api',
    targets: { api: { remoteDir: '/srv/api' } },
  }));
  const config = await readDeployConfig(root);
  assert.equal(config.defaultServer, LEGACY_SERVER_ID);
  assert.deepEqual(config.servers.map((server) => server.id), [LEGACY_SERVER_ID]);
  assert.equal(config.servers[0].label, '默认');
  assert.equal(config.servers[0].host, '10.0.0.5');
  assert.equal(config.servers[0].password, 'old-pass', 'Host 内部要能拿到明文才能连 SSH');
  assert.equal(config.host, '10.0.0.5', '顶层形状一个字段都不动');

  const resolved = resolveServer(config, undefined);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.server.id, LEGACY_SERVER_ID);
  assert.equal(deployTargetOf(config, resolved.server, 'api').remoteDir, '/srv/api');
  assert.equal(deployTargetOf(config, resolved.server, '没有这个项目'), undefined);
}));

test('多环境往返：目录覆盖优先、顶层镜像默认那台、明文不回传浏览器', async () => await withRoot(async (root) => {
  await writeDeployConfig(root, {
    defaultServer: 'dev',
    servers: [
      { id: 'dev', label: '开发', host: '10.0.0.5', user: 'deploy', password: 'dev-pass', targets: { api: { remoteDir: '/srv/dev/api' } } },
      { id: 'prod', label: '生产', host: 'prod.example.com', user: 'release', protected: true, restartCommand: 'docker restart api', targets: { api: { remoteDir: '/data/apps/api' } } },
    ],
    targets: { api: { remoteDir: '/srv/common/api' }, web: { remoteDir: '/srv/common/web' } },
  });
  const config = await readDeployConfig(root);
  assert.equal(config.defaultServer, 'dev');
  assert.deepEqual(config.servers.map((server) => server.id), ['dev', 'prod']);
  assert.equal(config.host, '10.0.0.5', '顶层 host 镜像默认那一台，老面板照常对话');
  assert.equal(config.user, 'deploy');
  assert.equal('password' in config, false, '新形状的明文只留在各环境条目里');

  const dev = resolveServer(config, 'dev').server;
  const prod = resolveServer(config, 'prod').server;
  assert.equal(deployTargetOf(config, dev, 'api').remoteDir, '/srv/dev/api');
  assert.equal(deployTargetOf(config, prod, 'api').remoteDir, '/data/apps/api');
  assert.equal(deployTargetOf(config, prod, 'web').remoteDir, '/srv/common/web', '这个环境没配就用公共那份');
  assert.equal(prod.protected, true);
  assert.equal(prod.restartCommand, 'docker restart api');

  const publicConfig = publicDeployConfig(config);
  assert.equal(JSON.stringify(publicConfig).includes('dev-pass'), false, '整个回传里不许出现明文');
  assert.equal(publicConfig.servers[0].hasPassword, true);
  assert.equal(publicConfig.servers[1].hasPassword, false);
  assert.equal(publicConfig.hasPassword, true, '顶层 hasPassword 跟的是默认那台');
  assert.equal(publicConfig.servers[0].isDefault, true);
  assert.equal(publicConfig.servers[1].isDefault, false);
}));

test('publicDeployConfig：老形状合成出来的那一台也不能把明文带出去', async () => await withRoot(async (root) => {
  await writeRaw(root, 'deploy.json', JSON.stringify({ host: 'h', user: 'u', password: 's3cret', targets: { api: { remoteDir: '/srv/api' } } }));
  const config = await readDeployConfig(root);
  const publicConfig = publicDeployConfig(config);
  assert.equal('password' in publicConfig, false);
  assert.equal('password' in publicConfig.servers[0], false);
  assert.equal(publicConfig.servers[0].hasPassword, true);
  assert.equal(JSON.stringify(publicConfig).includes('s3cret'), false);
}));

test('mergeServers：密码留空保持已存、clearPassword 才真删，按环境各算一份', () => {
  const stored = {
    servers: [
      { id: 'dev', label: '开发', password: 'dev-old', restartCommand: 'docker restart dev' },
      { id: 'prod', label: '生产', password: 'prod-old' },
    ],
  };
  const merged = mergeServers([
    { id: 'dev', label: '开发', host: '10.0.0.5' },
    { id: 'prod', label: '生产', password: 'prod-new' },
  ], stored);
  assert.equal(merged.find((server) => server.id === 'dev').password, 'dev-old');
  assert.equal(merged.find((server) => server.id === 'dev').restartCommand, 'docker restart dev');
  assert.equal(merged.find((server) => server.id === 'prod').password, 'prod-new');

  const cleared = mergeServers([{ id: 'dev', clearPassword: true, clearRestartCommand: true }, { id: 'prod' }], stored);
  assert.equal('password' in cleared.find((server) => server.id === 'dev'), false);
  assert.equal('restartCommand' in cleared.find((server) => server.id === 'dev'), false);
  assert.equal(cleared.find((server) => server.id === 'prod').password, 'prod-old', '没动的环境不该被清掉');
});

test('mergeServers：id 不合法、重复、超过上限都是错误，不静默吞掉', () => {
  assert.throws(() => mergeServers([{ id: 'DEV server' }], { servers: [] }), /只能用字母/u);
  assert.throws(() => mergeServers([{ id: 'dev_api' }], { servers: [] }), /只能用字母/u);
  assert.throws(() => mergeServers([{ id: 'dev' }, { id: 'dev' }], { servers: [] }), /环境 id 重复: dev/u);
  assert.throws(() => mergeServers([], { servers: [] }), /至少要有 1 个环境/u);
  assert.throws(() => mergeServers('nope', { servers: [] }), /缺少 servers 数组/u);
  const many = Array.from({ length: 13 }, (_unused, index) => ({ id: `srv${index}` }));
  assert.throws(() => mergeServers(many, { servers: [] }), /最多 12 个环境/u);
});

test('buildDeployConfig：defaultServer 挑不到就回落第一个；没送 targets 字段保持已存的', () => {
  const stored = {
    servers: [{ id: 'dev', label: '开发', targets: { api: { remoteDir: '/old/api' } } }],
    targets: { web: { remoteDir: '/common/web' } },
  };
  const kept = buildDeployConfig({ defaultServer: '没有这个环境', servers: [{ id: 'dev', host: 'h' }] }, stored);
  assert.equal(kept.defaultServer, 'dev');
  assert.deepEqual(kept.targets, { web: { remoteDir: '/common/web' } }, '没送 targets 字段不该把公共表清空');
  assert.deepEqual(kept.servers[0].targets, { api: { remoteDir: '/old/api' } }, '没送环境目录不该把覆盖表清空');

  const rebuilt = buildDeployConfig({
    servers: [{ id: 'prod', host: 'p.example.com', user: 'r', port: 2222, password: 'secret' }],
    targets: {},
  }, stored);
  assert.equal(rebuilt.defaultServer, 'prod');
  assert.equal(rebuilt.host, 'p.example.com');
  assert.equal(rebuilt.port, 2222);
  assert.equal('password' in rebuilt, false, '顶层不镜像密码');
  assert.deepEqual(rebuilt.targets, {}, '送空对象就是真清空');
});

test('resolveServer：没有环境、id 未知都返回 ok:false，报错交给路由', () => {
  const none = resolveServer({ servers: [], defaultServer: '' }, 'dev');
  assert.equal(none.ok, false);
  assert.match(none.error, /还没有配置部署服务器/u);
  const unknown = resolveServer({ servers: [{ id: 'dev' }], defaultServer: 'dev' }, 'ghost');
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /未知环境: ghost/u);
  assert.equal(resolveServer({ servers: [{ id: 'dev' }], defaultServer: 'dev' }, undefined).server.id, 'dev');
  assert.equal(resolveServer({ servers: [{ id: 'dev' }], defaultServer: 'dev' }, '').server.id, 'dev');
});
