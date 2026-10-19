/**
 * dsh-devship — 工作区「快捷启动」插件（Host 半）。
 *
 * 能力：
 *   - 扫描工作区里可启动的项目：Maven 里带 *Application 启动类的模块（Java）与
 *     带 dev 脚本的 package.json 项目（前端 / Node），与 IDEA 的启动配置对应；
 *   - 通过 ctx.subprocess 启动 / 停止开发进程，异步执行 Maven 打包并回收日志尾部；
 *   - 以同源 HTTP 路由（ctx.webServer，/dsh-devship/*）暴露给 Client 半（client.js），
 *     浏览器 fetch 直接调用，无需 Remote 通道。
 *
 * 依赖服务（inject）：webServer、subprocess、sandboxPolicy。
 * 工作区根目录：Client 半随请求带上（工作区账目的 path，最准确）；
 * 缺失时 Host 依次尝试 workspaceRegistry / 会话 cwd / sandboxPolicy / 进程 cwd。
 *
 * 部署：读 <工作区>/.dsh-devship/deploy.json 的服务器别名与各包远端目录，
 * 复用 dsh-ssh 里已配置的主机（~/.dsh/dsh-ssh.json）和 ssh2 走 SFTP 上传。
 */
import { createRequire } from 'node:module';
import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import { appendFile, chmod, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { isAbsolute, join } from 'node:path';

const PREFIX = '/dsh-devship';
/** 单个进程 / 打包任务保留的日志尾部字符数。 */
const MAX_TAIL = 100000;
/** 扫描工作区时跳过的目录（依赖、构建产物、文档与插件目录）。 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'target', 'dist', 'build', 'out',
  '.idea', '.image', '.zcode', '.gradle', '.mvn', 'doc', 'docs', 'sql', 'script',
  '.dsh-plugins', '.vscode', 'logs', 'tmp', 'coverage',
]);
/** 扫描结果缓存时长，避免每次轮询都读盘。 */
const SCAN_TTL_MS = 4000;
/** spawn 的 SIGTERM 宽限期。 */
const GRACE_MS = 3000;

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value !== null && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

async function readText(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function listDirectories(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** 在 Maven 根 pom 的 <modules> 里找模块名（保持声明顺序）。 */
function pomModules(source) {
  const names = [];
  const pattern = /<module>\s*([^<]+?)\s*<\/module>/gu;
  let match = pattern.exec(source);
  while (match !== null) {
    names.push(match[1]);
    match = pattern.exec(source);
  }
  return names;
}

/** 递归判断某个 java 源码目录里是否存在 *Application.java 启动类。 */
async function hasApplicationClass(javaDir) {
  const queue = [{ dir: javaDir, depth: 0 }];
  let visited = 0;
  while (queue.length > 0) {
    if (visited > 4000) return false;
    const { dir, depth } = queue.shift();
    visited += 1;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('Application.java')) return true;
      if (entry.isDirectory() && depth < 12) queue.push({ dir: join(dir, entry.name), depth: depth + 1 });
    }
  }
  return false;
}

/** 从 YAML 文本里取「顶层 server: 块」下的 port（跳过 redis/其它中间件的 port）。 */
function portFromYaml(text) {
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^server:\s*$/u.test(lines[index])) continue;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (/^\S/u.test(line) && !/^server:/u.test(line)) break;
      const match = /^\s+port:\s*['"]?(\d{2,5})['"]?/u.exec(line);
      if (match !== null) {
        const port = Number(match[1]);
        if (Number.isInteger(port) && port > 0 && port < 65536) return port;
      }
    }
  }
  return undefined;
}

/** 从 application-*.yaml / application.yaml / application.properties 里猜端口。 */
async function detectPort(projectDir) {
  const resources = join(projectDir, 'src', 'main', 'resources');
  for (const name of ['application-dev.yaml', 'application-dev.yml', 'application.yaml', 'application.yml']) {
    const text = await readText(join(resources, name));
    if (text === undefined) continue;
    const port = portFromYaml(text);
    if (port !== undefined) return port;
  }
  for (const name of ['application-dev.properties', 'application.properties']) {
    const text = await readText(join(resources, name));
    if (text === undefined) continue;
    const match = /^server\.port\s*=\s*(\d{2,5})/mu.exec(text);
    if (match !== null) {
      const port = Number(match[1]);
      if (Number.isInteger(port) && port > 0 && port < 65536) return port;
    }
  }
  return undefined;
}

/** 把相对路径规范成 / 分隔的项目 id。 */
function toId(root, dir) {
  const rel = dir.slice(root.length).replace(/^[\\/]+/u, '').replace(/\\/gu, '/');
  return rel === '' ? '.' : rel;
}

/** 运行状态持久化：<工作区>/.dsh-devship/state.json（DSH 重启后据此接管）。 */
async function readRunState(root) {
  const text = await readText(join(root, '.dsh-devship', 'state.json'));
  if (text === undefined) return {};
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

async function writeRunState(root, state) {
  const dir = join(root, '.dsh-devship');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** 按端口找监听进程的 pid（Windows: netstat -ano / POSIX: lsof）。 */
function pidByPort(port) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, timeout: 15000 }, (error, stdout) => {
        if (error !== undefined && error !== null) {
          resolve(undefined);
          return;
        }
        const pattern = new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'u');
        for (const line of String(stdout).split(/\r?\n/u)) {
          const matched = pattern.exec(line);
          if (matched !== null) {
            resolve(Number(matched[1]));
            return;
          }
        }
        resolve(undefined);
      });
      return;
    }
    execFile('lsof', ['-ti', `:${port}`], { timeout: 15000 }, (error, stdout) => {
      const pid = Number(String(stdout ?? '').trim().split(/\s+/u)[0]);
      resolve(Number.isInteger(pid) && pid > 0 ? pid : undefined);
    });
  });
}

/** 结束整棵进程树。 */
function killTree(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 20000 }, () => resolve());
      return;
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已退出 */
    }
    resolve();
  });
}

/** 按 Windows 命令行规则粗略拆分（够用于我们生成的 "exe arg arg" 形式）。 */
function splitCommandLine(line) {
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

/** 判断一个 pid 是否还活着。 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    return out.includes(String(pid));
  } catch {
    return false;
  }
}

/** 从 pid 文件读 pid 并判断进程是否还活着。 */
async function pidAliveFromFile(pidFile) {
  if (typeof pidFile !== 'string' || pidFile === '') return undefined;
  const text = await readText(pidFile);
  if (text === undefined) return undefined;
  const pid = Number(text.trim());
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      return undefined;
    }
  }
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    return out.includes(String(pid)) ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** 把一条已存在日志文件的尾部读进内存（不截断文件）。 */
function seedTailFromLog(entry) {
  if (typeof entry.logFile !== 'string' || entry.logFile === '' || !existsSync(entry.logFile)) return;
  try {
    const info = statSync(entry.logFile);
    const from = Math.max(0, info.size - 30000);
    const length = info.size - from;
    const buffer = Buffer.alloc(length);
    const fd = openSync(entry.logFile, 'r');
    try {
      readSync(fd, buffer, 0, length, from);
    } finally {
      closeSync(fd);
    }
    entry.tail = buffer.toString('utf8');
    entry.logOffset = info.size;
  } catch {
    /* 忽略 */
  }
}

/** 日志落盘目录：<工作区>/.dsh-devship/logs。 */
function logDir(root) {
  return join(root, '.dsh-devship', 'logs');
}

function logFileFor(root, id) {
  return join(logDir(root), `${slug(id)}.log`);
}

const logDirReady = new Set();

/** 清掉老日志：超过 60 个文件或超过 7 天的删掉（只保留最近的）。 */
async function pruneLogs(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.log')) continue;
      const info = await stat(join(dir, entry.name));
      files.push({ path: join(dir, entry.name), time: info.mtimeMs });
    }
    files.sort((left, right) => right.time - left.time);
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    for (const [index, file] of files.entries()) {
      if (index < 60 && file.time > cutoff) continue;
      await unlink(file.path).catch(() => {});
    }
  } catch {
    /* 目录不存在 */
  }
}

/** 追加日志：内存尾部（限长）+ 落盘（全量）。 */
function appendLog(entry, text) {
  if (typeof text !== 'string' || text === '') return;
  entry.tail += text;
  if (entry.tail.length > MAX_TAIL) entry.tail = entry.tail.slice(-MAX_TAIL);
  if (typeof entry.logFile === 'string' && entry.logFile !== '') {
    try {
      appendFileSync(entry.logFile, text, 'utf8');
    } catch {
      /* 落盘失败不影响面板 */
    }
  }
}

/** 清空某任务的日志（切阶段时用）。 */
function resetLog(entry) {
  entry.tail = '';
  if (typeof entry.logFile === 'string' && entry.logFile !== '') {
    try {
      writeFileSync(entry.logFile, '', 'utf8');
    } catch {
      /* 忽略 */
    }
  }
}

/** 给任务条目挂上日志文件（首次调用时建目录 + 清理旧文件）。 */
async function attachLogFile(entry, root, name) {
  const dir = logDir(root);
  if (!logDirReady.has(dir)) {
    await mkdir(dir, { recursive: true }).catch(() => {});
    logDirReady.add(dir);
    void pruneLogs(dir);
  }
  entry.logFile = logFileFor(root, name);
  try {
    writeFileSync(entry.logFile, '', 'utf8');
  } catch {
    /* 忽略 */
  }
  return entry;
}

/**
 * 追加日志尾部：
 *  - Windows 上启动脚本把 stdout/stderr 重定向到文件（wscript 不继承管道），从文件按偏移读；
 *  - 其它情况读子进程的 collected stdout/stderr。
 */
function tailOf(entry) {
  if (typeof entry.logPath === 'string' && entry.logPath !== '') {
    try {
      const info = statSync(entry.logPath);
      const from = entry.logOffset ?? 0;
      if (info.size > from) {
        const length = Math.min(info.size - from, 64 * 1024);
        const buffer = Buffer.alloc(length);
        const fd = openSync(entry.logPath, 'r');
        try {
          readSync(fd, buffer, 0, length, from);
        } finally {
          closeSync(fd);
        }
        entry.logOffset = from + length;
        appendLog(entry, buffer.toString('utf8'));
      }
    } catch {
      /* 文件还没创建 */
    }
    return entry.tail;
  }
  if (entry.handle === undefined) return entry.tail;
  let collected = {};
  try {
    collected = entry.handle.collected ?? {};
  } catch {
    collected = {};
  }
  const stdout = collected.stdout;
  if (stdout !== undefined) {
    const chunk = stdout.readFrom(entry.stdoutOffset ?? 0);
    entry.stdoutOffset = chunk.nextOffset;
    if (chunk.text) appendLog(entry, chunk.text);
  }
  const stderr = collected.stderr;
  if (stderr !== undefined) {
    const chunk = stderr.readFrom(entry.stderrOffset ?? 0);
    entry.stderrOffset = chunk.nextOffset;
    if (chunk.text) appendLog(entry, chunk.text);
  }
  return entry.tail;
}

