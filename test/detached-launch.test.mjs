import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detachedBatchScript, detachedPowerShellScript, detachedRunnerScript } from '../lib/build.js';

const phases = [
  { label: 'deps', executable: 'C:\\tools\\apache-maven\\bin\\mvn.cmd', args: ['-pl', 'svc-a', '-DskipTests', 'install'], cwd: 'E:\\workspace\\demo', env: { JAVA_HOME: 'C:\\Program Files\\Java\\jdk-17' } },
  { label: 'run', executable: 'C:\\tools\\apache-maven\\bin\\mvn.cmd', args: ['-pl', 'svc-a', 'spring-boot:run'], cwd: 'E:\\workspace\\demo', env: {} },
];

const logPath = 'E:\\w\\.dsh-devship\\logs\\run-x.detached.log';
const batch = detachedBatchScript({ logPath, phases });
const ps1 = detachedPowerShellScript({ pidFile: 'E:\\w\\.dsh-devship\\run-x.pid', cmdFile: 'E:\\w\\.dsh-devship\\run-x-detached.cmd', logPath });

test('脱离启动链：阶段按顺序跑，任何一段非零退出就整体退出', () => {
  const lines = batch.split('\r\n');
  const deps = lines.findIndex((line) => line.includes('"-pl" "svc-a" "-DskipTests" "install"'));
  const run = lines.findIndex((line) => line.includes('"spring-boot:run"'));
  assert.ok(deps !== -1 && run !== -1 && deps < run, batch);
  assert.ok(lines[deps + 1].includes('phase-failed: deps') && lines[deps + 1].includes('exit /b 1'), lines[deps + 1]);
  assert.ok(lines[run + 1].includes('phase-failed: run') && lines[run + 1].includes('exit /b 1'), lines[run + 1]);
  assert.ok(batch.includes('cd /d "E:\\workspace\\demo"'));
  assert.ok(batch.includes('set "JAVA_HOME=C:\\Program Files\\Java\\jdk-17"'));
  assert.ok(batch.includes(`>> "${logPath}" 2>&1`));
});

test('脱离启动链：只用 ASCII，cmd.exe 按 OEM 代码页解析批处理也不会出问题', () => {
  assert.match(batch, /^[\x20-\x7e\r\n]+$/u);
});

test('脱离启动链：路径里的双引号按 cmd 规则翻倍', () => {
  const text = detachedBatchScript({ logPath: 'C:\\a"b.log', phases: [{ label: 'run', executable: 'C:\\x"y\\node.exe', args: [], cwd: 'C:\\' }] });
  assert.ok(text.includes('call "C:\\x""y\\node.exe"  >> "C:\\a""b.log" 2>&1'), text);
});

test('隐藏外壳：第一件事是把自己的 PID 写进 pid 文件，WMI 那边才有得可认领', () => {
  const lines = ps1.split('\r\n');
  assert.ok(lines[0].startsWith('$PID | Set-Content -LiteralPath '), lines[0]);
  assert.ok(lines[0].includes("'E:\\w\\.dsh-devship\\run-x.pid'"), lines[0]);
  assert.ok(lines[1].includes('[dsh-devship] start') && lines[1].includes('yyyy-MM-dd HH:mm:ss'), lines[1]);
  assert.equal(lines[2], "& 'E:\\w\\.dsh-devship\\run-x-detached.cmd'");
  assert.equal(lines[3], 'exit $LASTEXITCODE');
  assert.match(ps1, /^[\x20-\x7e\r\n]+$/u);
});

test('隐藏外壳：路径里的单引号按 PowerShell 规则翻倍', () => {
  const text = detachedPowerShellScript({ pidFile: "C:\\a'b.pid", cmdFile: "C:\\x''y\\run.cmd", logPath: 'C:\\log.txt' });
  assert.ok(text.includes("& 'C:\\x''''y\\run.cmd'"), text);
});

test('隐藏启动器：wscript 用窗口样式 0 起 powershell，路径引号按 VBS 规则翻倍', () => {
  const vbs = detachedRunnerScript({ powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ps1File: 'E:\\w\\.dsh-devship\\run-x-detached.ps1' });
  assert.ok(vbs.includes('CreateObject("WScript.Shell")'), vbs);
  assert.ok(vbs.includes('-WindowStyle Hidden'), vbs);
  assert.ok(vbs.includes(', 0, False'), vbs);
  assert.ok(vbs.includes('-File ""E:\\w\\.dsh-devship\\run-x-detached.ps1""'), vbs);
  assert.match(vbs, /^[\x20-\x7e\r\n]+$/u);
});
