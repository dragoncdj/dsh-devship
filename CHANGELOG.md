# Changelog

## 2.3.1

- **Fix**: 发布（打包 → 部署 → 重启 → 校验）时任务列表里会同时出现两条一模一样的上传进度条：「发布」卡上一条（子任务进度镜像上来，本意是让发布卡也能看进度），「部署」子卡上又一条。现在部署子卡会带 `progressInParent` 标记，面板只画「发布」那张卡上的那一条——你点的是发布、日志也自动开在发布卡上
- **Internal**: `publicEntry` 新增可选字段 `progressInParent`（只在被镜像的子任务上出现，其它条目一个字节都不变）；`releaseProject` 给部署子任务打这个标记。路由、协议（仍是 5）、任务 id、日志文件名都不变
- **Tests**: [test/entry.test.mjs](test/entry.test.mjs) 补一条（默认不带这个字段、带上时进度照旧回传、非 `true` 值不外露）；全套 102 项

## 2.3.0

- **Feature**: 「部署 / 发布」改成先选环境再发。配了多台环境时，点按钮会就地展开一排环境（`发到哪台？ [开发] [测试] [生产]`，10 秒不点自动收回），点哪台才真发——不会再「以为在发测试，其实下拉还停在生产」。只配一台（老 `deploy.json`）时不弹，点了就发；**按住 Shift 点按钮 = 跳过选择器直接发默认那台**
- **Feature**: 受保护环境的「再点一次确认」搬进选择器：点「生产」第一下变成红色的「确认发到 生产」，第二下才带 `confirm` 真发；部署 / 发布 / 部署选中 / 发布选中四条路同样拦
- **UI**: 顶栏下拉改叫「默认发布环境」（决定卡片目录、`user@host:port` 与 Shift 直发目标）；部署 / 发布按钮悬停标题点名 `生产 · root@10.0.0.9 → /data/apps/demo/server`，多台时附「按住 Shift 点 = 直接发默认那台」
- **Log**: 每次部署日志第一行新增 `目标：生产 → root@10.0.0.9:22 · 受保护`（alias 显示为 `别名（dsh-ssh）`）；连接行 `连接 root@…` / `SSH 已连接` 照旧。事后翻日志能核对发到了哪台
- **Internal**: 卡片按钮不再直接发请求，入口统一收进 [client.js](client.js) 的 `openEnvPicker` / `pickEnv` / `openBatchPicker` / `pickBatch`；环境选择器复用「就地确认」的 `inlineConfirm` 样式，独立 10 秒定时器（不碰 3 秒的清除确认）；`taskKey` / `envBody` 拆出 `keyFor` / `envBodyFor`，按所点的环境现算任务 id，与 Host 侧 `taskKeyOf` 仍同一份规则
- **Compat**: 路由、请求字段、任务 id、日志文件名与 2.2.0 完全一致，协议仍为 5，无迁移；单台配置的点发行为与 2.1.x 一致
- **Tests**: dict-parity 覆盖新增文案键（zh / en 各 115 键同键同顺序）；全套 101 项通过

## 2.2.0

