# 发布 dsh-devship 到 DSH 插件市场

市场（`dshmarket`）的插件列表来自 **awesome-dsh-plugin** 这个 GitHub 仓库的收录数据，
所以「发布到插件市场」= 两步：

1. 插件本身得有一个**公开 GitHub 仓库**（`package.json` 里声明 `dsh.bundle`）
2. 往 `awesome-dsh-plugin` 提一个 PR，加 **一个** YAML 文件

已经准备好的东西（都在这个目录下）：

| 路径 | 用途 |
|---|---|
| `dsh-devship/` | 可直接作为 GitHub 仓库根目录的独立包（已 `git init` + 首次提交） |
| `dsh-devship/dsh-devship-1.1.0.tgz` | npm pack 产物（48 KB），可挂 GitHub Release |
| `awesome-entry/dsh-devship.yml` | 要提到 awesome-dsh-plugin 的条目文件 |
| `release.mjs` | 从工作副本重新生成发布目录（改完代码跑一次再发版） |

---

## 0. 先把 owner 换成你的 GitHub 用户名

三处占位 `YOUR_GITHUB_USER`：

```powershell
cd E:\workspace\jyx-workspace\jyx-erp\.dsh-plugins\publish
node release.mjs 你的GitHub用户名          # 重新生成，自动替换 package.json / README
# 条目文件也要换
(Get-Content awesome-entry\dsh-devship.yml) -replace 'YOUR_GITHUB_USER','你的GitHub用户名' |
  Set-Content awesome-entry\dsh-devship.yml -Encoding utf8
```

## 1. 建 GitHub 仓库并推上去

在 GitHub 上新建 **public** 仓库 `dsh-devship`（不要勾 README / .gitignore / license，本地都有了），然后：

```powershell
cd E:\workspace\jyx-workspace\jyx-erp\.dsh-plugins\publish\dsh-devship
git remote add origin https://github.com/你的GitHub用户名/dsh-devship.git
git branch -M main
git push -u origin main
```

推送后到仓库页 **About → Topics** 里加上 **`dsh-plugin`**（收录要求里明确要这一项）。

> 备注：`jyx-erp` 那边是阿里云 Codeup 私有库，不能作为收录地址；这个独立仓库就是给市场用的。

## 2.（强烈建议）发布到 npm

DSH **Desktop** 只能安装「已发布到 npm」的插件（源码/GitHub tarball 那条路是给 dsh web 用的），
所以想在桌面端点一下装，就必须发 npm：

```powershell
npm login                     # 需要你的 npm 账号（当前环境未登录）
cd E:\workspace\jyx-workspace\jyx-erp\.dsh-plugins\publish\dsh-devship
npm publish --access public
```

注意：`package.json` 的 `repository` 已经指回第 1 步的仓库地址，市场会自动把 npm 包和仓库关联（不用在条目里写 `npm:`）。

> 不发 npm 也能收录，但桌面端用户装不了。若走「不发 npm」路线，把 tarball 挂到 GitHub Release，
> 并在条目里加一行：
> ```yaml
> tarball: https://github.com/你的GitHub用户名/dsh-devship/releases/download/v1.1.0/dsh-devship-1.1.0.tgz
> ```

## 3. 提 PR 到 awesome-dsh-plugin

1. Fork https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
2. 新增 **一个** 文件：`data/plugins/<你的用户名>__dsh-devship.yml`（内容 = `awesome-entry/dsh-devship.yml`）
3. 不要手改两个 README（它们是脚本生成的，合并后 CI 自动重建）
4. 提 PR，标题例如 `Add dsh-devship`

PR 描述可以直接用：

```
Add dsh-devship — a right-sidebar console for DeepSeek Harness that lists the
runnable Maven modules and Vite frontends of the current workspace and lets you
start/stop them, package them with Maven/pnpm, deploy the artifacts to a remote
host over SSH, and restart the corresponding docker container.

- repo: https://github.com/你的GitHub用户名/dsh-devship
- package.json declares dsh.bundle + dsh.client (patch: ./cordis.patch.yml)
- npm: dsh-devship (if published)
- category: dev
```

CI 会依次检查：条目数量、`dsh.bundle` 是否存在、仓库年龄 ≥1 天、awesome-lint 与站点构建。
之后维护者会读一遍源码，核对描述是否属实。

## 4. 收录之后

- 市场（Settings → Plugin Market）里能搜到、一键安装（通常合并后一天内）
- 想加截图：在你自己的仓库 `package.json` 旁边放 `screenshots.json`（1~8 张，相对路径），推上去就行，不用再提 PR

## 现在就能验的

```powershell
# tarball 内容自检
tar -tzf dsh-devship-1.1.0.tgz
# 本地从目录安装试试（会写进当前 profile）
dsh plugin --profile desktop add E:\workspace\jyx-workspace\jyx-erp\.dsh-plugins\publish\dsh-devship
```
