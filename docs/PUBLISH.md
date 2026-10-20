# 发布 dsh-devship 到 DSH 插件市场

这个目录本身就是**插件仓库的根**（`package.json` / `index.js` / `client.js` 都在顶层），
所以「改代码 → 发版」就是：改完 → 改版本号 → `npm publish` → 打 tag。

市场（`dshmarket`）的列表来自 **awesome-dsh-plugin** 这个 GitHub 仓库，收录 = 往它提一个 YAML 文件。

| 路径 | 用途 |
|---|---|
| `package.json` 等（仓库根） | 插件本体，同时也是本地 DSH 的安装目录（profile 里是 junction 指向这里） |
| `dsh-devship-<version>.tgz` | `npm pack` 产物，可挂 GitHub Release（不发 npm 时用） |
| `docs/awesome-entry/dragoncdj__dsh-devship.yml` | 提给 awesome-dsh-plugin 的条目文件（文件名就是它要的名字） |
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

## 2. 发布到 npm（桌面端必需）

DSH **Desktop 只能安装已发布到 npm 的插件**（GitHub 源码安装那条路是给 dsh web 的）：

```powershell
npm login
cd E:\workspace\dsh-devship
npm publish --access public
```

`repository` 已指回第 1 步的仓库，市场会自动把 npm 包和仓库关联（条目里不要写 `npm:` 字段）。

> 不发 npm 也能收录，但桌面端用户装不了。走这条路线的话，把 tgz 挂到 GitHub Release，
> 并在条目里加：
> ```yaml
> tarball: https://github.com/dragoncdj/dsh-devship/releases/download/v1.1.1/dsh-devship-1.1.1.tgz
> ```

## 3. 提 PR 到 awesome-dsh-plugin

1. Fork https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
2. 新增**一个**文件：`data/plugins/dragoncdj__dsh-devship.yml`，内容 = `docs/awesome-entry/dragoncdj__dsh-devship.yml`
3. 不要手改两个 README（由脚本生成，合并后 CI 自动重建）

PR 描述模板：

```
Add dsh-devship — a right-sidebar console for DeepSeek Harness that lists the
runnable Maven modules and Vite frontends of the current workspace and lets you
start/stop them, package them with Maven/pnpm, deploy the artifacts to a remote
host over SSH, and restart the corresponding docker container.

- repo: https://github.com/dragoncdj/dsh-devship
- package.json declares dsh.bundle + dsh.client (patch: ./cordis.patch.yml)
- npm: dsh-devship
- category: dev
```

CI 依次检查：条目数量（≤3）、`dsh.bundle` 是否存在、**仓库年龄 ≥1 天**、awesome-lint 与站点构建。
之后维护者会读源码核对描述是否属实——所以第 1 步推完仓库，至少等一天再提这个 PR。

条目规则（来自 contributing.md，已核对）：

- `url` 必须与仓库完全一致，`name` 是 `dragoncdj/dsh-devship`，`category` 用 `dev`；
- 只有 `description.en` 必填，且要**以句号结尾**；`zh` 可选（维护者会补）；
- 描述里出现 `: `（半角冒号 + 空格）时必须整串加引号，本条目没有这个问题；
- 条目里不能手写 `npm:`，下载量由 CI 从 registry 自动采集。

## 4. 收录之后

- 市场（Settings → Plugin Market）里能搜到、一键安装（合并后通常一天内）
- 想加截图：在仓库根放 `screenshots.json`（1~8 张，相对路径），推上去就行，不用再提 PR

## 日常发版

```powershell
cd E:\workspace\dsh-devship
# 1) 改代码
# 2) 改 package.json 的 version + CHANGELOG.md
npm pack                      # 生成 tgz（可选，挂 Release 用）
git add -A; git commit -m "release: x.y.z"; git tag vX.Y.Z
git push; git push --tags
npm publish --access public
```

## 本地安装（开发时）

profile 里已经是指向本目录的 junction，改完代码**重启 DSH** 即生效：

```powershell
dsh plugin --profile desktop add E:\workspace\dsh-devship
```

## 自检

```powershell
node --check index.js; node --check client.js
tar -tzf dsh-devship-1.1.1.tgz   # 应含 package.json / cordis.patch.yml / index.js / client.js / locale / icon / README / LICENSE / CHANGELOG
npm view dsh-devship             # 发布成功后能查到
```
