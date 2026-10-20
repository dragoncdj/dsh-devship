# Changelog

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
