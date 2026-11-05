# 发布 dsh-devship 到 DSH 插件市场

这个目录本身就是**插件仓库的根**（`package.json` / `index.js` / `client.js` 都在顶层），
所以「改代码 → 发版」就是：改完 → 改版本号 → `npm publish` → 打 tag。

市场（`dshmarket`）的列表来自 **awesome-dsh-plugin** 这个 GitHub 仓库，收录 = 往它提一个 YAML 文件。

| 路径 | 用途 |
|---|---|
| `package.json` 等（仓库根） | 插件本体，同时也是本地 DSH 的安装目录（profile 里是 junction 指向这里） |
| `dsh-devship-<version>.tgz` | `npm pack` 产物，可挂 GitHub Release（不发 npm 时用） |
| `docs/awesome-entry/dragoncdj__dsh-devship.yml` | 提给 awesome-dsh-plugin 的条目文件（文件名就是它要的名字） |
| `screenshots.json` | 仓库根的截图清单，收录后 CI 自动读取，不用再提 PR |
| `docs/PUBLISH.md` | 本文 |

仓库：<https://github.com/dragoncdj/dsh-devship> · npm 包名：`dsh-devship`（已确认 registry 上未被占用）

---

## 1. 建 GitHub 仓库并推送

GitHub 上新建 **public** 仓库 `dsh-devship`（不要勾 README / .gitignore / license，本地都有了）。
本地分支是 `master`，推上去时改名成 `main`：

```powershell
cd E:\workspace\dsh-devship
git remote add origin https://github.com/dragoncdj/dsh-devship.git
git branch -M main
git push -u origin main
git push origin v1.1.1        # 把 tag 也推上去
```

推完到仓库页 **About → Topics** 加 **`dsh-plugin`**（收录硬性要求）。

## 2. 发布到 npm（推荐，但不是收录的前提）

三条安装通道都能用，差别只在**要不要构建授权**和有没有下载量数字：

| 通道 | 用户执行 | 说明 |
|---|---|---|
| **npm**（推荐） | `dsh plugin --profile desktop add dsh-devship` | 预构建产物，免 `allowBuilds` 授权；市场能显示下载量 |
| **GitHub 源码** | `dsh plugin --profile desktop add github:dragoncdj/dsh-devship` | pnpm ≥10 默认拒绝执行 git 依赖的 `prepare`：首次会失败并提示，用户要把包名写进 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds:` 再重跑。本插件纯 JS 无需构建，但 **`ssh2` / `cpu-features` 要编译**，所以这一步绕不开 |
| **tarball / 本地目录** | `dsh plugin --profile desktop add file:C:\path\dsh-devship-2.3.2.tgz` | 零权限、零构建授权；不发 npm 时把 tgz 挂到 GitHub Release 并让条目用可选的 `tarball:` 字段指向它 |

> 收录本身与发不发 npm 无关（contributing.md 明确写了「发不发布都不影响收录」）；npm / tarball 解决的是**别人装的时候顺不顺**。

```powershell
npm login
cd E:\workspace\dsh-devship
npm publish --access public
```

`repository` 已指回第 1 步的仓库，市场会自动把 npm 包和仓库关联（条目里不要写 `npm:` 字段，写了会被校验拒绝）。

不发 npm 的话，把 tgz 挂到 GitHub Release，并在条目里加（资产名带版本时要钉住 tag，否则下次发版就 404）：

```yaml
tarball: https://github.com/dragoncdj/dsh-devship/releases/download/v2.3.2/dsh-devship-2.3.2.tgz
```

> 本地开发时 profile 里是指向源码目录的 junction（`"dsh-devship": "link:E:/workspace/dsh-devship"`），那是**本地路径安装**，与上面三条通道并列。

## 3. 提 PR 到 awesome-dsh-plugin

1. Fork https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
2. 新增**一个**文件：`data/plugins/dragoncdj__dsh-devship.yml`，内容 = `docs/awesome-entry/dragoncdj__dsh-devship.yml`
3. 不要手改两个 README（由脚本生成，合并后 CI 自动重建）

PR 描述模板：

```
Add dragoncdj/dsh-devship — a right-sidebar console for DeepSeek Harness that
detects the runnable Maven modules (Spring Boot main class) and Vite frontends of
the current workspace, starts/stops them (batch + detached mode that survives DSH
exit), packages with Maven or pnpm, uploads artifacts over SSH/SFTP to several
named deploy environments (dev / test / prod) with progress bars and per-environment
remote dirs, restarts the matching docker container and checks its status; protected
environments need a second click.

- repo: https://github.com/dragoncdj/dsh-devship
- package.json declares dsh.bundle + dsh.client (patch: ./cordis.patch.yml)
- category: dev
- screenshots: screenshots.json at the repo root (docs/screenshots/panel.png)
```

CI 依次检查：条目数量（≤3）、`dsh.bundle` 是否存在、**仓库年龄 ≥1 天**、awesome-lint 与站点构建。
之后维护者会读源码核对描述是否属实——所以第 1 步推完仓库，至少等一天再提这个 PR。

条目规则（来自 contributing.md，已核对）：

- `url` 必须与仓库完全一致，`name` 是 `dragoncdj/dsh-devship`，`category` 用 `dev`；
- 只有 `description.en` 必填，且要**以句号结尾**；`zh` 可选（维护者会补）；
- 描述里出现 `: `（半角冒号 + 空格）时必须整串加引号——本条目的 en/zh 都含冒号，已用单引号包住；
- 条目里**不能手写 `npm:`**，写了会被拒；下载量由 CI 从 npm registry 自动采集（尚未发布 npm 就不写，收录不受影响）；
- `dsh.bundle` 必须存在，只有 `dsh.client` 会被 CI 拒。

## 4. 收录之后

- 市场（Settings → Plugin Market）里能搜到、一键安装（合并后通常一天内）
- 想加截图：在仓库根放 `screenshots.json`（1~8 张，相对路径），推上去就行，不用再提 PR

## 日常发版

```powershell
cd E:\workspace\dsh-devship
# 1) 改代码
# 2) 改 package.json 的 version + CHANGELOG.md（需要截图就顺手更新 screenshots.json）
npm pack                      # 生成 tgz（可选，挂 Release 用）
git add -A; git commit -m "release: x.y.z"; git tag vX.Y.Z
git push; git push --tags
npm publish --access public   # 可选：发 npm 才有下载量数字
```

## 本地安装（开发时）

profile 里已经是指向本目录的 junction，改完代码**重启 DSH** 即生效：

```powershell
dsh plugin --profile desktop add E:\workspace\dsh-devship
```

## 自检

```powershell
node --check index.js; node --check client.js
npm pack                      # 生成的 tgz 里应含：package.json / cordis.patch.yml / index.js /
                              # routes.js / lib / client.js / locale / icon / screenshots.json /
                              # docs/screenshots/panel.png / README / LICENSE / CHANGELOG
tar -tzf dsh-devship-<version>.tgz
npm view dsh-devship          # 发布成功后能查到（未发布时返回 404）
```

条目与清单自检：

```powershell
node -e "console.log(JSON.stringify(require('./package.json').dsh))"   # bundle + client 都在
Get-Content screenshots.json                                            # 相对路径、1~8 张、文件都存在
```