function publicEntry(entry) {
  return {
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    ...entry.tool === undefined ? {} : { tool: entry.tool },
    state: entry.state,
    ...entry.phase === undefined ? {} : { phase: entry.phase },
    startedAt: entry.startedAt,
    ...entry.exitCode === undefined ? {} : { exitCode: entry.exitCode },
    ...entry.error === undefined ? {} : { error: entry.error },
    ...entry.containerStatus === undefined ? {} : { containerStatus: entry.containerStatus },
    ...entry.adopted === true ? { adopted: true, port: entry.port } : {},
    ...Number.isInteger(entry.pid) ? { pid: entry.pid } : {},
    ...entry.detached === true ? { detached: true } : {},
    tail: tailOf(entry),
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/** 工作区级偏好（隐藏的服务列表），存在 <工作区>/.dsh-devship/prefs.json。 */
async function readPrefs(root) {
  const text = await readText(join(root, '.dsh-devship', 'prefs.json'));
  if (text === undefined) return { hidden: [] };
  try {
    const value = JSON.parse(text);
    const hidden = Array.isArray(value?.hidden)
      ? value.hidden.filter((item) => typeof item === 'string')
      : [];
    return { hidden };
  } catch {
    return { hidden: [] };
  }
}

async function writePrefs(root, prefs) {
  const dir = join(root, '.dsh-devship');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'prefs.json'), `${JSON.stringify(prefs, null, 2)}\n`, 'utf8');
}

