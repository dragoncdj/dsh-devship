# dsh-devship

DSH 右栏「研发直发台」：列出工作区里可启动的服务，一键启动/停止、打包、部署到测试机并重启容器。

## 安装

本地目录安装（开发用）：

```sh
dsh plugin --profile <profile> add E:\workspace\jyx-workspace\jyx-erp\.dsh-plugins\publish\dsh-devship
```

或从 npm / GitHub 安装（发布后）：

```sh
dsh plugin --profile web add dsh-devship
```

DSH Desktop：**Settings → Plugins** 里安装（桌面端只认已发布到 npm 的插件）。

## 功能

- 扫描工作区：根 pom 的 Maven 模块（含 `*-server`）、最多 4 层目录里的 `package.json`（`dev/serve/start` 脚本）
- 启动/停止/重启（隐藏窗口；「关 DSH 不停止」默认开启，脱离 DSH 存活；重启后自动接管）
- 打包：Maven `-T 1C`（可选快速模式去 `-am`）、前端直接 node+vite
- 部署：SSH/SFTP（目录打 tar 单文件上传，jar 自动 `.bak` 备份，fat-jar 预检），容器 `docker restart` + 状态校验
- 一键发布：打包 → 部署 → 重启 → 校验
- 日志：面板最近 100k 字符 + 全量落盘 `.dsh-devship/logs/*.log`，可复制/打开文件
