/**
 * dsh-devship 部署与发布（Host 半）。
 *
 * 部署 = 找到打包产物 → SFTP 上传到 deploy.json 里配置的远端目录 →（可选）重启 docker 容器；
 * 发布 = 打包 + 部署 + 重启串成一条任务。
 * SSH 主机复用 dsh-ssh 的配置（~/.dsh/dsh-ssh.json），ssh2 按插件依赖 → profile 目录的顺序解析。
 */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { listFilesDeep } from './fs-scan.js';
import { readDeployConfig, readSshHosts } from './prefs.js';
import { createUploadProgress, formatBytes, formatSpeed } from './progress.js';
import { appendLog, attachLogFile, publicEntry } from './state.js';
import { isDirectory, isFile, readText, shellQuote, sleep } from './util.js';

function loadSsh2() {
  const profile = process.env.DSH_PROFILE ?? 'desktop';
  const candidates = [{ label: '插件自身依赖', from: import.meta.url }];
  if (typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR !== '') {
    candidates.push({ label: `DSH_PROFILE_DIR（${process.env.DSH_PROFILE_DIR}）`, from: join(process.env.DSH_PROFILE_DIR, 'package.json') });
  }
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');
  candidates.push({ label: `profile「${profile}」`, from: join(home, 'profiles', profile, 'package.json') });
  let lastError;
  for (const candidate of candidates) {
    try {
      const require = createRequire(candidate.from);
      return require('ssh2');
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `部署需要 ssh2，但这几处都没找到：${candidates.map((candidate) => candidate.label).join('、')}。`
    + '在插件目录跑一次 npm install（ssh2 是 optionalDependencies），或启用 dsh-ssh 插件让它带一份。'
    + `原始错误：${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
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

/**
 * 上传一个文件。ssh2 的 fastPut 带 step 回调（总字节, 已传字节），进度就靠它。
 * @param {(totalBytes: number, transferred: number) => void} [onStep] 上传进度回调
 */
function sftpPut(sftp, local, remote, onStep) {
  return new Promise((resolve, reject) => {
    const options = typeof onStep === 'function'
      ? { step: (totalBytes, transferred) => onStep(totalBytes, transferred) }
      : {};
    sftp.fastPut(local, remote, options, (error) => (error === undefined || error === null ? resolve() : reject(error)));
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

/**
 * 带进度地上传一个文件：beginFile → stepFile（ssh2 的 step 回调）→ endFile。
 * 失败时不走 endFile，进度就停在断掉的地方，不会把没传完的文件算成已传。
 * @param {number} key 这个文件在进度器里的槽位（并发上传各占一格）
 */
async function putWithProgress(sftp, local, remote, progress, key, size) {
  if (progress === undefined || progress === null) {
    await sftpPut(sftp, local, remote);
    return;
  }
  progress.beginFile(key, size);
  await sftpPut(sftp, local, remote, (_totalBytes, transferred) => progress.stepFile(key, transferred));
  progress.endFile(key);
}

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

/**
 * 真正执行一次上传：连 SSH（或复用会话）→ 建目录 → SFTP 上传（单个文件或整个目录）。
 * 进度通过 `progress`（lib/progress.js 的进度器）汇报：总量、已传、百分比、速度。
 * @param {object} [session] 可复用的 SSH 会话（批量部署时共用一条连接）
 * @param {ReturnType<typeof createUploadProgress>} [progress] 上传进度器
 * @returns {Promise<{files: number, bytes: number, remote: string}>}
 */
async function uploadArtifact({ project, target, config, artifact, log, session, progress, onClient, isCancelled }) {
  const reusable = session !== undefined && session !== null;
  let client = reusable ? session.client : undefined;
  let sftp = reusable ? session.sftp : undefined;
  if (!reusable) {
    const opened = await openSshSession(config, log);
    client = opened.client;
    sftp = opened.sftp;
    onClient?.(client);
  }
  const checkCancelled = () => {
    if (typeof isCancelled === 'function' && isCancelled() === true) throw new Error('已取消');
  };
  try {
    checkCancelled();
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
      progress?.setTotal(bytes);
      log(`目录 ${project.name}：${files} 个文件，共 ${formatBytes(bytes)}`);

      // 首选：本地打 tar（不压缩，局域网带宽足，比 gzip 快）→ 单文件上传 → 远端解包
      let packed = false;
      const archive = join(artifact, '..', `.dsh-devship-${Date.now()}.tar`);
      try {
        log('本地打包 tar …');
        await tarDirectory(artifact, archive);
        const size = (await stat(archive)).size;
        const remoteArchive = `/tmp/dsh-devship-${Date.now()}.tar`;
        // tar 的大小和目录里文件合计不完全一致，进度按真正要传的那个算
        progress?.setTotal(size);
        log(`上传 ${formatBytes(size)} 包 → ${remoteArchive}`);
        await putWithProgress(sftp, archive, remoteArchive, progress, 0, size);
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
        // tar 没走通：总量回到真正要逐个传的那些文件上
        progress?.setTotal(bytes);
        // 兜底：并发 SFTP（8 路），不逐个打日志
        const CONCURRENCY = 8;
        const dirs = new Set([remote]);
        let next = 0;
        let done = 0;
        const worker = async () => {
          while (next < list.length) {
            checkCancelled();
            const index = next;
            const file = list[next];
            next += 1;
            const remoteFile = remoteJoin(remote, file.rel);
            const dir = remoteFile.slice(0, remoteFile.lastIndexOf('/'));
            if (!dirs.has(dir)) {
              dirs.add(dir);
              await sshExec(client, `mkdir -p ${shellQuote(dir)}`);
            }
            await putWithProgress(sftp, file.abs, remoteFile, progress, index, file.size);
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
      progress?.setTotal(info.size);
      log(`上传文件 ${project.name} → ${remote} (${formatBytes(info.size)})`);
      await putWithProgress(sftp, artifact, remote, progress, 0, info.size);
      files = 1;
      bytes = info.size;
    }
    checkCancelled();
    log(`部署完成：${files} 个文件，${formatBytes(bytes)}`);

    // 部署完重启容器（配置了 container 才做），然后校验容器状态
    const container = typeof target.container === 'string' ? target.container.trim() : '';
    let containerStatus;
    if (container !== '') {
      // 容器名要进远端 shell：一律单引号包住，名字里带空格 / $ / ; 也不会变成另一条命令
      const quotedContainer = shellQuote(container);
      const template = typeof config.restartCommand === 'string' && config.restartCommand.trim() !== ''
        ? config.restartCommand.trim()
        : 'docker restart {container}';
      const command = template.includes('{container}')
        ? template.replace(/\{container\}/gu, quotedContainer)
        : `${template} ${quotedContainer}`;
      log(`重启容器 ${container}：${command}`);
      await sshExec(client, command);
      log(`容器 ${container} 已重启，校验状态 …`);
      containerStatus = (await sshExecCapture(client, `docker ps --filter name=^/${quotedContainer}$ --format '{{.Status}}'`)).trim();
      if (containerStatus === '') {
        const logs = (await sshExecCapture(client, `docker logs --tail 20 ${quotedContainer} 2>&1 | tail -20`)).trim();
        throw new Error(`容器 ${container} 重启后不在运行列表里。最近日志：\n${logs}`);
      }
      log(`容器状态：${containerStatus}`);
    }
    return { files, bytes, remote, container: container === '' ? undefined : container, containerStatus };
  } finally {
    if (!reusable) {
      try { client.end(); } catch { /* 取消时连接可能已经断开 */ }
    }
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

/**
 * 部署 / 发布任务。
 * @param {object} ctx 插件上下文
 * @param {object} deps lib/state.js 与 lib/build.js 提供的状态与打包能力
 */
export function createDeploy(ctx, deps) {
  const { build, buildNode, builds, cancelTask, clearAutoClearTimer, scheduleAutoClear } = deps;

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
    clearAutoClearTimer(key);
    builds.set(key, entry);
    await attachLogFile(entry, root, key);
    const log = (line) => {
      appendLog(entry, `${new Date().toLocaleTimeString()} ${line}\n`);
    };
    // 上传进度：每 0.5 秒刷一次 entry.progress（面板画进度条用），日志里 2 秒记一条，传完一定记
    let lastProgressLogAt = 0;
    const progress = createUploadProgress(0, {
      tickMs: 500,
      onTick: (value) => {
        entry.progress = value;
        const at = Date.now();
        if (value.percent < 100 && at - lastProgressLogAt < 2000) return;
        lastProgressLogAt = at;
        log(`↑ ${value.percent}% ${formatBytes(value.uploaded)} / ${formatBytes(value.total)} · ${formatSpeed(value.bytesPerSecond)}`);
      },
    });
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
        if (entry.cancelRequested === true) {
          entry.state = 'stopped';
          return;
        }
        const result = await uploadArtifact({
          project,
          target,
          config,
          artifact,
          log,
          session,
          progress,
          onClient: (client) => {
            entry.client = client;
            if (entry.cancelRequested === true) {
              try { client.end(); } catch { /* 已断开 */ }
            }
          },
          isCancelled: () => entry.cancelRequested === true,
        });
        if (entry.cancelRequested === true) {
          entry.state = 'stopped';
          return;
        }
        entry.state = 'success';
        entry.remote = result.remote;
        if (result.containerStatus !== undefined) entry.containerStatus = result.containerStatus;
      } catch (error) {
        if (entry.cancelRequested === true) {
          entry.state = 'stopped';
          return;
        }
        entry.state = 'failed';
        entry.error = error instanceof Error ? error.message : String(error);
        log(`✗ 失败：${entry.error}`);
      } finally {
        // 收尾后按偏好决定是否自动清除这条（失败不会被清）
        void scheduleAutoClear(entry, root);
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
      if (parent !== undefined) {
        // 子任务的上传进度直接搬到父条目上，「发布」那张卡也能看到进度条
        if (entry.progress !== undefined) parent.progress = entry.progress;
        if (tail.length > copied) {
          appendLog(parent, tail.slice(copied));
          copied = tail.length;
        }
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
    clearAutoClearTimer(key);
    builds.set(key, entry);
    await attachLogFile(entry, root, key);
    const log = (line) => {
      appendLog(entry, `${new Date().toLocaleTimeString()} ${line}\n`);
    };
    void (async () => {
      try {
        if (entry.cancelRequested === true) {
          entry.state = 'stopped';
          log('已取消');
          return;
        }
        log(`① 打包${options?.fast === true ? '（快速，不带 -am）' : ''}${options?.clean === true ? ' +clean' : ''} …`);
        const buildEntry = project.kind === 'node'
          ? await buildNode(project, root)
          : await build(project.modulePath, options?.clean === true, root, options?.fast === true);
        entry.childId = buildEntry.id;
        if (entry.cancelRequested === true) {
          await cancelTask(buildEntry);
          entry.state = 'stopped';
          log('已取消');
          return;
        }
        await waitEntry(buildEntry, 40 * 60_000, log, entry);
        if (entry.cancelRequested === true) {
          entry.state = 'stopped';
          log('已取消');
          return;
        }
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
        entry.childId = deployEntry.id;
        if (entry.cancelRequested === true) {
          await cancelTask(deployEntry);
          entry.state = 'stopped';
          log('已取消');
          return;
        }
        await waitEntry(deployEntry, 40 * 60_000, log, entry);
        if (entry.cancelRequested === true) {
          entry.state = 'stopped';
          log('已取消');
          return;
        }
        if (deployEntry.state !== 'success') {
          entry.state = 'failed';
          entry.error = `部署失败：${String(deployEntry.error ?? '见日志')}`;
          log(`✗ ${entry.error}`);
          return;
        }
        entry.childId = undefined;
        entry.state = 'success';
        entry.containerStatus = deployEntry.containerStatus;
        log('✔ 发布完成');
      } catch (error) {
        if (entry.cancelRequested === true) {
          entry.state = 'stopped';
          log('已取消');
          return;
        }
        entry.state = 'failed';
        entry.error = error instanceof Error ? error.message : String(error);
        log(`✗ ${entry.error}`);
      } finally {
        // 收尾后按偏好决定是否自动清除这条（失败不会被清）
        void scheduleAutoClear(entry, root);
      }
    })();
    return entry;
  }

  /**
   * @param {string} root
   * @param {string} [logFor] 面板当前只渲染一个任务的日志：
   *   给了 id 就只回那一条的 tail；给空串表示「这轮一条都不要」；没这个字段（老客户端）就照旧全给。
   *   7 个服务 × 8k 字符 ≈ 每轮 60KB 白跑。
   */

  return { deployProject, waitEntry, releaseProject };
}
