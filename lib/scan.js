/**
 * dsh-devship 工作区发现与项目扫描（Host 半）。
 *
 * 负责三件事：
 *   1) 当前工作区是哪儿（workspaceRegistry → 会话 cwd → 沙箱根 → process.cwd）；
 *   2) 哪些工作区允许被请求指定（白名单 + prefs.extraRoots 逃生口）；
 *   3) 扫出一个工作区里能跑的项目（Maven 模块 / 前端 package.json），以及 mvn / pnpm / JDK 在哪儿。
 *
 * 有状态（扫描缓存、JDK 结果、extraRoots 缓存），所以做成工厂：createScanner(ctx)。
 */
import { readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { createWarn } from './log.js';
import { readPrefs } from './prefs.js';
import { isDirectory, javaMajorOf, isFile, listDirectories, normalizeRootPath, readText } from './util.js';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'target', 'dist', 'build', 'out',
  '.idea', '.image', '.zcode', '.gradle', '.mvn', 'doc', 'docs', 'sql', 'script',
  '.dsh-plugins', '.vscode', 'logs', 'tmp', 'coverage',
]);
/** 扫描结果缓存时长，避免每次轮询都读盘。 */
const SCAN_TTL_MS = 300000;
/** 扫描缓存最多留几个工作区（LRU）。 */
const SCAN_CACHE_MAX = 8;
/** prefs.json 里手写的 extraRoots：读一次缓存 5 秒，免得每次轮询都读盘。 */
const EXTRA_ROOTS_TTL_MS = 5000;

