# Changelog

## 2.1.2

- **Fix**: 走 HTTPS 从局域网访问时页面反复「重新连接中 → 连接成功」——面板轮询以前是「到点就发」，上一条 `/status` 还没回来下一条就发出去了，Host 一慢就堆成 3 条 4 条请求。浏览器对同一个源最多开 6 条 HTTP/1.1 连接，面板把连接占满之后，DSH 自己的接口（`/api/...`，同源）只能排队，连接生成超过 15 秒就被客户端判超时、取消这一代连接重连。现在一轮只允许一条请求在路上（上一跳没回来就跳过），每条带 9 秒超时，连着失败按 2.5 → 5 → 10 → 15 秒退避，浏览器标签页在后台时不轮询、回到前台立刻补一次
- **Perf**: `/status` 的 pid 判活从「每个脱离进程单独 spawn 一次 `tasklist`」改成「一轮只 spawn 一次、一次问全部」，并且和端口探测同时进行（以前是探测完再一条条串行判活）。7 个服务以前每轮 7 次 CreateProcess，宿主事件循环被堵住，插件面板和 DSH 自己的接口一起变慢
- **Internal**: `post()` 失败不再往外抛（以前定时器里的 `refreshStatus()` 抛出去就是一条 unhandled rejection），统一收成 `{ok:false,error}`；`/list`、`/status` 的超时和断线在界面上显示本地文案，不再把 `network` / `timeout` 这种英文代码丢给用户
- **Internal**: 有文件正在上传时轮询从 0.9 秒调到 1.2 秒（有了「一轮一条」之后进度照样跟得上，占的连接更少）
- **Tests**: 新增 [test/pid-alive.test.mjs](test/pid-alive.test.mjs)（`tasklist /FO CSV` 解析、批量口径与单条入口一致、非法 pid 不占用查询）；全套 77 项

## 2.1.1

- **Fix**: 启动服务不再弹 cmd.exe 黑窗口。脱离模式（默认）以前是 WMI 直接起 `cmd.exe /d /c run-*.cmd`，服务跑着的时候桌面上就一直挂着一个 cmd 窗口（实测那个进程 `MainWindowHandle` 非 0、标题正是 `C:\WINDOWS\system32\cmd.exe`）。现在改成 WMI 起没有控制台的 `wscript.exe`，它用 `WScript.Shell.Run(..., 0, False)`（窗口样式 0 = 隐藏）起 powershell，powershell 再跑原来那个 `.cmd`——实测真正在跑的 powershell `MainWindowHandle=0`、标题为空，全程没有窗口
- **Internal**: 脱离模式多出两个文件：`run-<项目>-detached.ps1`（第一行把自己的 PID 写进 `run-<项目>-detached.pid`，然后调用 `.cmd`）和 `run-<项目>-detached.vbs`（隐藏启动器）。`.cmd` 本身、日志重定向、环境变量、失败判定都没动，日志字节和以前一致；停止仍是 `taskkill /T /F` 整棵树
- **Internal**: WSH 被策略关掉时退回 WMI 直接起 powershell（`-WindowStyle Hidden`，实测同样没有窗口）；两条路都拿不到 pid 才报错，错误文案带上是哪条路失败：`隐藏启动失败（wscript）：…`
- **Internal**: 日志起点改成「起进程之前量到的日志大小」。原来是等 pid 文件写出来之后才量，这一轮头一两秒的输出会被当成上一轮的跳过
- **Internal**: 日志里的启动标记从 cmd 的 `%DATE% %TIME%` 换成 powershell 的 `Get-Date -Format 'yyyy-MM-dd HH:mm:ss'`——`%DATE%` 带中文星期，按 OEM 代码页写进日志、再按 UTF-8 读就是乱码
- **Tests**: 新增 [test/detached-launch.test.mjs](test/detached-launch.test.mjs)（启动链顺序与「非零就整体退出」、cmd / PowerShell / VBS 三种引号规则、pid 文件认领、隐藏启动器参数、脚本纯 ASCII）；全套 72 项

## 2.1.0

- **UI**: 部署 / 发布任务卡上多了一条上传进度：进度条 + 百分比 + 「已传 / 总量」+ 实时速度（按最近 5 秒算，不是整轮平均，传得越来越快时不会显示成一个偏低的速度）
- **UI**: 日志里每 2 秒记一行 `↑ 42% 12.3 MB / 29.1 MB · 4.8 MB/s`，文件传完那一次一定会记，最后一段进度不会丢
- **API**: `/status` 的条目新增可选字段 `progress: { uploaded, total, percent, bytesPerSecond }`——只有正在部署 / 发布的任务带，其它任务照旧没有这个字段
- **Perf**: 有任务正在上传时面板轮询从 2.5 秒改成 0.9 秒，进度条和速度才跟得上；没有上传时照旧 2.5 秒
- **Internal**: 新增 [lib/progress.js](lib/progress.js)（纯计算、不碰网络）：把 ssh2 `fastPut` 的 `step(总字节, 已传字节)` 回调接成 `beginFile / stepFile / endFile`；兜底的 8 路并发 SFTP 每个文件各占一格，互不干扰；快照 0.5 秒最多回一次，免得 SFTP 每几 KB 回调一次把日志刷爆。tar 单文件、逐文件并发、单个 fat-jar 三条上传路径都接上了
- **Tests**: 新增 `test/progress.test.mjs`（百分比、并发槽位、节流、总量后补、非法输入不飞、速度窗口、字节与速度格式化）；全套 66 项