/** 部署配置：<工作区>/.dsh-devship/deploy.json（服务器别名 + 每个包的远端目录）。 */
async function readDeployConfig(root) {
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

async function writeDeployConfig(root, config) {
  const dir = join(root, '.dsh-devship');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'deploy.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

/** 读 dsh-ssh 的主机表（~/.dsh/dsh-ssh.json），部署时按 alias 取连接参数。 */
async function readSshHosts() {
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

/** 从 profile 的 node_modules 里加载 dsh-ssh 依赖的 ssh2（插件自身不打包它）。 */
function loadSsh2() {
  const candidates = [];
  if (typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR !== '') candidates.push(process.env.DSH_PROFILE_DIR);
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');
  candidates.push(join(home, 'profiles', process.env.DSH_PROFILE ?? 'desktop'));
  let lastError;
  for (const dir of candidates) {
    try {
      const require = createRequire(join(dir, 'package.json'));
      return require('ssh2');
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`无法加载 ssh2（部署依赖 dsh-ssh 插件）：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/** 部署产物：显式配置优先；前端默认 dist-prod/dist；Java 默认 target/<artifactId>.jar。 */
async function resolveArtifact(root, project, target) {
  if (typeof target?.artifact === 'string' && target.artifact !== '') return join(root, target.artifact);
  if (project.kind === 'node') {
    for (const name of ['dist-prod', 'dist']) {
      const dir = join(project.dir, name);
      if (await isDirectory(dir)) return dir;
    }
    return join(project.dir, 'dist-prod');
  }
  const pom = await readText(join(project.dir, 'pom.xml'));
  // 去掉 <parent> 块，否则第一个 <artifactId> 是父模块的
  const body = pom === undefined ? '' : pom.replace(/<parent>[\s\S]*?<\/parent>/u, '');
  const literalFinalName = /<finalName>\s*([^<${}]+?)\s*<\/finalName>/u.exec(body)?.[1];
  const artifactId = /<artifactId>\s*([^<${}]+?)\s*<\/artifactId>/u.exec(body)?.[1];
  const targetDir = join(project.dir, 'target');
  const named = (literalFinalName ?? artifactId ?? project.name).trim();
  const candidate = join(targetDir, `${named}.jar`);
  if (await isFile(candidate)) return candidate;
  // 兜底：target 下挑一个最大的 jar（排除 sources/javadoc/original）
  try {
    const entries = await readdir(targetDir, { withFileTypes: true });
    const jars = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jar')) continue;
      if (/(?:-sources|-javadoc|-original|-plain)\.jar$/u.test(entry.name)) continue;
      const info = await stat(join(targetDir, entry.name));
      jars.push({ path: join(targetDir, entry.name), size: info.size });
    }
    jars.sort((left, right) => right.size - left.size);
    if (jars.length > 0) return jars[0].path;
  } catch {
    /* target 不存在 */
  }
  return candidate;
}

/** posix 风格拼接远端路径。 */
function remoteJoin(base, name) {
  const trimmed = String(base).replace(/\/+$/u, '');
  return name === undefined ? trimmed : `${trimmed}/${name}`;
}

/** 递归列出一个目录下的文件（相对路径 + 绝对路径 + 大小）。 */
async function listFilesDeep(dir, base = dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) await listFilesDeep(abs, base, out);
    else if (entry.isFile()) {
      const info = await stat(abs);
      out.push({ abs, rel: abs.slice(base.length + 1).replace(/\\/gu, '/'), size: info.size });
    }
  }
  return out;
}

function sftpPut(sftp, local, remote) {
  return new Promise((resolve, reject) => {
    sftp.fastPut(local, remote, (error) => (error === undefined || error === null ? resolve() : reject(error)));
  });
}

function sshExec(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error !== undefined && error !== null) {
        reject(error);
        return;
      }
      let stderr = '';
      stream.on('data', () => {});
      stream.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      stream.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`远端命令失败(${String(code)}): ${stderr.trim() || command}`));
      });
      stream.on('error', reject);
    });
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/gu, `'\\''`)}'`;
}

/**
 * 真正执行一次部署：连 SSH → 建目录 → SFTP 上传（文件或整个目录）→ 重启容器 → 校验。
 * @param {object} [session] 可复用的 SSH 会话（批量部署时共用一条连接）
 * @returns {Promise<{files: number, bytes: number, remote: string, container?: string, containerStatus?: string}>}
 */
/** 建一条 SSH 会话（client + sftp），批量部署时复用。 */
async function openSshSession(config, log) {
  const hosts = await readSshHosts();
  const byAlias = typeof config.alias === 'string' && config.alias !== ''
    ? hosts.find((host) => host.alias === config.alias)
    : undefined;
  const directHost = typeof config.host === 'string' && config.host !== '';
  if (!directHost && byAlias === undefined) {
    throw new Error('部署配置缺少服务器地址：填写 host/port/user/password，或填 dsh-ssh 里的 alias');
  }
  const auth = byAlias?.auth ?? {};
  const password = typeof config.password === 'string' && config.password !== ''
    ? config.password
    : auth.kind === 'password' ? auth.password : undefined;
  const connection = {
    // 显式地址优先（测试服务器通常直接填 IP），alias 只作兜底
    host: directHost ? config.host : byAlias?.host,
    port: Number.isInteger(config.port) ? config.port : byAlias?.port ?? 22,
    user: typeof config.user === 'string' && config.user !== '' ? config.user : byAlias?.user,
    readyTimeout: 20000,
    ...password === undefined ? {} : { password },
  };
  if (typeof connection.user !== 'string' || connection.user === '') throw new Error('部署配置缺少 user');
  if (typeof connection.host !== 'string' || connection.host === '') throw new Error('部署配置缺少 host');
  const ssh2 = loadSsh2();
  log?.(`连接 ${connection.user}@${connection.host}:${connection.port} …`);
  const client = new ssh2.Client();
  await new Promise((resolve, reject) => {
    client.once('ready', resolve);
    client.once('error', reject);
    client.connect(connection);
  });
  log?.('SSH 已连接');
  const sftp = await new Promise((resolve, reject) => {
    client.sftp((error, value) => (error === undefined || error === null ? resolve(value) : reject(error)));
  });
  return { client, sftp };
}

async function uploadArtifact({ project, target, config, artifact, log, session }) {
  const reusable = session !== undefined && session !== null;
  let client = reusable ? session.client : undefined;
  let sftp = reusable ? session.sftp : undefined;
  if (!reusable) {
    const opened = await openSshSession(config, log);
    client = opened.client;
    sftp = opened.sftp;
  }
  try {
    const info = await stat(artifact);
    let remote;
    let files;
    let bytes = 0;
    if (info.isDirectory()) {
      remote = remoteJoin(target.remoteDir);
      await sshExec(client, `mkdir -p ${shellQuote(remote)}`);
      const list = await listFilesDeep(artifact);
      files = list.length;
      bytes = list.reduce((sum, file) => sum + file.size, 0);
      log(`目录 ${project.name}：${files} 个文件，共 ${(bytes / 1024 / 1024).toFixed(2)} MB`);

      // 首选：本地打 tar（不压缩，局域网带宽足，比 gzip 快）→ 单文件上传 → 远端解包
      let packed = false;
      const archive = join(artifact, '..', `.dsh-devship-${Date.now()}.tar`);
      try {
        log('本地打包 tar …');
        await tarDirectory(artifact, archive);
        const size = (await stat(archive)).size;
        const remoteArchive = `/tmp/dsh-devship-${Date.now()}.tar`;
        log(`上传 ${(size / 1024 / 1024).toFixed(2)} MB 包 → ${remoteArchive}`);
        await sftpPut(sftp, archive, remoteArchive);
        log(`远端解包到 ${remote} …`);
        await sshExec(client, `tar -xf ${shellQuote(remoteArchive)} -C ${shellQuote(remote)} && rm -f ${shellQuote(remoteArchive)}`);
        log('解包完成');
        packed = true;
      } catch (error) {
        log(`tar 方式失败（${error instanceof Error ? error.message : String(error)}），改为并发逐文件上传`);
      } finally {
        await unlink(archive).catch(() => {});
      }

      if (!packed) {
        // 兜底：并发 SFTP（8 路），不逐个打日志
        const CONCURRENCY = 8;
        const dirs = new Set([remote]);
        let next = 0;
        let done = 0;
        const worker = async () => {
          while (next < list.length) {
            const file = list[next];
            next += 1;
            const remoteFile = remoteJoin(remote, file.rel);
            const dir = remoteFile.slice(0, remoteFile.lastIndexOf('/'));
            if (!dirs.has(dir)) {
              dirs.add(dir);
              await sshExec(client, `mkdir -p ${shellQuote(dir)}`);
            }
            await sftpPut(sftp, file.abs, remoteFile);
            done += 1;
            if (done % 20 === 0 || done === list.length) log(`  已上传 ${done}/${list.length}`);
          }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, () => worker()));
      }
    } else {
      remote = remoteJoin(target.remoteDir, artifact.split(/[\\/]/u).pop());
      await sshExec(client, `mkdir -p ${shellQuote(remoteJoin(target.remoteDir))}`);
      // fat-jar 预检：没有 BOOT-INF/ 的 jar 装到容器里起不来，提前提示
      if (await looksLikePlainJar(artifact)) {
        log('⚠ 该 jar 没找到 BOOT-INF/（不是 Spring Boot 可执行包），容器可能起不来');
      }
      // 备份上一版，出问题可秒回滚
      await sshExec(client, `if [ -f ${shellQuote(remote)} ]; then cp -f ${shellQuote(remote)} ${shellQuote(`${remote}.bak`)}; fi`);
      log(`上传文件 ${project.name} → ${remote} (${(info.size / 1024 / 1024).toFixed(1)} MB)`);
      await sftpPut(sftp, artifact, remote);
      files = 1;
      bytes = info.size;
    }
    log(`部署完成：${files} 个文件，${(bytes / 1024 / 1024).toFixed(2)} MB`);

    // 部署完重启容器（配置了 container 才做），然后校验容器状态
    const container = typeof target.container === 'string' ? target.container.trim() : '';
    let containerStatus;
    if (container !== '') {
      const template = typeof config.restartCommand === 'string' && config.restartCommand.trim() !== ''
        ? config.restartCommand.trim()
        : 'docker restart {container}';
      const command = template.includes('{container}')
        ? template.replace(/\{container\}/gu, container)
        : `${template} ${container}`;
      log(`重启容器 ${container}：${command}`);
      await sshExec(client, command);
      log(`容器 ${container} 已重启，校验状态 …`);
      containerStatus = (await sshExecCapture(client, `docker ps --filter name=^/${container}$ --format '{{.Status}}'`)).trim();
      if (containerStatus === '') {
        const logs = (await sshExecCapture(client, `docker logs --tail 20 ${shellQuote(container)} 2>&1 | tail -20`)).trim();
        throw new Error(`容器 ${container} 重启后不在运行列表里。最近日志：\n${logs}`);
      }
      log(`容器状态：${containerStatus}`);
    }
    return { files, bytes, remote, container: container === '' ? undefined : container, containerStatus };
  } finally {
    if (!reusable) client.end();
  }
}

/** 用一条 SSH 连接跑命令并拿回 stdout。 */
function sshExecCapture(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error !== undefined && error !== null) {
        reject(error);
        return;
      }
      let out = '';
      stream.on('data', (chunk) => {
        out += String(chunk);
      });
      stream.stderr.on('data', () => {});
      stream.on('close', () => resolve(out));
      stream.on('error', reject);
    });
  });
}

/** 判断 jar 是不是普通 jar（不是 Spring Boot fat jar）：读尾部找 BOOT-INF/。 */
async function looksLikePlainJar(path) {
  try {
    const info = await stat(path);
    const length = Math.min(info.size, 256 * 1024);
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, 'r');
    try {
      readSync(fd, buffer, 0, length, Math.max(0, info.size - length));
    } finally {
      closeSync(fd);
    }
    return !buffer.includes('BOOT-INF/');
  } catch {
    return false;
  }
}

/** 本地目录打成 tar（不压缩；Windows 自带 bsdtar）。 */
function tarDirectory(dir, archive) {
  return new Promise((resolve, reject) => {
    execFile('tar', ['-cf', archive, '-C', dir, '.'], { windowsHide: true, timeout: 180000 }, (error) => {
      if (error === undefined || error === null) resolve();
      else reject(error);
    });
  });
}

function slug(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'task';
}

/**
 * 把「可执行文件 + 参数」写成一个独立启动脚本再 spawn。
 *
 * Windows 上 mvn / pnpm 都是 .cmd 批处理，Node 无法直接 exec（EINVAL），
 * 而 cmd.exe /c 的命令行内嵌引号会被 Node 转义成 \" 导致找不到命令；
 * 因此生成 .cmd 脚本，由隐藏窗口的 powershell 执行：
 *
 *   powershell -NoProfile -WindowStyle Hidden -Command "& { & '<cmd>' ; exit $LASTEXITCODE }"
 *
 * 这样控制台窗口是隐藏的（不会弹黑框、也不会被误关掉进程），
 * stdout/stderr 仍然走 subprocess 的管道（日志正常），退出码也照常回传。
 * 不要用 wscript：它在管道 stdio 下会卡住。
 */
async function writeLauncher(dir, name, executable, args) {
  await mkdir(dir, { recursive: true });
  if (process.platform === 'win32') {
    const base = slug(name);
    const cmdFile = join(dir, `${base}.cmd`);
    const pidFile = join(dir, `${base}.pid`);
    const quote = (value) => `"${String(value).replace(/"/gu, '""')}"`;
    await writeFile(cmdFile, [
      '@echo off',
      `call ${quote(executable)} ${args.map(quote).join(' ')}`,
      '',
    ].join('\r\n'), 'utf8');
    return { argv: hiddenPowershellArgv(cmdFile, pidFile), pidFile };
  }
  const file = join(dir, `${slug(name)}.sh`);
  const quote = (value) => `'${String(value).replace(/'/gu, `'\\''`)}'`;
  await writeFile(file, `#!/bin/sh\necho $$ > "${file}.pid"\nexec ${quote(executable)} ${args.map(quote).join(' ')}\n`, 'utf8');
  await chmod(file, 0o755);
  return { argv: [file], pidFile: `${file}.pid` };
}

/**
 * 用隐藏窗口的 powershell 执行一个 .cmd，返回 argv。
 * 顺便把 powershell 自己的 PID 写进 pid 文件 —— DSH 重启后靠它判断服务是否还活着
 * （没有端口可探测的项目，比如没配 server.port 的服务，只能靠 pid）。
 */
function hiddenPowershellArgv(cmdFile, pidFile) {
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const pre = typeof pidFile === 'string' && pidFile !== ''
    ? `$PID | Set-Content -LiteralPath '${pidFile.replace(/'/gu, "''")}' -NoNewline -Encoding ASCII; `
    : '';
  const command = `& { ${pre}& '${cmdFile.replace(/'/gu, "''")}' ; exit $LASTEXITCODE }`;
  return [powershell, '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', command];
}

/** 直接写一条命令行到 .cmd（不经 pnpm，避免 pnpm 再开一个可见的 cmd 窗口）。 */
async function writeRawLauncher(dir, name, commandLine) {
  await mkdir(dir, { recursive: true });
  const base = slug(name);
  const cmdFile = join(dir, `${base}.cmd`);
  const pidFile = join(dir, `${base}.pid`);
  await writeFile(cmdFile, ['@echo off', commandLine, ''].join('\r\n'), 'utf8');
  return { argv: hiddenPowershellArgv(cmdFile, pidFile), pidFile };
}

/**
 * 前端脚本直接执行（绕开 pnpm —— pnpm 会用 `cmd /d /s /c` 再开一个**可见**的 cmd 窗口）：
 *   - `vite --mode xxx` → node <项目>/node_modules/vite/bin/vite.js --mode xxx
 *   - `node ...`        → 原样作为命令行执行
 * 其它情况返回 undefined，退回 pnpm。
 */
async function nodeScriptSpec(project, script, nodePath) {
  if (typeof script !== 'string' || script.trim() === '') return undefined;
  const line = script.trim();
  const viteBin = join(project.dir, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!(await isFile(viteBin))) return undefined;
  const quote = (value) => `"${String(value).replace(/"/gu, '""')}"`;
  if (/^vite(?:\s|$)/u.test(line)) {
    const rest = line.slice(4).trim();
    return { commandLine: `${quote(nodePath)} ${quote(viteBin)}${rest === '' ? '' : ` ${rest}`}` };
  }
  if (/^node(?:\s|$)/u.test(line)) {
    // 脚本本身就是 node 命令：把 node 换成解析到的绝对路径
    return { commandLine: `${quote(nodePath)}${line.slice(4)}` };
  }
  return undefined;
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** 在若干「一级目录」里按名字找子目录（用于发现 apache-maven-* 之类安装目录）。 */
async function listDirectoriesNamed(base, pattern) {
  const matches = [];
  try {
    const entries = await readdir(base, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && pattern.test(entry.name)) matches.push(join(base, entry.name));
    }
  } catch {
    /* 目录不存在或不可读 */
  }
  return matches;
}

const WIN_ROOT_HINTS = [
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\',
  'D:\\',
  'D:\\Program Files',
  'D:\\ProgramFiles',
  'E:\\',
  'E:\\Program Files',
  'E:\\ProgramFiles',
];

/**
 * 找 Maven：PATH → 工作区 wrapper → MAVEN_HOME/M2_HOME → 常见安装目录 → IDEA 自带 Maven。
 * 找不到就抛错（附上尝试过的位置，便于用户配置 .dsh-devship.json）。
 */
async function findMaven(root, override) {
  const tried = [];
  const accept = async (candidate) => {
    if (typeof candidate !== 'string' || candidate === '') return undefined;
    tried.push(candidate);
    return (await isFile(candidate)) ? candidate : undefined;
  };
  if (typeof override === 'string' && override !== '') {
    const hit = await accept(override);
    if (hit !== undefined) return hit;
  }
  if (root !== undefined) {
    for (const name of process.platform === 'win32' ? ['mvnw.cmd', 'mvnw'] : ['mvnw']) {
      const hit = await accept(join(root, name));
      if (hit !== undefined) return hit;
    }
  }
  for (const home of [process.env.MAVEN_HOME, process.env.M2_HOME]) {
    if (typeof home !== 'string' || home === '') continue;
    for (const name of ['mvn.cmd', 'mvn.bat', 'mvn']) {
      const hit = await accept(join(home, 'bin', name));
      if (hit !== undefined) return hit;
    }
  }
  if (process.platform === 'win32') {
    for (const base of WIN_ROOT_HINTS) {
      for (const dir of await listDirectoriesNamed(base, /maven/iu)) {
        for (const name of ['mvn.cmd', 'mvn.bat', 'mvn']) {
          const hit = await accept(join(dir, 'bin', name));
          if (hit !== undefined) return hit;
        }
      }
    }
    const ideas = [
      ...await listDirectoriesNamed(join(process.env.LOCALAPPDATA ?? '', 'Programs'), /IntelliJ|JetBrains/iu),
      ...await listDirectoriesNamed(join(process.env.ProgramFiles ?? 'C:\\Program Files', 'JetBrains'), /^IntelliJ IDEA/iu),
    ];
    for (const idea of ideas) {
      for (const name of ['mvn.cmd', 'mvn.bat']) {
        const hit = await accept(join(idea, 'plugins', 'maven', 'lib', 'maven3', 'bin', name));
        if (hit !== undefined) return hit;
      }
    }
    const choco = join(process.env.ProgramData ?? 'C:\\ProgramData', 'chocolatey', 'bin');
    for (const name of ['mvn.cmd', 'mvn.exe']) {
      const hit = await accept(join(choco, name));
      if (hit !== undefined) return hit;
    }
  }
  const error = new Error(`未找到 Maven：请把 mvn 加入 PATH，或设置 MAVEN_HOME，或在 .dsh-devship.json 里写 maven 路径。已尝试：${tried.slice(0, 6).join(' | ')}`);
  error.tried = tried;
  throw error;
}

/** 找 pnpm：PATH → 工作区 wrapper → PNPM_HOME / npm 全局目录。 */
async function findPnpm(root, override) {
  const tried = [];
  const accept = async (candidate) => {
    if (typeof candidate !== 'string' || candidate === '') return undefined;
    tried.push(candidate);
    return (await isFile(candidate)) ? candidate : undefined;
  };
  if (typeof override === 'string' && override !== '') {
    const hit = await accept(override);
    if (hit !== undefined) return hit;
  }
  if (root !== undefined) {
    for (const name of process.platform === 'win32' ? ['pnpm.cmd'] : ['pnpm']) {
      const hit = await accept(join(root, name));
      if (hit !== undefined) return hit;
    }
  }
  const homes = [
    process.env.PNPM_HOME,
    join(process.env.LOCALAPPDATA ?? '', 'pnpm'),
    join(process.env.APPDATA ?? '', 'npm'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs'),
  ];
  for (const home of homes) {
    if (typeof home !== 'string' || home === '') continue;
    for (const name of process.platform === 'win32' ? ['pnpm.exe', 'pnpm.cmd', 'pnpm.bat'] : ['pnpm']) {
      const hit = await accept(join(home, name));
      if (hit !== undefined) return hit;
    }
  }
  const error = new Error(`未找到 pnpm：请把 pnpm 加入 PATH，或在 .dsh-devship.json 里写 pnpm 路径。已尝试：${tried.slice(0, 6).join(' | ')}`);
  error.tried = tried;
  throw error;
}

/** 探测本机端口是否已被占用（启动前提示「服务可能已在运行」；状态里标记外部实例）。 */
function portBusy(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      resolve(false);
      return;
    }
    const socket = connect({ port, host: '127.0.0.1' });
    const settle = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

/** 从 JDK 目录名解析主版本号（jdk-25.0.4 / ms-25.0.4 / jdk1.8.0_492 / openjdk-26 → 25/25/8/26）。 */
function javaMajorOf(dir) {
  const name = dir.replace(/[\\/]+$/u, '').split(/[\\/]/u).pop() ?? '';
  const legacy = /(?:jdk|jre)[-_]?1\.(\d+)/iu.exec(name);
  if (legacy !== null) return Number(legacy[1]);
  const match = /(?:^|[^\d])(\d{2,3})(?:\.\d+)*/u.exec(name);
  if (match === null) return undefined;
  const major = Number(match[1]);
  return major >= 8 && major <= 99 ? major : undefined;
}

const JDK_ROOT_HINTS = [
  () => join(process.env.USERPROFILE ?? '', '.jdks'),
  () => 'C:\\Program Files\\Java',
  () => 'C:\\Program Files\\Eclipse Adoptium',
  () => 'C:\\Program Files\\Microsoft',
  () => 'C:\\Program Files\\Zulu',
  () => 'C:\\Program Files\\BellSoft',
  () => 'C:\\Program Files\\Amazon Corretto',
  () => 'C:\\Program Files\\Semeru',
  () => 'D:\\Program Files\\Java',
  () => 'D:\\ProgramFiles\\Java',
  () => join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Eclipse Adoptium'),
];

/**
 * 找和目标 Java 版本匹配的 JDK（模仿 IDEA 的 JDK 选择）：
 *   · .dsh-devship.json 的 javaHome 优先；
 *   · JAVA_HOME 版本合适就用；
 *   · 否则在 ~/.jdks（IDEA 下载的 JDK）、常见安装目录里挑主版本匹配的，次选最小的更高版本。
 */
async function findJdk(major, override) {
  if (typeof override === 'string' && override !== '' && await isFile(join(override, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'))) {
    return override;
  }
  const installed = [];
  for (const hint of JDK_ROOT_HINTS) {
    const base = hint();
    if (typeof base !== 'string' || base === '') continue;
    for (const dir of await listDirectoriesNamed(base, /jdk|jre|ms-|openjdk|dragonwell|zulu|corretto|semeru|graal/iu)) {
      const version = javaMajorOf(dir);
      if (version === undefined) continue;
      if (!(await isFile(join(dir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')))) continue;
      installed.push({ dir, version });
    }
  }
  const current = process.env.JAVA_HOME;
  if (typeof current === 'string' && current !== '') {
    const version = javaMajorOf(current);
    if (version !== undefined && (major === undefined || version === major)) return current;
  }
  if (major === undefined) return installed[0]?.dir;
  const exact = installed.find((candidate) => candidate.version === major);
  if (exact !== undefined) return exact.dir;
  const higher = installed.filter((candidate) => candidate.version > major).sort((left, right) => left.version - right.version)[0];
  return higher?.dir;
}

/** 从根 pom 读目标 Java 主版本（java.version / maven.compiler.release / source / target）。 */
async function requiredJavaMajor(root) {
  const pom = await readText(join(root, 'pom.xml'));
  if (pom === undefined) return undefined;
  for (const pattern of [
    /<java\.version>\s*(\d+)/u,
    /<maven\.compiler\.release>\s*(\d+)/u,
    /<maven\.compiler\.source>\s*(\d+)/u,
    /<maven\.compiler\.target>\s*(\d+)/u,
  ]) {
    const match = pattern.exec(pom);
    if (match !== null) {
      const major = Number(match[1]);
      if (Number.isInteger(major) && major >= 8 && major <= 99) return major;
    }
  }
  return undefined;
}

const plugin = {
  name: 'dsh-devship',
  inject: ['webServer', 'subprocess', 'sandboxPolicy'],
  apply(ctx) {
    /** projectId -> 运行中的进程条目 */
    const processes = new Map();
    /** buildKey -> 打包任务条目 */
    const builds = new Map();
    let scanCache;
    let scanAt = 0;

    /**
     * 当前工作区根目录：
     *   1) 工作区账目（workspaceRegistry）里包含活跃会话的工作区路径；
     *   2) 最近一个会话表头的 cwd；
     *   3) 沙箱策略的 workspaceRoot；
     *   4) 进程 cwd（兜底，保证插件仍可用）。
     */
    function workspaceRoot() {
      try {
        const registry = ctx.get('workspaceRegistry');
        if (registry !== undefined && registry !== null && typeof registry.list === 'function') {
          const sessions = ctx.get('sessions');
          const live = new Set(
            sessions !== undefined && sessions !== null && typeof sessions.list === 'function'
              ? sessions.list().map((session) => session.id)
              : [],
          );
          let best;
          for (const workspace of registry.list() ?? []) {
            const path = typeof workspace?.path === 'string' ? workspace.path : '';
            if (path === '') continue;
            let ids = [];
            try {
              ids = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];
            } catch {
              ids = [];
            }
            const score = ids.reduce((sum, id) => sum + (live.has(id) ? 1 : 0), 0);
            const updated = typeof workspace.updatedAt === 'number' ? workspace.updatedAt : 0;
            if (best === undefined || score > best.score || (score === best.score && updated > best.updated)) {
              best = { path, score, updated };
            }
          }
          if (best !== undefined) return best.path;
        }
      } catch {
        /* 账目不可用：继续尝试其它来源 */
      }
      try {
        const sessions = ctx.get('sessions');
        const list = sessions !== undefined && sessions !== null && typeof sessions.list === 'function' ? sessions.list() : [];
        for (let index = list.length - 1; index >= 0; index -= 1) {
          const cwd = list[index]?.header?.cwd;
          if (typeof cwd === 'string' && cwd !== '') return cwd;
        }
      } catch {
        /* 会话列表不可用 */
      }
      try {
        const policy = ctx.get('sandboxPolicy');
        const root = policy?.workspaceRoot;
        if (typeof root === 'string' && root !== '') return root;
      } catch {
        /* 沙箱策略不可用 */
      }
      return process.cwd();
    }

    /** 请求带来的工作区路径优先（客户端最清楚当前工作区），否则走 Host 探测。 */
    function effectiveRoot(override) {
      if (typeof override === 'string') {
        const candidate = override.trim();
        if (candidate !== '' && isAbsolute(candidate)) return candidate;
      }
      return workspaceRoot();
    }

    /** 工作区级配置：.dsh-devship.json 可覆盖 maven / pnpm 的可执行文件路径。 */
    async function workspaceConfig(root) {
      if (typeof root !== 'string' || root === '') return {};
      const text = await readText(join(root, '.dsh-devship.json'));
      if (text === undefined) return {};
      try {
        const value = JSON.parse(text);
        return value !== null && typeof value === 'object' ? value : {};
      } catch {
        return {};
      }
    }

    /**
     * 解析可执行文件：PATH → 工作区 wrapper / 环境变量 / 常见安装目录 → 明确报错。
     * Windows 上 mvn / pnpm 通常是 .cmd，PATH 解析会按 PATHEXT 找到它们。
     */
    async function resolveExecutable(name, root) {
      const subprocess = ctx.subprocess;
      if (subprocess !== undefined && typeof subprocess.resolveExecutable === 'function') {
        try {
          return await subprocess.resolveExecutable(name);
        } catch {
          /* PATH 里没有，继续兜底 */
        }
      }
      const config = await workspaceConfig(root);
      return name === 'mvn'
        ? await findMaven(root, config.maven)
        : await findPnpm(root, config.pnpm);
    }

    function launcherDir(root) {
      return join(root, '.dsh-devship');
    }

    /** 目标 JDK：工作区声明的 Java 版本 → 本机匹配的 JDK（结果缓存）。 */
    let jdkMemo;
    async function resolveJavaHome(root) {
      if (jdkMemo !== undefined && jdkMemo.root === root) return jdkMemo;
      const config = await workspaceConfig(root);
      const major = await requiredJavaMajor(root);
      const javaHome = await findJdk(major, config.javaHome);
      jdkMemo = { root, major, javaHome };
      return jdkMemo;
    }

    /** 子进程环境：把 Maven 需要的 JAVA_HOME 显式传给子进程。 */
    async function javaEnv(root) {
      const jdk = await resolveJavaHome(root);
      return jdk.javaHome === undefined ? {} : { JAVA_HOME: jdk.javaHome };
    }

    /** 扫描工作区，返回项目清单（带缓存）。 */
    async function scan(root) {
      const now = Date.now();
      if (scanCache !== undefined && scanCache.root === root && now - scanAt < SCAN_TTL_MS) return scanCache;
      const projects = [];
      const seen = new Set();
      const add = (project) => {
        if (seen.has(project.id)) return;
        seen.add(project.id);
        projects.push(project);
      };

      const rootPom = await readText(join(root, 'pom.xml'));
      if (rootPom !== undefined) {
        const candidates = [];
        const modules = pomModules(rootPom);
        for (const moduleName of modules) {
          const moduleDir = join(root, moduleName);
          if (!(await isDirectory(moduleDir))) continue;
          if (await hasApplicationClass(join(moduleDir, 'src', 'main', 'java'))) candidates.push(moduleDir);
          for (const child of await listDirectories(moduleDir)) {
            if (!child.endsWith('-server')) continue;
            const childDir = join(moduleDir, child);
            if (await hasApplicationClass(join(childDir, 'src', 'main', 'java'))) candidates.push(childDir);
          }
        }
        for (const dir of candidates) {
          const modulePath = toId(root, dir);
          const port = await detectPort(dir);
          // 聚合壳（根 pom 的直接子模块里带启动类的非 *-server）：它的模块依赖 jar
          // 若被 spring-boot repackage 成 BOOT-INF 嵌套包，命令行启动会缺 Bean，给个提示。
          const note = modulePath.includes('/') ? undefined : '聚合壳：若模块 jar 是 fat-jar（BOOT-INF 嵌套），命令行启动会缺 Bean；IDEA 直接跑不受影响。首次可在打包里加 clean 重建。';
          add({
            id: modulePath,
            name: modulePath.split('/').pop() ?? modulePath,
            kind: 'java',
            modulePath,
            dir,
            port,
            note,
            command: `mvn -pl ${modulePath} -am install -DskipTests → mvn -pl ${modulePath} spring-boot:run`,
          });
        }
      }

      const packageDirs = [];
      const rootPackage = await readText(join(root, 'package.json'));
      if (rootPackage !== undefined) packageDirs.push(root);
      // 广度优先找 package.json（最多 4 层，跳过 node_modules/target/dist 等），
      // 这样 northbound/src/main/webapp 这种标准 Maven 布局里的前端也能扫到
      const NODE_MAX_DEPTH = 4;
      const queue = [{ dir: root, depth: 0 }];
      const visitedDirs = new Set([root]);
      while (queue.length > 0) {
        const node = queue.shift();
        if (node.depth >= NODE_MAX_DEPTH) continue;
        for (const child of await listDirectories(node.dir)) {
          if (SKIP_DIRS.has(child) || child.startsWith('.')) continue;
          const childDir = join(node.dir, child);
          if (visitedDirs.has(childDir)) continue;
          visitedDirs.add(childDir);
          packageDirs.push(childDir);
          queue.push({ dir: childDir, depth: node.depth + 1 });
        }
      }
      for (const dir of packageDirs) {
        const source = await readText(join(dir, 'package.json'));
        if (source === undefined) continue;
        let manifest;
        try {
          manifest = JSON.parse(source);
        } catch {
          continue;
        }
        // 开发脚本：常见几种命名都认（dev / dev:local / dev-server / serve / start）
        const devKey = ['dev', 'dev:local', 'dev-server', 'serve', 'start']
          .find((name) => typeof manifest?.scripts?.[name] === 'string' && manifest.scripts[name].trim() !== '');
        if (devKey === undefined) continue;
        const dev = manifest.scripts[devKey];
        // 打包脚本：优先生产构建，其次 build / build:dev（yudao-ui 系列只有 build:prod 等带后缀的）
        const buildScript = ['build:prod', 'build', 'build:dev', 'build:local']
          .find((name) => typeof manifest?.scripts?.[name] === 'string' && manifest.scripts[name].trim() !== '');
        const rel = toId(root, dir);
        add({
          id: rel,
          name: rel === '.' ? (manifest.name ?? 'workspace') : rel.split('/').pop(),
          kind: 'node',
          dir,
          devScript: dev,
          buildScript,
          buildScriptText: buildScript === undefined ? undefined : manifest.scripts[buildScript],
          command: `pnpm run ${devKey}`,
          ...buildScript === undefined ? {} : { buildCommand: `pnpm run ${buildScript}` },
          description: typeof manifest.description === 'string' ? manifest.description : undefined,
        });
      }

      scanCache = { root, projects };
      scanAt = now;
      return scanCache;
    }

    function spawnCommon() {
      return {
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 64000, spill: { maxBytes: 4 * 1024 * 1024 } },
          stderr: { maxBytes: 64000, spill: { maxBytes: 4 * 1024 * 1024 } },
        },
        graceMs: GRACE_MS,
      };
    }

    async function launch(projectId, profile, root, options) {
      const { projects } = await scan(root);
      const project = projects.find((candidate) => candidate.id === projectId);
      if (project === undefined) throw new Error(`未知项目: ${projectId}`);
      const current = processes.get(project.id);
      if (current !== undefined && (current.state === 'running' || current.state === 'building' || current.state === 'stopping')) {
        throw new Error(`${project.name} 已在运行或正在启动`);
      }
      if (project.port !== undefined && await portBusy(project.port)) {
        throw new Error(`端口 ${project.port} 已被占用：${project.name} 可能已在运行（本插件无法停止非本插件启动的进程，请先在 IDEA/终端里停掉旧实例）`);
      }

      const previous = processes.get(project.id);
      const entry = {
        id: project.id,
        name: project.name,
        kind: project.kind,
        handle: undefined,
        state: project.kind === 'java' ? 'building' : 'running',
        phase: project.kind === 'java' ? 'deps' : 'run',
        startedAt: Date.now(),
        tail: previous === undefined ? '' : previous.tail,
        stdoutOffset: 0,
        stderrOffset: 0,
      };
      processes.set(project.id, entry);
      await attachLogFile(entry, root, `run-${project.id}`);
      await rememberRun(root, project, entry);

      /** 启动一个阶段并等待它结束（正常退出返回 {exitCode}，spawn 失败返回 {error}）。 */
      const spawnPhase = async (executable, phase, args, cwd, env, launcherOverride) => {
        entry.phase = phase;
        entry.stdoutOffset = 0;
        entry.stderrOffset = 0;
        // 面板只显示当前阶段的输出，但落盘文件保留全部阶段
        entry.tail = '';
        if (typeof entry.logFile === 'string' && entry.logFile !== '') {
          try {
            appendFileSync(entry.logFile, `\n===== 阶段 ${phase} =====\n`, 'utf8');
          } catch {
            /* 忽略 */
          }
        }
        const launcher = launcherOverride ?? await writeLauncher(launcherDir(root), `launch-${project.id}-${phase}`, executable, args);
        const spec = {
          argv: launcher.argv,
          cwd,
          ...spawnCommon(),
          ...env === undefined || Object.keys(env).length === 0 ? {} : { env },
        };
        entry.logPath = launcher.logPath;
        entry.logOffset = 0;
        const handle = ctx.subprocess.spawn(spec);
        entry.handle = handle;
        entry.state = phase === 'deps' ? 'building' : 'running';
        return await handle.done.then((result) => result, (error) => ({ error }));
      };

      /**
       * 脱离模式：把整条启动链写进一个 .cmd（输出重定向到日志文件），再用 WMI 起进程。
       * WMI 起的进程父进程是系统服务，DSH 退出不会带走它。
       */
      const startDetached = async (phases) => {
        const base = `run-${slug(project.id)}`;
        const dir = launcherDir(root);
        await mkdir(dir, { recursive: true });
        await mkdir(join(dir, 'logs'), { recursive: true }).catch(() => {});
        const cmdFile = join(dir, `${base}-detached.cmd`);
        const logPath = join(dir, 'logs', `${base}.detached.log`);
        const quote = (value) => `"${String(value).replace(/"/gu, '""')}"`;
        const lines = ['@echo off'];
        // 只用 ASCII：cmd.exe 按 OEM 代码页解析批处理，UTF-8 中文会破坏语法
        lines.push(`echo [dsh-devship] start %DATE% %TIME% >> ${quote(logPath)}`);
        for (const phase of phases) {
          for (const [key, value] of Object.entries(phase.env ?? {})) lines.push(`set "${key}=${String(value).replace(/"/gu, '')}"`);
          lines.push(`cd /d ${quote(phase.cwd)}`);
          lines.push(`call ${quote(phase.executable)} ${phase.args.map(quote).join(' ')} >> ${quote(logPath)} 2>&1`);
          lines.push(`if errorlevel 1 (echo [dsh-devship] phase-failed: ${phase.label} >> ${quote(logPath)} & exit /b 1)`);
        }
        lines.push(`echo [dsh-devship] exited >> ${quote(logPath)}`, '');
        await writeFile(cmdFile, lines.join('\r\n'), 'utf8');
        // 不要截断日志：上一轮进程可能还开着它（EBUSY），追加写即可
        await appendFile(logPath, '', 'utf8').catch(() => {});
        const commandLine = `cmd.exe /d /c "${cmdFile}"`;
        const script = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${commandLine.replace(/'/gu, "''")}' }; if ($r.ReturnValue -eq 0) { $r.ProcessId } else { 0 }`;
        const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const outcome = await new Promise((resolve) => {
          execFile(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 30000 }, (error, out, err) => resolve({ error, out: String(out ?? ''), err: String(err ?? '') }));
        });
        const pid = Number(outcome.out.trim().split(/\r?\n/u).pop());
        return {
          pid: Number.isInteger(pid) && pid > 0 ? pid : undefined,
          logPath,
          detail: outcome.error === null || outcome.error === undefined
            ? `stdout=${outcome.out.trim()} stderr=${outcome.err.trim()}`
            : `${outcome.error.message} | stderr=${outcome.err.trim()}`,
        };
      };

      /** 脱离模式：交给 WMI 起，之后只靠 pid + 日志文件跟踪。 */
      const runDetached = async () => {
        try {
          const phases = [];
          if (project.kind === 'java') {
            const executable = await resolveExecutable('mvn', root);
            const env = await javaEnv(root);
            phases.push({ label: 'deps', executable, args: ['-pl', project.modulePath, '-am', '-DskipTests', '-Dspring-boot.repackage.skip=true', 'install'], cwd: root, env });
            const args = ['-pl', project.modulePath, 'spring-boot:run'];
            if (typeof profile === 'string' && profile.trim() !== '') args.push(`-Dspring-boot.run.profiles=${profile.trim()}`);
            phases.push({ label: 'run', executable, args, cwd: root, env });
          } else {
            const nodePath = await resolveExecutable('node', root);
            const spec = await nodeScriptSpec(project, project.devScript, nodePath);
            if (spec === undefined) {
              phases.push({ label: 'run', executable: await resolveExecutable('pnpm', root), args: ['run', 'dev'], cwd: project.dir });
            } else {
              const words = splitCommandLine(spec.commandLine);
              phases.push({ label: 'run', executable: words[0], args: words.slice(1), cwd: project.dir });
            }
          }
          const started = await startDetached(phases);
          entry.detached = true;
          entry.pid = started.pid;
          entry.logPath = started.logPath;
          // 从日志末尾开始读，避免把上一轮的输出当成这一次的
          entry.logOffset = (await stat(started.logPath).then((info) => info.size).catch(() => 0));
          entry.phase = 'run';
          if (started.pid === undefined) {
            entry.state = 'failed';
            entry.error = `WMI 启动失败：${started.detail}`;
            return;
          }
          entry.state = 'running';
          await rememberRun(root, project, entry);
        } catch (error) {
          entry.state = 'failed';
          entry.error = error instanceof Error ? error.message : String(error);
        }
      };

      const runChain = async () => {
        try {
          if (project.kind === 'java') {
            const executable = await resolveExecutable('mvn', root);
            const env = await javaEnv(root);
            // 先 install 上游模块（子模块 runner 需要仓库里的最新快照）；
            // 关掉 spring-boot repackage，避免模块 jar 变成 BOOT-INF 嵌套包，
            // 否则聚合壳 yudao-server 运行时看不到模块里的 Bean。
            const depsArgs = ['-pl', project.modulePath, '-am', '-DskipTests', '-Dspring-boot.repackage.skip=true', 'install'];
            const deps = await spawnPhase(executable, 'deps', depsArgs, root, env);
            if (entry.stopRequested === true) {
              entry.state = 'stopped';
              return;
            }
            if (deps?.error !== undefined) {
              entry.state = 'failed';
              entry.error = `依赖构建进程启动失败: ${deps.error instanceof Error ? deps.error.message : String(deps.error)}`;
              return;
            }
            if (deps?.exitCode !== 0) {
              entry.state = 'failed';
              entry.exitCode = deps?.exitCode;
              entry.error = `依赖构建失败（exit ${String(deps?.exitCode)}），详见日志`;
              return;
            }
            const args = ['-pl', project.modulePath, 'spring-boot:run'];
            if (typeof profile === 'string' && profile.trim() !== '') args.push(`-Dspring-boot.run.profiles=${profile.trim()}`);
            const run = await spawnPhase(executable, 'run', args, root, env);
            if (entry.stopRequested === true) {
              entry.state = 'stopped';
              return;
            }
            entry.state = 'exited';
            entry.exitCode = run?.exitCode;
            if (run?.error !== undefined) entry.error = run.error instanceof Error ? run.error.message : String(run.error);
          } else {
            // 前端：优先直接用 node 跑 vite（pnpm 会再开一个可见 cmd 窗口）
            const nodePath = await resolveExecutable('node', root);
            const spec = await nodeScriptSpec(project, project.devScript, nodePath);
            const launcher = spec === undefined
              ? undefined
              : await writeRawLauncher(launcherDir(root), `launch-${project.id}-run`, spec.commandLine);
            const executable = launcher === undefined ? await resolveExecutable('pnpm', root) : undefined;
            const run = await spawnPhase(executable, 'run', launcher === undefined ? ['dev'] : [], project.dir, undefined, launcher);
            if (entry.stopRequested === true) {
              entry.state = 'stopped';
              return;
            }
            entry.state = 'exited';
            entry.exitCode = run?.exitCode;
            if (run?.error !== undefined) entry.error = run.error instanceof Error ? run.error.message : String(run.error);
          }
        } catch (error) {
          entry.state = 'failed';
          entry.error = error instanceof Error ? error.message : String(error);
        }
      };
      if (options?.detach === true) {
        void runDetached();
      } else {
        void runChain().finally(() => { void forgetRun(root, project.id); });
      }
      return entry;
    }

    async function stop(projectId, root) {
      const entry = processes.get(projectId);
      if (entry === undefined) throw new Error('该项目没有运行中的进程');
      // 脱离模式：有 pid 就整棵树结束；没有 pid（接管时只有端口）就按端口找
      if (entry.detached === true || entry.adopted === true) {
        entry.state = 'stopping';
        const pid = Number.isInteger(entry.pid) && pidAlive(entry.pid)
          ? entry.pid
          : await pidByPort(entry.port);
        if (pid === undefined) {
          entry.state = 'stopped';
          entry.error = '没找到对应进程，可能已经停了';
          processes.delete(projectId);
          await forgetRun(root, projectId);
          return entry;
        }
        await killTree(pid);
        await sleep(300);
        entry.state = 'stopped';
        processes.delete(projectId);
        await forgetRun(root, projectId);
        return entry;
      }
      entry.stopRequested = true;
      if (entry.state !== 'running' && entry.state !== 'building' && entry.state !== 'stopping') {
        entry.state = entry.state === 'failed' ? 'failed' : 'exited';
        tailOf(entry);
        await forgetRun(root, projectId);
        return entry;
      }
      entry.state = 'stopping';
      try {
        entry.handle?.terminate();
      } catch {
        /* 已退出：忽略 */
      }
      try {
        if (entry.handle !== undefined) await Promise.race([entry.handle.waitForExit(), sleep(8000)]);
      } catch {
        /* 等待失败也就当已停止 */
      }
      entry.state = 'stopped';
      tailOf(entry);
      await forgetRun(root, projectId);
      return entry;
    }

    /** 记住「谁在跑」，DSH 重启后靠它把状态接管回来。 */
    async function rememberRun(root, project, entry) {
      try {
        const state = await readRunState(root);
        state[project.id] = {
          name: project.name,
          kind: project.kind,
          ...Number.isInteger(project.port) ? { port: project.port } : {},
          startedAt: entry.startedAt,
          ...Number.isInteger(entry.pid) ? { pid: entry.pid } : {},
          ...typeof entry.logPath === 'string' ? { logPath: entry.logPath } : {},
          ...typeof entry.logFile === 'string' ? { logFile: entry.logFile } : {},
        };
        await writeRunState(root, state);
      } catch {
        /* 持久化失败不影响启动 */
      }
    }

    async function forgetRun(root, projectId) {
      try {
        const state = await readRunState(root);
        if (state[projectId] === undefined) return;
        delete state[projectId];
        await writeRunState(root, state);
      } catch {
        /* 忽略 */
      }
    }

    /**
     * DSH 重启后接管仍在本机跑着的服务：state.json 里有记录 + 端口仍在监听 → 建一条
     * 「接管」条目放进 processes，面板就能显示成运行中，并能直接停止。
     */
    async function adoptRuns(root, projects, ports) {
      const state = await readRunState(root);
      let changed = false;
      for (const [id, saved] of Object.entries(state)) {
        if (processes.has(id)) continue;
        const project = projects.find((candidate) => candidate.id === id);
        const port = Number.isInteger(saved?.port) ? saved.port : project?.port;
        // 存活判据：优先 pid（脱离模式一定记录 pid），没有 pid 再看端口
        const pid = Number.isInteger(saved?.pid) && pidAlive(saved.pid) ? saved.pid : undefined;
        const busy = pid !== undefined
          ? true
          : Number.isInteger(port) ? ports[project?.id ?? id] === true || (await portBusy(port, 200)) : false;
        if (!busy) {
          delete state[id];
          changed = true;
          continue;
        }
        const entry = {
          id,
          name: saved?.name ?? project?.name ?? id,
          kind: project?.kind ?? saved?.kind ?? 'java',
          state: 'running',
          adopted: true,
          ...pid === undefined ? {} : { pid, detached: true },
          startedAt: typeof saved?.startedAt === 'number' ? saved.startedAt : Date.now(),
          ...Number.isInteger(port) ? { port } : {},
          tail: '',
          ...typeof saved?.logPath === 'string' ? { logPath: saved.logPath } : {},
          ...typeof saved?.logFile === 'string' ? { logFile: saved.logFile } : {},
        };
        seedTailFromLog(entry);
        processes.set(id, entry);
      }
      if (changed) await writeRunState(root, state);
    }

    /** 记录一个打包任务的收尾状态（Maven / pnpm 共用）。 */
    function trackBuild(entry) {
      const done = entry.handle.done;
      if (done !== undefined && typeof done.then === 'function') {
        done.then((result) => {
          entry.state = result?.exitCode === 0 ? 'success' : 'failed';
          entry.exitCode = result?.exitCode;
          tailOf(entry);
        }, (error) => {
          entry.state = 'failed';
          entry.error = error instanceof Error ? error.message : String(error);
        });
      }
      return entry;
    }

    async function build(modulePath, clean, root, fast) {
      const key = modulePath === '' ? 'build:<root>' : `build:${modulePath}`;
      const current = builds.get(key);
      if (current !== undefined && current.state === 'running') throw new Error('该模块正在打包');
      const executable = await resolveExecutable('mvn', root);
      const env = await javaEnv(root);
      const goals = clean === true ? ['clean', 'package'] : ['package'];
      // 快速打包 = 不带 -am（依赖必须已 install 过），再加多线程构建
      const args = modulePath === ''
        ? [...goals, '-DskipTests', '-T', '1C']
        : ['-pl', modulePath, ...fast === true ? [] : ['-am'], ...goals, '-DskipTests', '-T', '1C'];
      const launcher = await writeLauncher(launcherDir(root), `build-${modulePath === '' ? 'all' : modulePath}`, executable, args);
      let handle;
      try {
        handle = ctx.subprocess.spawn({
          argv: launcher.argv,
          cwd: root,
          ...spawnCommon(),
          ...Object.keys(env).length === 0 ? {} : { env },
        });
      } catch (error) {
        throw new Error(`打包启动失败: ${error instanceof Error ? error.message : String(error)}`);
      }
      const entry = {
        id: key,
        name: `${modulePath === '' ? '全量打包' : modulePath}${fast === true ? ' · 快速' : ''}`,
        kind: 'build',
        tool: 'maven',
        handle,
        ...launcher.logPath === undefined ? {} : { logPath: launcher.logPath, logOffset: 0 },
        state: 'running',
        startedAt: Date.now(),
        tail: '',
        stdoutOffset: 0,
        stderrOffset: 0,
      };
      builds.set(key, entry);
      await attachLogFile(entry, root, key);
      return trackBuild(entry);
    }

    /** 前端打包：pnpm run build:prod（没有就 build / build:dev），在工作目录里执行。 */
    async function buildNode(project, root) {
      const script = project.buildScript;
      if (typeof script !== 'string' || script === '') {
        throw new Error(`${project.name} 没有可用的打包脚本（build:prod / build / build:dev）`);
      }
      const key = `build:${project.id}`;
      const current = builds.get(key);
      if (current !== undefined && current.state === 'running') throw new Error(`${project.name} 正在打包`);
      // 前端：优先直接跑脚本命令（不走 pnpm，避免多开一个可见 cmd 窗口）
      // 脚本正文（例如 node .../vite.js build --mode prod）才能直接跑，脚本名只是展示用
      const spec = await nodeScriptSpec(project, project.buildScriptText ?? script, await resolveExecutable('node', root));
      const launcher = spec === undefined
        ? await writeLauncher(launcherDir(root), `build-${project.id}`, await resolveExecutable('pnpm', root), ['run', script])
        : await writeRawLauncher(launcherDir(root), `build-${project.id}`, spec.commandLine);
      let handle;
      try {
        handle = ctx.subprocess.spawn({ argv: launcher.argv, cwd: project.dir, ...spawnCommon() });
      } catch (error) {
        throw new Error(`打包启动失败: ${error instanceof Error ? error.message : String(error)}`);
      }
      const entry = {
        id: key,
        name: `${project.name} · ${script}`,
        kind: 'build',
        tool: 'pnpm',
        handle,
        ...launcher.logPath === undefined ? {} : { logPath: launcher.logPath, logOffset: 0 },
        state: 'running',
        startedAt: Date.now(),
        tail: '',
        stdoutOffset: 0,
        stderrOffset: 0,
      };
      builds.set(key, entry);
      await attachLogFile(entry, root, key);
      return trackBuild(entry);
    }

    /**
     * 部署一个项目：上传打包产物到 deploy.json 里配置的远端目录。
     * 先建任务条再校验（失败也写进日志区），异步上传，进度写进 tail。
     */
    async function deployProject(project, root, session) {
      const key = `deploy:${project.id}`;
      const current = builds.get(key);
      if (current !== undefined && current.state === 'running') throw new Error(`${project.name} 正在部署`);
      const entry = {
        id: key,
        name: project.name,
        kind: 'deploy',
        tool: 'ssh',
        state: 'running',
        startedAt: Date.now(),
        tail: '',
      };
      builds.set(key, entry);
      await attachLogFile(entry, root, key);
      const log = (line) => {
        appendLog(entry, `${new Date().toLocaleTimeString()} ${line}\n`);
      };
      const config = await readDeployConfig(root);
      const target = config.targets[project.id];
      if (target === undefined || typeof target.remoteDir !== 'string' || target.remoteDir === '') {
        entry.state = 'failed';
        entry.error = `还没有配置部署目录（deploy.json → targets["${project.id}"].remoteDir）`;
        log(`✗ ${entry.error}`);
        return entry;
      }
      entry.name = `${project.name} → ${target.remoteDir}`;
      const artifact = await resolveArtifact(root, project, target);
      if (!existsSync(artifact)) {
        entry.state = 'failed';
        entry.error = `找不到产物 ${artifact}，请先点「打包」`;
        log(`✗ ${entry.error}`);
        return entry;
      }
      log(`产物：${artifact}`);
      void (async () => {
        try {
          const result = await uploadArtifact({ project, target, config, artifact, log, session });
          entry.state = 'success';
          entry.remote = result.remote;
          if (result.containerStatus !== undefined) entry.containerStatus = result.containerStatus;
        } catch (error) {
          entry.state = 'failed';
          entry.error = error instanceof Error ? error.message : String(error);
          log(`✗ 失败：${entry.error}`);
        }
      })();
      return entry;
    }

    /** 等一个任务条目跑完（build / deploy），把子任务新增日志同步到父条目。 */
    async function waitEntry(entry, timeoutMs, log, parent) {
      const start = Date.now();
      let copied = 0;
      while (entry.state === 'running' || entry.state === 'building') {
        if (Date.now() - start > timeoutMs) {
          entry.state = 'failed';
          entry.error = '超时未完成';
          log?.('✗ 超时');
          break;
        }
        await sleep(600);
        const tail = publicEntry(entry).tail;
        if (parent !== undefined && tail.length > copied) {
          appendLog(parent, tail.slice(copied));
          copied = tail.length;
        }
      }
      return entry;
    }

    /**
     * 一键发布：打包 → 部署 → 重启容器 → 校验。
     * 单个任务条目（kind: 'release'）里串起全过程，日志带阶段编号。
     */
    async function releaseProject(project, root, options) {
      const key = `release:${project.id}`;
      const running = builds.get(key);
      if (running !== undefined && running.state === 'running') throw new Error(`${project.name} 正在发布`);
      const entry = {
        id: key,
        name: `${project.name} · 发布`,
        kind: 'release',
        tool: 'pipeline',
        state: 'running',
        startedAt: Date.now(),
        tail: '',
      };
      builds.set(key, entry);
      await attachLogFile(entry, root, key);
      const log = (line) => {
        appendLog(entry, `${new Date().toLocaleTimeString()} ${line}\n`);
      };
      void (async () => {
        try {
          log(`① 打包${options?.fast === true ? '（快速，不带 -am）' : ''}${options?.clean === true ? ' +clean' : ''} …`);
          const buildEntry = project.kind === 'node'
            ? await buildNode(project, root)
            : await build(project.modulePath, options?.clean === true, root, options?.fast === true);
          await waitEntry(buildEntry, 40 * 60_000, log, entry);
          if (buildEntry.state !== 'success') {
            entry.state = 'failed';
            entry.error = `打包失败（exit ${String(buildEntry.exitCode ?? '?')}）`;
            log(`✗ ${entry.error}`);
            return;
          }
          log('① 打包完成');
          entry.artifact = buildEntry.name;
          log('② 部署 …');
          const deployEntry = await deployProject(project, root);
          await waitEntry(deployEntry, 40 * 60_000, log, entry);
          if (deployEntry.state !== 'success') {
            entry.state = 'failed';
            entry.error = `部署失败：${String(deployEntry.error ?? '见日志')}`;
            log(`✗ ${entry.error}`);
            return;
          }
          entry.state = 'success';
          entry.containerStatus = deployEntry.containerStatus;
          log('✔ 发布完成');
        } catch (error) {
          entry.state = 'failed';
          entry.error = error instanceof Error ? error.message : String(error);
          log(`✗ ${entry.error}`);
        }
      })();
      return entry;
    }

    async function status(root) {
      // 端口探测：让面板也能标出「已被外部实例占用」的服务（IDEA/终端起的那些）
      const ports = {};
      let scannedProjects = [];
      try {
        const { projects } = await scan(root);
        scannedProjects = projects;
        await Promise.all(projects
          .filter((project) => Number.isInteger(project.port))
          .map(async (project) => {
            ports[project.id] = await portBusy(project.port, 200);
          }));
      } catch {
        /* 扫描失败时不给端口信息，面板按「未知」处理 */
      }
      // DSH 重启后：把还在跑的服务认回来（state.json + 端口仍在监听）
      try {
        if (scannedProjects.length > 0) await adoptRuns(root, scannedProjects, ports);
      } catch {
        /* 接管失败不影响状态返回 */
      }
      // 脱离模式的进程没有 handle.done，靠 pid 判活
      for (const [id, entry] of processes.entries()) {
        if (entry.detached !== true || entry.state !== 'running') continue;
        if (Number.isInteger(entry.pid) && pidAlive(entry.pid)) continue;
        entry.state = 'exited';
        tailOf(entry);
        void forgetRun(root, id);
      }
      const running = [];
      for (const entry of processes.values()) running.push(publicEntry(entry));
      const building = [];
      for (const entry of builds.values()) building.push(publicEntry(entry));
      return {
        root,
        running,
        builds: building,
        ports,
      };
    }

    /** 诊断：当前 Host 能看到的工作区来源，方便排查根目录解析问题。 */
    async function diagnostics() {
      const report = { code: 'dsh-devship/2', cwd: process.cwd(), registry: [], sessions: [], policy: undefined };
      try {
        const registry = ctx.get('workspaceRegistry');
        if (registry !== undefined && registry !== null && typeof registry.list === 'function') {
          for (const workspace of registry.list() ?? []) {
            let ids = [];
            try {
              ids = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];
            } catch {
              ids = [];
            }
            report.registry.push({
              path: typeof workspace?.path === 'string' ? workspace.path : '',
              title: typeof workspace?.title === 'string' ? workspace.title : '',
              sessions: ids.length,
            });
          }
        }
      } catch (error) {
        report.registryError = error instanceof Error ? error.message : String(error);
      }
      try {
        const sessions = ctx.get('sessions');
        if (sessions !== undefined && sessions !== null && typeof sessions.list === 'function') {
          for (const session of sessions.list().slice(-5)) {
            report.sessions.push({
              id: session?.id,
              cwd: session?.header?.cwd,
            });
          }
        }
      } catch (error) {
        report.sessionsError = error instanceof Error ? error.message : String(error);
      }
      try {
        const policy = ctx.get('sandboxPolicy');
        report.policy = policy?.workspaceRoot;
      } catch (error) {
        report.policyError = error instanceof Error ? error.message : String(error);
      }
      report.resolved = workspaceRoot();
      report.env = {
        platform: process.platform,
        mavenHome: process.env.MAVEN_HOME,
        m2Home: process.env.M2_HOME,
        pnpmHome: process.env.PNPM_HOME,
        pathMaven: (process.env.PATH ?? '').toLowerCase().includes('maven'),
      };
      try {
        report.mvn = await resolveExecutable('mvn', report.resolved);
      } catch (error) {
        report.mvnError = error instanceof Error ? error.message : String(error);
      }
      try {
        report.pnpm = await resolveExecutable('pnpm', report.resolved);
      } catch (error) {
        report.pnpmError = error instanceof Error ? error.message : String(error);
      }
      try {
        const jdk = await resolveJavaHome(report.resolved);
        report.java = { required: jdk.major, home: jdk.javaHome, envJavaHome: process.env.JAVA_HOME };
      } catch (error) {
        report.javaError = error instanceof Error ? error.message : String(error);
      }
      return report;
    }

    /** Client 半自检上报（最近 40 条），用来确认客户端模块是否真的加载了。 */
    const clientReports = [];

    const routes = [
      {
        path: `${PREFIX}/client-report`,
        handler: async (req, res) => {
          try {
            if (req.method === 'GET') {
              sendJson(res, 200, { ok: true, reports: clientReports });
              return;
            }
            const body = await readJsonBody(req);
            clientReports.push({ at: new Date().toISOString(), ...body });
            if (clientReports.length > 40) clientReports.shift();
            sendJson(res, 200, { ok: true });
          } catch (error) {
            sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        },
      },
      {
        path: `${PREFIX}/version`,
        handler: async (req, res) => {
          sendJson(res, 200, { ok: true, version: '3', diagnostics: await diagnostics(), clientReports });
        },
      },
      {
        path: `${PREFIX}/list`,
        handler: async (req, res) => {
          try {
            const body = await readJsonBody(req);
            const root = effectiveRoot(body.root);
            const scanned = await scan(root);
            const prefs = await readPrefs(root);
            const deploy = await readDeployConfig(root);
            const projects = scanned.projects.map((project) => {
              const target = deploy.targets[project.id];
              return target === undefined ? project : { ...project, deploy: target };
            });
            sendJson(res, 200, { ok: true, root: scanned.root, projects, hidden: prefs.hidden, deployAlias: deploy.alias ?? '' });
          } catch (error) {
            sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        },
      },
      {
        path: `${PREFIX}/deploy-config`,
        handler: async (req, res) => {
          try {
            const body = await readJsonBody(req);
            const root = effectiveRoot(body.root);
            // 没有 config 字段 = 读取（客户端用 POST 带 root 来读，避免 GET 不能带 body）
            if (req.method === 'GET' || body.config === undefined) {
              const config = await readDeployConfig(root);
              const hosts = await readSshHosts();
              sendJson(res, 200, {
                ok: true,
                config,
                hosts: hosts.map((host) => ({ alias: host.alias, host: host.host, user: host.user, port: host.port, auth: host.auth?.kind ?? 'key' })),
              });
              return;
            }
            const incoming = body.config;
            if (incoming === null || typeof incoming !== 'object') throw new Error('缺少 config 对象');
            const config = {
              ...typeof incoming.alias === 'string' && incoming.alias !== '' ? { alias: incoming.alias } : {},
              ...typeof incoming.host === 'string' && incoming.host !== '' ? { host: incoming.host } : {},
              ...Number.isInteger(incoming.port) ? { port: incoming.port } : {},
              ...typeof incoming.user === 'string' && incoming.user !== '' ? { user: incoming.user } : {},
              ...typeof incoming.password === 'string' && incoming.password !== '' ? { password: incoming.password } : {},
              targets: {},
            };
            for (const [id, target] of Object.entries(incoming.targets ?? {})) {
              if (target === null || typeof target !== 'object') continue;
              if (typeof target.remoteDir !== 'string' || target.remoteDir === '') continue;
              config.targets[id] = {
                remoteDir: target.remoteDir,
                ...typeof target.artifact === 'string' && target.artifact !== '' ? { artifact: target.artifact } : {},
                ...typeof target.container === 'string' && target.container !== '' ? { container: target.container } : {},
              };
            }
            await writeDeployConfig(root, config);
            sendJson(res, 200, { ok: true, config });
          } catch (error) {
            sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        },
      },
      {
        path: `${PREFIX}/deploy`,
        handler: async (req, res) => {
          try {
            const body = await readJsonBody(req);
            const root = effectiveRoot(body.root);
            const { projects } = await scan(root);
            const project = projects.find((candidate) => candidate.id === body.projectId);
            if (project === undefined) throw new Error(`未知项目: ${String(body.projectId)}`);
            const entry = await deployProject(project, root);
            sendJson(res, 200, { ok: true, entry: publicEntry(entry) });
          } catch (error) {
            sendJson(res, 200, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? String(error.stack ?? '').split('\n').slice(0, 6).join(' | ') : '',
            });
          }
        },
      },
      {
        path: `${PREFIX}/deploy-batch`,
        handler: async (req, res) => {
          try {
            const body = await readJsonBody(req);
            const ids = Array.isArray(body.projectIds) ? body.projectIds.filter((item) => typeof item === 'string' && item !== '') : [];
            if (ids.length === 0) throw new Error('没有选中任何项目');
            const root = effectiveRoot(body.root);
            const { projects } = await scan(root);
            const results = [];
            for (const id of ids.slice(0, 20)) {
              try {
                const project = projects.find((candidate) => candidate.id === id);
                if (project === undefined) throw new Error(`未知项目: ${id}`);
                await deployProject(project, root);
                results.push({ id, ok: true });
              } catch (error) {
                results.push({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
              }
            }
            sendJson(res, 200, { ok: true, results });
          } catch (error) {
            sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        },
      },
      {
        path: `${PREFIX}/release`,
        handler: async (req, res) => {
          try {
            const body = await readJsonBody(req);
            const root = effectiveRoot(body.root);
            const { projects } = await scan(root);
            const project = projects.find((candidate) => candidate.id === body.projectId);
            if (project === undefined) throw new Error(`未知项目: ${String(body.projectId)}`);
            const entry = await releaseProject(project, root, { clean: body.clean === true, fast: body.fast === true });
            sendJson(res, 200, { ok: true, entry: publicEntry(entry) });
          } catch (error) {
            sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        },
      },
      {
        path: `${PREFIX}/release-batch`,
        handler: async (req, res) => {
          try {
            const body = await readJsonBody(req);
            const ids = Array.isArray(body.projectIds) ? body.projectIds.filter((item) => typeof item === 'string' && item !== '') : [];
            if (ids.length === 0) throw new Error('没有选中任何项目');
            const root = effectiveRoot(body.root);
            const { projects } = await scan(root);
            const results = [];
            for (const id of ids.slice(0, 20)) {
              try {
                const project = projects.find((candidate) => candidate.id === id);
                if (project === undefined) throw new Error(`未知项目: ${id}`);
                await releaseProject(project, root, { clean: body.clean === true, fast: body.fast === true });
                results.push({ id, ok: true });
              } catch (error) {
                results.push({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
              }
            }
            sendJson(res, 200, { ok: true, results });
          } catch (error) {
            sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        },
      },
      {
        path: `${PREFIX}/log`,
        handler: async (req, res) => {
          try {
            const body = await readJsonBody(req);
            const id = typeof body.id === 'string' ? body.id : '';
            if (id === '') throw new Error('缺少 id');
            const root = effectiveRoot(body.root);
            const entry = processes.get(id) ?? builds.get(id);
            const file = entry?.logFile ?? logFileFor(root, id);
            if (!existsSync(file)) {
              sendJson(res, 200, { ok: true, path: file, text: entry?.tail ?? '', bytes: 0 });
              return;
            }
            const info = await stat(file);
            const text = await readFile(file, 'utf8');
            // 超大日志只回尾部 3MB，避免把浏览器卡死
            const clipped = text.length > 3_000_000 ? text.slice(-3_000_000) : text;
            sendJson(res, 200, { ok: true, path: file, text: clipped, bytes: info.size, clipped: clipped.length !== text.length });
          } catch (error) {
            sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        },
      },
      {
        path: `${PREFIX}/log-open`,
        handler: async (req, res) => {
          try {
            const body = await readJsonBody(req);
            const id = typeof body.id === 'string' ? body.id : '';
            if (id === '') throw new Error('缺少 id');
            const root = effectiveRoot(body.root);
            const entry = processes.get(id) ?? builds.get(id);
            const file = entry?.logFile ?? logFileFor(root, id);
            if (!existsSync(file)) throw new Error(`日志文件还不存在：${file}`);
            if (process.platform === 'win32') {
              execFile('explorer.exe', [`/select,${file}`], { windowsHide: false }, () => {});
            } else {
              execFile('xdg-open', [file], () => {});
            }
            sendJson(res, 200, { ok: true, path: file });
          } catch (error) {
            sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        },
      },
      {
        path: `${PREFIX}/status`,
        handler: async (req, res) => {
          try {
            const body = await readJsonBody(req);
            sendJson(res, 200, { ok: true, ...(await status(effectiveRoot(body.root))) });
          } catch (error) {
            sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        },
      },
      {
        path: `${PREFIX}/launch`,
        handler: async (req, res) => {
          try {
            const body = await readJsonBody(req);
            if (typeof body.projectId !== 'string' || body.projectId === '') throw new Error('缺少 projectId');
            const entry = await launch(body.projectId, body.profile, effectiveRoot(body.root), { detach: body.detach !== false });
            sendJson(res, 200, { ok: true, entry: publicEntry(entry) });
          } catch (error) {
            sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        },
      },
      {
        path: `${PREFIX}/stop`,
        handler: async (req, res) => {
          try {
            const body = await readJsonBody(req);
            if (typeof body.projectId !== 'string' || body.projectId === '') throw new Error('缺少 projectId');
            const entry = await stop(body.projectId, effectiveRoot(body.root));
            sendJson(res, 200, { ok: true, entry: publicEntry(entry) });
          } catch (error) {
            sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        },
      },
      {
        path: `${PREFIX}/build`,
        handler: async (req, res) => {
          try {
            const body = await readJsonBody(req);
            const root = effectiveRoot(body.root);
            // 按项目打包：Java 走 Maven，前端走 pnpm run build:prod
            if (typeof body.projectId === 'string' && body.projectId !== '') {
              const { projects } = await scan(root);
              const project = projects.find((candidate) => candidate.id === body.projectId);
              if (project === undefined) throw new Error(`未知项目: ${body.projectId}`);
              const built = project.kind === 'node'
                ? await buildNode(project, root)
                : await build(project.modulePath, body.clean === true, root, body.fast === true);
              sendJson(res, 200, { ok: true, entry: publicEntry(built) });
              return;
            }
            const modulePath = typeof body.modulePath === 'string' ? body.modulePath.trim() : '';
            const entry = await build(modulePath, body.clean === true, root, body.fast === true);
            sendJson(res, 200, { ok: true, entry: publicEntry(entry) });
          } catch (error) {
            sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        },
      },
      {
        path: `${PREFIX}/forget`,
        handler: async (req, res) => {
          try {
            const body = await readJsonBody(req);
            if (typeof body.id !== 'string') throw new Error('缺少 id');
            processes.delete(body.id);
            builds.delete(body.id);
            sendJson(res, 200, { ok: true });
          } catch (error) {
            sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        },
      },
      {
        path: `${PREFIX}/hide`,
        handler: async (req, res) => {
          try {
            const body = await readJsonBody(req);
            if (typeof body.id !== 'string' || body.id === '') throw new Error('缺少 id');
            const root = effectiveRoot(body.root);
            const prefs = await readPrefs(root);
            const next = new Set(prefs.hidden);
            if (body.hidden === false) next.delete(body.id);
            else next.add(body.id);
            await writePrefs(root, { ...prefs, hidden: [...next] });
            sendJson(res, 200, { ok: true, hidden: [...next] });
          } catch (error) {
            sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        },
      },
      {
        path: `${PREFIX}/launch-batch`,
        handler: async (req, res) => {
          try {
            const body = await readJsonBody(req);
            const ids = Array.isArray(body.projectIds) ? body.projectIds.filter((item) => typeof item === 'string' && item !== '') : [];
            if (ids.length === 0) throw new Error('没有选中任何项目');
            const root = effectiveRoot(body.root);
            const results = [];
            for (const id of ids.slice(0, 20)) {
              try {
                const entry = await launch(id, body.profile, root, { detach: body.detach !== false });
                results.push({ id, ok: true, state: entry.state });
              } catch (error) {
                results.push({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
              }
            }
            sendJson(res, 200, { ok: true, results });
          } catch (error) {
            sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        },
      },
      {
        path: `${PREFIX}/stop-batch`,
        handler: async (req, res) => {
          try {
            const body = await readJsonBody(req);
            const ids = Array.isArray(body.projectIds) ? body.projectIds.filter((item) => typeof item === 'string' && item !== '') : [];
            if (ids.length === 0) throw new Error('没有选中任何项目');
            const stopRoot = effectiveRoot(body.root);
            const results = [];
            for (const id of ids.slice(0, 20)) {
              try {
                const entry = await stop(id, stopRoot);
                results.push({ id, ok: true, state: entry.state });
              } catch (error) {
                results.push({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
              }
            }
            sendJson(res, 200, { ok: true, results });
          } catch (error) {
            sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        },
      },
    ];

    for (const route of routes) {
      ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: route.path, handler: route.handler }), `dsh-devship: ${route.path}`);
    }

    ctx.effect(() => async () => {
      for (const entry of processes.values()) {
        try {
          entry.handle.terminate();
        } catch {
          /* 已退出 */
        }
      }
      for (const entry of builds.values()) {
        try {
          entry.handle.terminate();
        } catch {
          /* 已退出 */
        }
      }
    }, 'dsh-devship: stop children on dispose');
  },
};

export default plugin;
