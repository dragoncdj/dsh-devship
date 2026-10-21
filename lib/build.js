/**
 * dsh-devship 启动 / 停止 / 打包（Host 半）。
 *
 * 进程怎么起：Windows 上 mvn / pnpm 都是 .cmd，Node 不能直接 exec，
 * 所以先生成 .cmd 启动脚本，再由隐藏窗口的 powershell 执行（见 writeLauncher 的注释）。
 * 脱离模式（默认）走 WMI → wscript → 隐藏窗口的 powershell，全程不弹控制台窗口
 * （见 detachedRunnerScript 的注释）。
 * 状态表（processes / builds）与日志落盘来自 lib/state.js，工作区与工具定位来自 lib/scan.js。
 */
import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { appendFile, chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { invalidatePortProbe, portBusy } from './net.js';
import { attachLogFile, killTree, pidAliveAsync, pidByPort, tailOf } from './state.js';
import { isFile, sleep, slug, splitCommandLine } from './util.js';

/** spawn 的 SIGTERM 宽限期。 */
const GRACE_MS = 3000;

const psQuote = (value) => `'${String(value).replace(/'/gu, "''")}'`;
const vbsQuote = (value) => `"${String(value).replace(/"/gu, '""')}"`;

function powershellPath() {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * 脱离模式要跑的 .cmd 启动链（纯函数，方便单测）。
 * 只用 ASCII：cmd.exe 按 OEM 代码页解析批处理，UTF-8 中文会破坏语法。
 * 日志走 cmd 的 >> 追加，字节和以前一样。
 */
export function detachedBatchScript({ logPath, phases }) {
  const quote = (value) => `"${String(value).replace(/"/gu, '""')}"`;
  const lines = ['@echo off'];
  for (const phase of phases) {
    for (const [key, value] of Object.entries(phase.env ?? {})) lines.push(`set "${key}=${String(value).replace(/"/gu, '')}"`);
    lines.push(`cd /d ${quote(phase.cwd)}`);
    lines.push(`call ${quote(phase.executable)} ${phase.args.map(quote).join(' ')} >> ${quote(logPath)} 2>&1`);
    lines.push(`if errorlevel 1 (echo [dsh-devship] phase-failed: ${phase.label} >> ${quote(logPath)} & exit /b 1)`);
  }
  lines.push(`echo [dsh-devship] exited >> ${quote(logPath)}`, '');
  return lines.join('\r\n');
}

/**
 * 脱离模式的 .ps1 内容（纯函数，方便单测）。
 * 它只做三件事：先把自己的 PID 写进 pid 文件（WMI 只认得 wscript，真正要跟踪的进程靠这个文件认领），
 * 再写一行 ASCII 的启动标记（cmd 的 %DATE% 带中文星期，按 OEM 代码页写进日志会变成乱码），
 * 最后调用上面那个 .cmd。日志、环境变量、失败判定仍由 cmd 负责，行为跟以前一致。
 */
export function detachedPowerShellScript({ pidFile, cmdFile, logPath }) {
  return [
    `$PID | Set-Content -LiteralPath ${psQuote(pidFile)} -NoNewline -Encoding ASCII`,
    `Add-Content -LiteralPath ${psQuote(logPath)} ('[dsh-devship] start ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))`,
    `& ${psQuote(cmdFile)}`,
    'exit $LASTEXITCODE',
    '',
  ].join('\r\n');
}

/**
 * 脱离模式的 .vbs 内容（纯函数，方便单测）。
 * wscript 自己没有控制台，Run 的窗口样式 0 = 隐藏，所以被它拉起来的 powershell
 * 从出生起就没有窗口；旧写法让 WMI 直接起 cmd.exe，那个黑窗口就是这么来的。
 */
export function detachedRunnerScript({ powershell, ps1File }) {
  const command = `${powershell} -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ${vbsQuote(ps1File)}`;
  return [
    "' dsh-devship detached runner: start the launcher without a window",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run ${vbsQuote(command)}, 0, False`,
    '',
  ].join('\r\n');
}

/** 轮询 pid 文件：脱离模式的进程自己写，写出来才算真的起来了。 */
async function readPidFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pid = Number((await readFile(file, 'utf8').catch(() => '')).trim());
    if (Number.isInteger(pid) && pid > 0) return pid;
    if (Date.now() >= deadline) return undefined;
    await sleep(200);
  }
}

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
  const powershell = powershellPath();
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

/**
 * 启动 / 停止 / 打包。
 * @param {object} ctx 插件上下文（要 subprocess）
 * @param {object} deps lib/state.js 与 lib/scan.js 提供的状态与工作区能力
 */
export function createBuild(ctx, deps) {
  const { builds, cancelTask, clearAutoClearTimer, forgetRun, isLiveEntry, javaEnv, processes, rememberRun, resolveExecutable, scan, scheduleAutoClear } = deps;

  function launcherDir(root) {
    return join(root, '.dsh-devship');
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

    /** 让 WMI 起一个进程（父进程是系统服务，DSH 退出不会带走它）。成功返回 ProcessId。 */
    const wmiCreate = async (commandLine) => {
      const script = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${commandLine.replace(/'/gu, "''")}' }; if ($r.ReturnValue -eq 0) { $r.ProcessId } else { "RET " + $r.ReturnValue }`;
      const outcome = await new Promise((resolve) => {
        execFile(powershellPath(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 30000 }, (error, out, err) => resolve({ error, out: String(out ?? ''), err: String(err ?? '') }));
      });
      const text = outcome.out.trim();
      const pid = Number(text.split(/\r?\n/u).pop());
      return {
        pid: Number.isInteger(pid) && pid > 0 ? pid : undefined,
        detail: outcome.error === null || outcome.error === undefined
          ? `stdout=${text} stderr=${outcome.err.trim()}`
          : `${outcome.error.message} | stderr=${outcome.err.trim()}`,
      };
    };

    /**
     * 脱离模式：启动链仍写进一个 .cmd（日志、环境变量、失败判定都照旧），
     * 外面套一层 .ps1 只负责认领 PID，再由 WMI 起 wscript，wscript 隐藏窗口起 powershell。
     * 全程没有窗口：WMI 起的 wscript 没有控制台，Run(..., 0, ...) 让 powershell 出生就是隐藏的，
     * 它的 cmd 子进程也跟着隐藏——旧写法让 WMI 直接起 cmd.exe，那个黑窗口就是这么来的。
     * 真正要跟踪的进程是那个 powershell，pid 文件由它自己写，这里轮询认领。
     */
    const startDetached = async (phases) => {
      const base = `run-${slug(project.id)}`;
      const dir = launcherDir(root);
      await mkdir(dir, { recursive: true });
      await mkdir(join(dir, 'logs'), { recursive: true }).catch(() => {});
      const cmdFile = join(dir, `${base}-detached.cmd`);
      const ps1File = join(dir, `${base}-detached.ps1`);
      const vbsFile = join(dir, `${base}-detached.vbs`);
      const pidFile = join(dir, `${base}-detached.pid`);
      const logPath = join(dir, 'logs', `${base}.detached.log`);
      await writeFile(cmdFile, detachedBatchScript({ logPath, phases }), 'utf8');
      await writeFile(ps1File, detachedPowerShellScript({ pidFile, cmdFile, logPath }), 'utf8');
      await writeFile(vbsFile, detachedRunnerScript({ powershell: powershellPath(), ps1File }), 'utf8');
      // 不要截断日志：上一轮进程可能还开着它（EBUSY），追加写即可
      await appendFile(logPath, '', 'utf8').catch(() => {});
      // 旧的 pid 文件必须先清掉，否则会把上一轮的进程当成这一次的
      await rm(pidFile, { force: true }).catch(() => {});
      // 起点要在起进程之前量：之后写的都是这一轮的输出，一行都不能漏
      const logStartOffset = await stat(logPath).then((info) => info.size).catch(() => 0);
      const wscript = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe');
      let created = await wmiCreate(`${vbsQuote(wscript)} //Nologo ${vbsQuote(vbsFile)}`);
      let via = 'wscript';
      if (created.pid === undefined) {
        // WSH 被策略关掉时退回直接起 powershell：-WindowStyle Hidden 同样没有窗口，只是少了一层 wscript 兜底
        via = 'powershell';
        created = await wmiCreate(`${vbsQuote(powershellPath())} -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ${vbsQuote(ps1File)}`);
      }
      const pid = created.pid === undefined ? undefined : await readPidFile(pidFile, 8000);
      return { pid, logPath, logStartOffset, via, detail: created.detail };
    };

    /** 脱离模式：WMI → wscript → 隐藏窗口的 powershell，之后只靠 pid + 日志文件跟踪。 */
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
        // 起点是起进程之前量到的日志大小：上一轮的输出不算进来，这一轮的一行都不漏
        entry.logOffset = started.logStartOffset;
        entry.phase = 'run';
        if (started.pid === undefined) {
          entry.state = 'failed';
          entry.error = `隐藏启动失败（${started.via}）：${started.detail}`;
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
          // 否则聚合壳模块运行时看不到子模块里的 Bean。
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
    // 端口状态马上要变：别让 /status 拿几秒前的旧答案说「还在跑」
    invalidatePortProbe(entry.port);
    // 脱离模式：有 pid 就整棵树结束；没有 pid（接管时只有端口）就按端口找
    if (entry.detached === true || entry.adopted === true) {
      entry.state = 'stopping';
      const pid = Number.isInteger(entry.pid) && await pidAliveAsync(entry.pid) === true
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
      invalidatePortProbe(entry.port);
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
    invalidatePortProbe(entry.port);
    entry.state = 'stopped';
    tailOf(entry);
    await forgetRun(root, projectId);
    return entry;
  }

  /** 记住「谁在跑」，DSH 重启后靠它把状态接管回来。 */
  /**
   * 清除任务条目（单个「清除」和「一键清除」共用）。
   * 运行中的任务会先中断再移除；没有 force 时只返回 needsConfirm，不动任何任务。
   */
  async function clearTasks(ids, force, root) {
    const targets = [];
    const seenIds = new Set();
    for (const id of ids) {
      if (typeof id !== 'string' || id === '' || seenIds.has(id)) continue;
      seenIds.add(id);
      const build = builds.get(id);
      if (build !== undefined) targets.push({ kind: 'build', entry: build });
      const run = processes.get(id);
      if (run !== undefined) targets.push({ kind: 'run', entry: run });
    }
    const live = targets.filter((target) => isLiveEntry(target.entry));
    if (live.length > 0 && force !== true) {
      return {
        ok: false,
        needsConfirm: true,
        running: live.map((target) => ({ id: target.entry.id, name: target.entry.name })),
      };
    }
    let interrupted = 0;
    for (const target of targets) {
      if (!isLiveEntry(target.entry)) continue;
      interrupted += 1;
      if (target.kind === 'run') {
        try {
          await stop(target.entry.id, root);
        } catch {
          // 停止失败也要把条目清掉，否则它会永远卡在列表里
          processes.delete(target.entry.id);
          await forgetRun(root, target.entry.id);
        }
      } else {
        await cancelTask(target.entry);
      }
    }
    for (const target of targets) {
      if (target.kind === 'run') {
        processes.delete(target.entry.id);
        await forgetRun(root, target.entry.id);
      } else {
        clearAutoClearTimer(target.entry.id);
        builds.delete(target.entry.id);
      }
    }
    return { ok: true, cleared: targets.length, interrupted };
  }

  /** 记录一个打包任务的收尾状态（Maven / pnpm 共用）。 */
  function trackBuild(entry, root) {
    const done = entry.handle.done;
    if (done !== undefined && typeof done.then === 'function') {
      done.then((result) => {
        entry.state = entry.cancelRequested === true ? 'stopped' : result?.exitCode === 0 ? 'success' : 'failed';
        entry.exitCode = result?.exitCode;
        tailOf(entry);
        void scheduleAutoClear(entry, root);
      }, (error) => {
        entry.state = entry.cancelRequested === true ? 'stopped' : 'failed';
        if (entry.cancelRequested !== true) entry.error = error instanceof Error ? error.message : String(error);
        void scheduleAutoClear(entry, root);
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
    clearAutoClearTimer(key);
    builds.set(key, entry);
    await attachLogFile(entry, root, key);
    return trackBuild(entry, root);
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
    clearAutoClearTimer(key);
    builds.set(key, entry);
    await attachLogFile(entry, root, key);
    return trackBuild(entry, root);
  }

  return { launcherDir, launch, stop, clearTasks, build, buildNode };
}
