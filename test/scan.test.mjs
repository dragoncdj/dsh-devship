/**
 * lib/scan.js 的测试：项目扫描结果、扫描缓存、工作区白名单、工具定位兜底链。
 * 用临时 fixture 工作区，不依赖真机上的 mvn / pnpm / JDK。
 */
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { createScanner, pomModules, portFromYaml, toId } from '../lib/scan.js';

const ROOT = join(process.cwd(), '.tmp-scan-root');

function fakeCtx(root, { resolveExecutable } = {}) {
  return {
    get(name) {
      if (name === 'workspaceRegistry') return { list: () => [{ path: root, sessionIds: ['s1'], updatedAt: 10 }] };
      if (name === 'sessions') return { list: () => [{ id: 's1', header: { cwd: root }, cwd: root }] };
      if (name === 'sandboxPolicy') return { workspaceRoot: root };
      return undefined;
    },
    subprocess: { resolveExecutable },
  };
}

async function writeFixture() {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(join(ROOT, 'pos', 'pos-server', 'src', 'main', 'java'), { recursive: true });
  await mkdir(join(ROOT, 'pos', 'pos-server', 'src', 'main', 'resources'), { recursive: true });
  await mkdir(join(ROOT, 'web'), { recursive: true });
  await mkdir(join(ROOT, 'node_modules', 'skipme'), { recursive: true });
  await mkdir(join(ROOT, 'fakejdk', 'bin'), { recursive: true });
  await writeFile(join(ROOT, 'pom.xml'), [
    '<project>',
    '  <properties><java.version>17</java.version></properties>',
    '  <modules><module>pos</module></modules>',
    '</project>',
    '',
  ].join('\n'), 'utf8');
  await writeFile(join(ROOT, 'mvnw.cmd'), '@echo off\r\n', 'utf8');
  await writeFile(join(ROOT, 'fakejdk', 'bin', 'java.exe'), '', 'utf8');
  await writeFile(join(ROOT, 'pos', 'pos-server', 'src', 'main', 'java', 'DemoApplication.java'), 'class DemoApplication {}\n', 'utf8');
  await writeFile(join(ROOT, 'pos', 'pos-server', 'src', 'main', 'resources', 'application-dev.yaml'), 'server:\n  port: 8081\nspring:\n  data:\n    redis:\n      port: 6379\n', 'utf8');
  await writeFile(join(ROOT, 'web', 'package.json'), JSON.stringify({
    name: 'web-app',
    description: '前端',
    scripts: { dev: 'vite --mode local', 'build:prod': 'vite build' },
  }), 'utf8');
  await writeFile(join(ROOT, 'node_modules', 'skipme', 'package.json'), JSON.stringify({ scripts: { dev: 'echo no' } }), 'utf8');
}

test('pomModules / portFromYaml / toId 这些纯函数', () => {
  assert.deepEqual(pomModules('<modules><module>pos</module>\n    <module>core</module></modules>'), ['pos', 'core']);
  assert.equal(portFromYaml('server:\n  port: 8081\nspring:\n  data:\n    redis:\n      port: 6379\n'), 8081);
  assert.equal(portFromYaml('spring:\n  data:\n    redis:\n      port: 6379\n'), undefined);
  assert.equal(toId('C:\\ws', 'C:\\ws\\pos\\pos-server'), 'pos/pos-server');
  assert.equal(toId('C:\\ws', 'C:\\ws'), '.');
});

test('scan 认出 Maven 模块与前端项目（字段与旧版一致）', async () => {
  await writeFixture();
  const scanner = createScanner(fakeCtx(ROOT));
  const result = await scanner.scan(ROOT);
  assert.equal(result.root, ROOT);
  assert.equal(typeof result.at, 'number');
  assert.deepEqual(result.projects.map((project) => project.id), ['pos/pos-server', 'web']);

  const java = result.projects[0];
  assert.equal(java.kind, 'java');
  assert.equal(java.name, 'pos-server');
  assert.equal(java.modulePath, 'pos/pos-server');
  assert.equal(java.dir, join(ROOT, 'pos', 'pos-server'));
  assert.equal(java.port, 8081);
  assert.equal(java.note, undefined);
  assert.equal(java.command, 'mvn -pl pos/pos-server -am install -DskipTests → mvn -pl pos/pos-server spring-boot:run');

  const node = result.projects[1];
  assert.equal(node.kind, 'node');
  assert.equal(node.name, 'web');
  assert.equal(node.devScript, 'vite --mode local');
  assert.equal(node.buildScript, 'build:prod');
  assert.equal(node.buildScriptText, 'vite build');
  assert.equal(node.command, 'pnpm run dev');
  assert.equal(node.buildCommand, 'pnpm run build:prod');
  assert.equal(node.description, '前端');
});

test('scan 有缓存：命中返回同一个对象，并发只扫一次，force 才重扫', async () => {
  const scanner = createScanner(fakeCtx(ROOT));
  const [first, second] = await Promise.all([scanner.scan(ROOT), scanner.scan(ROOT)]);
  assert.equal(first, second, '并发扫描应等同一个在跑的任务');
  const cached = await scanner.scan(ROOT);
  assert.equal(cached, first, '5 分钟内应命中缓存');
  assert.equal(scanner.scanCache.get(ROOT), first);
  const forced = await scanner.scan(ROOT, true);
  assert.notEqual(forced, first, 'force 应重新扫描');
});

test('工作区白名单：账目里的路径认，账目外的回落；extraRoots 是逃生口', async () => {
  const scanner = createScanner(fakeCtx(ROOT));
  assert.equal(await scanner.effectiveRoot(ROOT), ROOT);
  assert.equal(await scanner.effectiveRoot('C:\\Windows'), scanner.workspaceRoot());
  assert.equal(await scanner.effectiveRoot('relative/path'), scanner.workspaceRoot());
  assert.equal(await scanner.effectiveRoot(undefined), scanner.workspaceRoot());

  const outside = join(ROOT, '..', '.tmp-scan-outside');
  await mkdir(join(ROOT, '.dsh-devship'), { recursive: true });
  await writeFile(join(ROOT, '.dsh-devship', 'prefs.json'), JSON.stringify({ extraRoots: [outside] }), 'utf8');
  const fresh = createScanner(fakeCtx(ROOT));
  assert.equal(await fresh.effectiveRoot(outside), outside);
  fresh.invalidateExtraRoots();
  assert.equal(await fresh.effectiveRoot(outside), outside, 'invalidate 后应重新读到 extraRoots');
});

test('mvn / JDK 优先用 .dsh-devship.json 里写死的路径（不靠真机 PATH）', async () => {
  await writeFile(join(ROOT, '.dsh-devship.json'), JSON.stringify({ maven: join(ROOT, 'mvnw.cmd'), javaHome: join(ROOT, 'fakejdk') }), 'utf8');
  const scanner = createScanner(fakeCtx(ROOT, {
    resolveExecutable: async () => { throw new Error('PATH 里没有'); },
  }));
  assert.equal(await scanner.resolveExecutable('mvn', ROOT), join(ROOT, 'mvnw.cmd'));
  const jdk = await scanner.resolveJavaHome(ROOT);
  assert.equal(jdk.major, 17);
  assert.equal(jdk.javaHome, join(ROOT, 'fakejdk'));
  assert.deepEqual(await scanner.javaEnv(ROOT), { JAVA_HOME: join(ROOT, 'fakejdk') });
  assert.equal(await scanner.resolveJavaHome(ROOT), jdk, '同一 root 的 JDK 探测应只跑一次');
});

after(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await rm(join(ROOT, '..', '.tmp-scan-outside'), { recursive: true, force: true });
});