- **Feature**: 部署配置从「一台测试机」变成「多台环境」：`deploy.json` 新形状是 `servers: [...]` + `defaultServer`，每台有自己的地址 / 端口 / 用户 / 密码 / `dsh-ssh` alias / 重启命令 / 远端目录覆盖，最多 12 台。面板顶部新增「发布环境」下拉，「部署 / 发布 / 部署选中 / 发布选中」都发往选中的那台（一次只发一台，不跨环境扇出）；卡片按钮的标题、`user@host:port`、远端目录都跟着选中的环境变
- **Feature**: 环境可改名、可加、可删、可设默认，并内置一条捷径：只有一台老配置时点「拆成开发 / 测试 / 生产」，把现在这台填进「开发」，再生成「测试」和「生产」（生产预置受保护）——点了只改面板草稿，要再点「保存配置」才写盘
- **Feature**: 受保护环境要确认：勾了「受保护」的那台，第一次点部署 / 发布只会把按钮变成红色的「确认发到 生产」，第二次点才带 `confirm: true`。Host 在连 SSH 之前就把没确认的请求挡回去（批量里有一台没确认就整批拒绝并点名是哪台）
- **Feature**: 远端目录分两层：`servers[环境].targets[项目].remoteDir` 优先，没有就用顶层公共 `targets[项目].remoteDir`（就是老 `deploy.json` 的那一份）。同一个项目可以在开发放 `/data/apps/dev`、在生产放 `/data/apps/demo`
- **Compat**: 老形状 `deploy.json`（顶层一台 + 一份 `targets`）读进来会合成成 id 为 `default` 的一个环境：任务 id 仍是 `deploy:<项目>`、日志仍是 `logs/deploy-<项目>.log`、不带 `serverId` 的请求行为与 2.1.x 逐字节一致。带环境的任务 id 用下划线后缀（`deploy_prod_app-server`）：`slug()` 把 `:` 归一成 `-`，若写成 `deploy:prod:app-server` 就会和「项目 id 叫 prod/app-server」的老条目撞同一个日志文件，下划线前后缀则一定撞不上（环境 id 因此不许带下划线）
- **Compat**: 协议 4 → 5（`/version.version` 与 `diagnostics.code`）：路由路径一条没加，只多了 `serverId` / `confirm` 请求字段和 `servers` / `defaultServer` 响应字段。新面板配老 Host 会退化成一个「默认」环境；老面板配新 Host 顶层 `host/port/user/alias/hasPassword` 镜像默认那台，照常能发
- **Security**: 密码按环境各存一份，回传浏览器时每台只给 `hasPassword`，明文不出 Host；「留空保持、`clearPassword` 才真删」这条口径也按环境各算一份。老面板发不出密码，所以老形状写入会从默认那台继承，不会把已经配好的凭据擦掉
- **Internal**: [lib/prefs.js](lib/prefs.js) 承担全部配置归一化与校验（`readDeployConfig` / `publicDeployConfig` / `mergeServers` / `buildDeployConfig` / `buildLegacyDeployConfig` / `resolveServer` / `deployTargetOf`），校验不过一律 `{ok:false,error}`，不静默写坏配置；[routes.js](routes.js) 只多两个本地 helper（`serverSummary` / `pickServer`）；[lib/deploy.js](lib/deploy.js) 的 `taskKeyOf` 是任务 id 规则的唯一来源
- **UI**: 「部署配置」面板改成按环境分卡片编辑（每台一行连接 + 一份自己的远端目录表），下面保留「公共远端目录（哪台都没配时用它）」；删了不再用的 `deployServer` / `deployTargetsTitle` 两个文案键，中英文各 113 键保持同键同顺序
- **Tests**: 新增 [test/task-key.test.mjs](test/task-key.test.mjs)（老 id 与日志文件名逐字节不变、带环境的后缀、与老 id 不撞日志文件）和 [test/dict-parity.test.mjs](test/dict-parity.test.mjs)（zh / en 同键同数，代码里用到的每个 `t('key')` 两边都得有）；[test/prefs.test.mjs](test/prefs.test.mjs) 补 7 条（老形状合成、多环境往返与目录覆盖优先、明文不出门、按环境的密码保持/清除、id 非法与重复与上限、`defaultServer` 回落、`resolveServer` 报错）；[test/routes.test.mjs](test/routes.test.mjs) 补 5 条（写多台读回摘要、非法 id 不写盘、老形状保存不擦密码、`/list` 环境摘要与坏 id 回落、未知环境与受保护确认）；全套 101 项

## 2.1.3

- **Fix**: 上传进度一直停在 `32 KB / xxx MB` 不动、传完才一下跳满（界面和日志里那行 `↑ …` 都一样）。根因是 ssh2 `fastPut` 的 `step` 回调参数取错了：它的真实签名是 `step(已传累计, 本次块大小, 文件总大小)`（见 ssh2 `lib/protocol/SFTP.js` 的 `fastXfer`：`onstep(total, nb, fsize)`，`chunkSize` 默认就是 32768），以前接的是第二个参数，也就是「这一块多少字节」——每块都是 32768，所以进度器收到的已传字节永远是 32 KB，直到 `endFile` 按文件大小一次性记账才跳成 100%。现在取第一个参数（累计已传），进度按 32 KB 一段一段往前走
- **Perf**: 速度采样加了 200 毫秒的最小间隔。修好之后 `step` 每 32 KB 就来一次，1 MB 文件几百次回调会把 40 个采样点压成几百毫秒的窗口，速度数字乱跳；按 200 毫秒采样后 40 个点正好覆盖 8 秒，够 5 秒窗口用（文件传完那次仍然强制采一次）
- **Tests**: 新增 [test/deploy-progress.test.mjs](test/deploy-progress.test.mjs)（假 sftp 照 ssh2 的真实签名喂 `step`：进度必须递增、不能只见过 32 KB、中途断线停在已传的那些块、并发逐文件互不干扰、没有进度器时照旧上传）；[test/progress.test.mjs](test/progress.test.mjs) 补一条「按 ssh2 的节奏每 32 KB 回调一次，速度仍算得出 3.2 MB/s 量级」；全套 83 项

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