## 2.0.0

- **Internal**: 架构拆分——[index.js](index.js) 从 2709 行降到 60 行，只剩「装配 + 注册路由 + 退出收尾」，实现各归各的模块：
  [lib/state.js](lib/state.js) 进程表 / 任务表 / 日志落盘 / pid 判活 / state.json / 自动清除，
  [lib/scan.js](lib/scan.js) 工作区发现 / 根目录白名单 / 项目扫描 / mvn·pnpm·JDK 定位，
  [lib/build.js](lib/build.js) 启动脚本生成 / 启动 / 停止 / 打包 / 一键清除，
  [lib/deploy.js](lib/deploy.js) SSH 会话 / SFTP 上传 / 部署 / 发布，
  [routes.js](routes.js) 全部同源路由。依赖是单向的（state → scan → build → deploy → routes），没有循环 import
- **API**: 20 条路由的路径与响应结构逐字节保持不变；`test/routes.test.mjs` 里加了路径清单断言，改路由必须同步改 client.js 才能过测试
- **Internal**: 协议版本只有一个来源——[routes.js](routes.js) 的 `PROTOCOL = 4`，`/version` 的 `version` 与 `/diagnostics` 的 `code` 都由它生成（以前分别硬编码 `'3'` 和 `'dsh-devship/2'`；客户端不读这两个字段，只用于排查）
- **Internal**: 新增 [lib/log.js](lib/log.js) 的 `createWarn(ctx)`：端口探测失败、DSH 重启后接管已有进程失败、请求的 `root` 不在白名单（静默回落到当前工作区）、`.dsh-devship.json` 解析失败——这几类以前只在界面上表现为「未知 / 没反应」的失败现在会写进 Host 日志，同一类 30 秒最多一条；DSH 没提供 logger 时它是空操作，不影响功能
- **Internal**: `package.json` 的 `files` 与 `exports` 补上 `routes.js` 和 `lib/log.js`（漏了会打出装不上的包）
- **Tests**: 新增 `test/scan.test.mjs`（扫描结果字段逐项对齐、缓存与并发去重、`force` 重扫、根目录白名单与 `extraRoots` 逃生口、`.dsh-devship.json` 覆盖 mvn / javaHome）、`test/log.test.mjs`；全套 58 项
- **Docs**: [index.js](index.js) 顶部改成模块地图，说明每块实现在哪个文件里

## 1.4.0

- **Perf**: 工作区扫描缓存改成「按根目录的 Map + 最近 8 个」——原来只缓存一个根目录，来回切工作区就得整轮重扫；同一根目录的并发扫描共用一次结果
- **Perf**: 端口占用探测加 3 秒结果缓存（上限 64 个端口），启动 / 停止两侧立刻作废缓存；`/status` 每 2.5 秒一轮不再每个项目都 `connect` 一次
- **Perf**: pid 判活去掉同步 `execFileSync('tasklist')` 那条路径，统一走异步 + 4 秒缓存（上限 128 条，超了按插入顺序淘汰）；顺带删掉从没被调用过的 `pidAliveFromFile`
- **Perf**: `/status` 只回面板当前选中那条任务的 `tail`（请求带 `logFor`：某个 id / 空串 = 这轮一条都不要 / 不带这个字段 = 照旧全给，老客户端兼容）；日志采集与落盘照旧不受影响，一轮能少 ~60KB
- **Perf**: `pruneLogs` 与 `listFilesDeep` 的 `stat` / `unlink` 改成 32 个一批并发；`listFilesDeep` 深度封顶 20 层，并跳过 `.git` / `.svn` / `.idea` / `__pycache__`
- **Internal**: `pruneLogs` / `listFilesDeep` 移到 [lib/fs-scan.js](lib/fs-scan.js)，端口探测移到 [lib/net.js](lib/net.js)（`package.json` 的 `files` 与 `exports` 已覆盖 `lib/*.js`）
- **UI**: 清除运行中任务的确认不再弹系统对话框，改成就地「确认清除？会中断任务」+ 是 / 否，3 秒不点自动收回；Host 侧的 `needsConfirm` 也走同一套就地确认
- **UI**: 开了自动清除的任务在状态后面显示「N 秒后收起」倒计时（`/status` 的条目新增 `clearAt`）
- **Fix**: JDK 常见安装目录按平台给——Windows 走 `Program Files` 系列，macOS 走 `/Library/Java/JavaVirtualMachines`（含 `Contents/Home` 那一层），Linux 走 `/usr/lib/jvm` 与 sdkman；不再在非 Windows 机器上扫 Windows 路径
- **Tests**: 新增 `test/net.test.mjs`、`test/fs-scan.test.mjs`、`test/entry.test.mjs`；全套 44 项