/** 在 Maven 根 pom 的 <modules> 里找模块名（保持声明顺序）。 */
export function pomModules(source) {
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
export async function hasApplicationClass(javaDir) {
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
export function portFromYaml(text) {
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
export async function detectPort(projectDir) {
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
export function toId(root, dir) {
  const rel = dir.slice(root.length).replace(/^[\\/]+/u, '').replace(/\\/gu, '/');
  return rel === '' ? '.' : rel;
}

/** 在若干「一级目录」里按名字找子目录（用于发现 apache-maven-* 之类安装目录）。 */
export async function listDirectoriesNamed(base, pattern) {
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
export async function findMaven(root, override) {
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
export async function findPnpm(root, override) {
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

/** 常见 JDK 安装位置（按平台）：IDEA 下载的在 ~/.jdks；Linux 在 /usr/lib/jvm 和 sdkman；macOS 在 /Library/Java/JavaVirtualMachines。 */
export function jdkRootHints() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  if (process.platform === 'darwin') {
    return [
      () => join(home, '.jdks'),
      () => '/Library/Java/JavaVirtualMachines',
      () => join(home, 'Library', 'Java', 'JavaVirtualMachines'),
      () => '/opt/homebrew/opt',
      () => '/usr/local/opt',
    ];
  }
  if (process.platform === 'win32') {
    return [
      () => join(home, '.jdks'),
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
  }
  return [
    () => join(home, '.jdks'),
    () => '/usr/lib/jvm',
    () => '/usr/java',
    () => '/opt/java',
    () => join(home, '.sdkman', 'candidates', 'java'),
  ];
}

/**
 * 找和目标 Java 版本匹配的 JDK（模仿 IDEA 的 JDK 选择）：
 *   · .dsh-devship.json 的 javaHome 优先；
 *   · JAVA_HOME 版本合适就用；
 *   · 否则在 ~/.jdks（IDEA 下载的 JDK）、常见安装目录里挑主版本匹配的，次选最小的更高版本。
 */
export async function findJdk(major, override) {
  if (typeof override === 'string' && override !== '' && await isFile(join(override, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'))) {
    return override;
  }
  const installed = [];
  for (const hint of jdkRootHints()) {
    const base = hint();
    if (typeof base !== 'string' || base === '') continue;
    for (const dir of await listDirectoriesNamed(base, /jdk|jre|ms-|openjdk|dragonwell|zulu|corretto|semeru|graal/iu)) {
      // macOS 的包是 <name>.jdk/Contents/Home 这层才有 bin/java，版本号还挂在 <name>.jdk 这个名字上
      for (const candidate of [{ dir, name: dir }, { dir: join(dir, 'Contents', 'Home'), name: dir }]) {
        const version = javaMajorOf(candidate.name);
        if (version === undefined) continue;
        if (!(await isFile(join(candidate.dir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')))) continue;
        installed.push({ dir: candidate.dir, version });
      }
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
export async function requiredJavaMajor(root) {
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

/**
 * 工作区发现 + 白名单 + 项目扫描 + 工具定位。
 * @param {object} ctx 插件上下文（要 workspaceRegistry / sessions / sandboxPolicy / subprocess）
 */
export function createScanner(ctx) {
  /** root -> { root, projects, at }：切来切去的多工作区不用来回重扫，最多留最近用的 8 个。 */
  const scanCache = new Map();
  /** root -> 正在跑的扫描（避免同一 root 并发重复扫）。 */
  const scanRunning = new Map();
  let extraRootsCache = { at: 0, roots: [] };
  /** 目标 JDK 的探测结果（同一 root 只找一次）。 */
  let jdkMemo;
  /** 扫描 / 白名单这类「只影响界面」的失败写进 Host 日志，同一类 30 秒最多一条。 */
  const warn = createWarn(ctx);

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

  async function extraAllowedRoots() {
    const now = Date.now();
    if (now - extraRootsCache.at < EXTRA_ROOTS_TTL_MS) return extraRootsCache.roots;
    const prefs = await readPrefs(workspaceRoot()).catch(() => undefined);
    extraRootsCache = { at: now, roots: prefs === undefined ? [] : prefs.extraRoots };
    return extraRootsCache.roots;
  }

  /** 刚改过偏好：让 extraRoots 立刻重新读。 */
  function invalidateExtraRoots() {
    extraRootsCache = { at: 0, roots: [] };
  }

  /**
   * 允许被请求指定的工作区（白名单）：
   * 工作区账目里的路径 + 各会话的 cwd + 沙箱根 + 进程 cwd + prefs.extraRoots。
   */
  async function allowedRoots() {
    const roots = new Set();
    const add = (value) => {
      if (typeof value !== 'string') return;
      const candidate = value.trim();
      if (candidate === '' || !isAbsolute(candidate)) return;
      roots.add(normalizeRootPath(candidate));
    };
    try {
      const registry = ctx.get('workspaceRegistry');
      for (const workspace of registry?.list?.() ?? []) add(workspace?.path);
    } catch {
      /* 账目不可用 */
    }
    try {
      const sessions = ctx.get('sessions');
      for (const session of sessions?.list?.() ?? []) {
        add(session?.header?.cwd);
        add(session?.cwd);
      }
    } catch {
      /* 会话列表不可用 */
    }
    try {
      add(ctx.get('sandboxPolicy')?.workspaceRoot);
    } catch {
      /* 沙箱策略不可用 */
    }
    add(process.cwd());
    for (const extra of await extraAllowedRoots()) add(extra);
    return roots;
  }

  /**
   * 请求带来的工作区路径优先（面板切工作区用的就是它），但只认白名单里的路径；
   * 白名单外的一律回落到 Host 探测出来的当前工作区，免得接口被任意路径牵着走。
   */
  async function effectiveRoot(override) {
    const fallback = workspaceRoot();
    if (typeof override !== 'string') return fallback;
    const candidate = override.trim();
    if (candidate === '' || !isAbsolute(candidate)) return fallback;
    const roots = await allowedRoots();
    if (roots.has(normalizeRootPath(candidate))) return candidate;
    // 静默换目录最容易被当成「面板坏了」：写一条日志，逃生口是 prefs.extraRoots
    warn(`请求的工作区不在白名单，回落到 ${fallback}`, candidate);
    return fallback;
  }

  /** 工作区级配置：.dsh-devship.json 可覆盖 maven / pnpm 的可执行文件路径。 */
  async function workspaceConfig(root) {
    if (typeof root !== 'string' || root === '') return {};
    const text = await readText(join(root, '.dsh-devship.json'));
    if (text === undefined) return {};
    try {
      const value = JSON.parse(text);
      return value !== null && typeof value === 'object' ? value : {};
    } catch (error) {
      warn(`${join(root, '.dsh-devship.json')} 解析失败`, error);
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

  /** 目标 JDK：工作区声明的 Java 版本 → 本机匹配的 JDK（结果缓存）。 */
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

  /**
   * 扫描工作区，返回项目清单（带缓存）。
   * @param {boolean} [force] 忽略缓存重新扫描（面板「刷新」用）
   *
   * 注意：sandbox 下每次 readdir/stat 都有额外开销，整个扫描在真实宿主里可能到几秒，
   * 所以这里缓存 5 分钟；/status 这类高频接口绝不能再触发重新扫描。
   */
  async function scan(root, force) {
    const now = Date.now();
    const hit = scanCache.get(root);
    if (force !== true && hit !== undefined && now - hit.at < SCAN_TTL_MS) {
      // 命中就挪到队尾：留着的总是最近真在用的那几个工作区
      scanCache.delete(root);
      scanCache.set(root, hit);
      return hit;
    }
    if (force !== true) {
      const running = scanRunning.get(root);
      if (running !== undefined) {
        // 已有一次扫描在跑，等它（避免并发重复扫）
        return await running;
      }
    }
    const task = (async () => {
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
      // 广度优先找 package.json（最多 4 层，跳过 node_modules/target/dist 等）。
      // sandbox 下每次 readdir 都有固定开销，第 3 层起只往下钻「可能放前端」的目录名，
      // 否则 大型多模块仓一次扫描要几千次 readdir（实测 9 秒）。
      const NODE_MAX_DEPTH = 4;
      const PROMISING = /^(?:src|main|webapp|web|front|frontend|ui|client|app|apps|modules|packages|admin|pos)$/u;
      const queue = [{ dir: root, depth: 0 }];
      const visitedDirs = new Set([root]);
      while (queue.length > 0) {
        const node = queue.shift();
        if (node.depth >= NODE_MAX_DEPTH) continue;
        for (const child of await listDirectories(node.dir)) {
          if (SKIP_DIRS.has(child) || child.startsWith('.')) continue;
          if (node.depth >= 2 && !PROMISING.test(child)) continue;
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
        // 打包脚本：优先生产构建，其次 build / build:dev（很多前端只有 build:prod 这类带后缀的脚本）
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

      const result = { root, projects, at: Date.now() };
      scanCache.set(root, result);
      while (scanCache.size > SCAN_CACHE_MAX) {
        const oldest = scanCache.keys().next();
        if (oldest.done === true) break;
        scanCache.delete(oldest.value);
      }
      return result;
    })();
    scanRunning.set(root, task);
    try {
      return await task;
    } finally {
      if (scanRunning.get(root) === task) scanRunning.delete(root);
    }
  }

  return {
    scanCache,
    workspaceRoot,
    allowedRoots,
    effectiveRoot,
    invalidateExtraRoots,
    workspaceConfig,
    resolveExecutable,
    resolveJavaHome,
    javaEnv,
    scan,
  };
}