## 1.3.0

- **Security**: `root` 参数改白名单——只接受 DSH 认得的工作区（`workspaceRegistry` 里的路径、会话表头 `cwd`、沙箱 `workspaceRoot`、`process.cwd()`）加上 `prefs.json` 里 `extraRoots` 显列的目录；名单外的 `root`（含相对路径、空串）一律回落到当前工作区，不再越界读写别的目录
- **Security**: 部署密码不再回传浏览器——`/deploy-config` 只回 `hasPassword`（存没存过）。面板保存时密码留空 = 保持 Host 上已存的值；要删掉得点「清除已存密码」（请求带 `clearPassword: true`），`restartCommand` 同理（`clearRestartCommand`）
- **Security**: 容器名进远端 shell 前统一 `shellQuote`（`docker restart` / `docker ps --filter` / `docker logs`），名字里带空格、`$`、`;` 也只会是一个容器名
- **Deps**: `ssh2` 改为 `optionalDependencies`，插件目录 `npm install` 就能用部署；找不到时错误里说清试了哪几处、怎么补
- **Perf**: `/log` 改为只读文件尾部（`fs.open` + 偏移读 3MB），几百 MB 的日志不再整文件读进内存；响应字段不变，客户端无需改
- **Tests**: 新增 `test/routes.test.mjs`——用假 ctx 把 `apply()` 跑起来直接调路由，覆盖密码合并语义与 `root` 白名单；全套 33 项

## 1.2.0

- **New**: 「完成自动清除」配置——打包 / 部署 / 发布三类任务各一个开关，跑完（成功或已停止）后按设定的延迟（立即 / 5 / 15 / 30 / 60 秒）自动从「执行任务」列表里移除；日志文件照常落盘保留，随时能翻
- **New**: `POST /prefs`（不带 `autoClear` 字段 = 读取，带 = 校验后写入）；`/list` 一并返回 `autoClear`；偏好存在 `<工作区>/.dsh-devship/prefs.json` 的 `autoClear` 字段
- **Behavior**: 开关刚打开时，已经跑完的同类任务立刻清掉一轮；**失败的任务不会自动清除**，避免错误信息跟着条目一起消失（仍可手动 / 一键清除）
- **Fix**: 自动清除在 Host 侧计时，面板关掉也生效；同一 key 重新开跑会先撤掉上一轮的定时器，且删除前核对条目身份，不会误删新一轮任务

## 1.1.1

- **UI**: 「执行任务」列表新增「一键清除」，一次清掉所有打包 / 部署 / 发布记录（单个「清除」也走同一套逻辑）
- **Fix**: 以前清除运行中的任务只是把条目从列表里删掉，进程 / 上传还在后台跑且失去管理；现在先确认「确定清除运行中的任务？清除将中断此任务。」，确认后终止子进程、断开 SSH 上传、递归中断发布中的子任务，再移除条目
- **API**: 新增 `/clear-tasks`（`ids` + `force`）；`/forget` 复用同一实现，未确认运行中任务时返回 `needsConfirm`

## 1.1.0

- **Perf**: `/status` no longer re-scans the workspace and no longer blocks the host event loop
  - pid liveness checks are async with a 4s cache (was one synchronous `tasklist` per detached entry, per poll)
  - `/status` payload capped at 8k chars per task (7 services used to ship ~600 KB every 2.5s); full log still available via `/log`
  - workspace scan cached for 5 minutes, de-duplicated, and pruned past depth 2 (readdir count cut ~5x); the Refresh button forces a rescan
- **Perf**: after any action the panel refreshes at 0.6s and 1.6s instead of waiting for the 2.5s poll
- **UI**: spinner on every action button (build / deploy / release / clear / start / stop, batch and full-build), on Refresh, and a "Waiting for output…" placeholder in the log pane
- **Fix**: a transient `tasklist` failure no longer deletes the persisted run record (state.json)
- **Fix**: detached runs start reading their log from the end, so a previous run's output is not replayed

## 1.0.0

- First release: workspace scan (Maven modules with an `Application` class, pnpm/Vite frontends up to 4 levels deep), start/stop/restart from the right sidebar, Maven and pnpm packaging, SSH/SFTP deploy with tar upload, `docker restart` + status verification, one-click release pipeline, on-disk logs with copy/open, and run-state adoption after a DSH restart.
