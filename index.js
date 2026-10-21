/**
 * dsh-devship — 工作区「快捷启动」插件（Host 半，插件外壳）。
 *
 * 能力：
 *   - 扫描工作区里可启动的项目：Maven 里带 *Application 启动类的模块（Java）与
 *     带 dev 脚本的 package.json 项目（前端 / Node），与 IDEA 的启动配置对应；
 *   - 通过 ctx.subprocess 启动 / 停止开发进程，异步执行 Maven / pnpm 打包并回收日志尾部；
 *   - 打包产物按 deploy.json 部署到远端服务器（SFTP），并可串成「发布」一条任务；
 *   - 以同源 HTTP 路由（ctx.webServer，/dsh-devship/*）暴露给 Client 半（client.js），
 *     浏览器 fetch 直接调用，无需 Remote 通道。
 *
 * 依赖服务（inject）：webServer、subprocess、sandboxPolicy。
 * 工作区根目录：Client 半随请求带上（工作区账目的 path，最准确）；
 * 缺失时 Host 依次尝试 workspaceRegistry / 会话 cwd / sandboxPolicy / 进程 cwd。
 *
 * 这个文件只负责「装配」：把各模块接起来、注册路由、退出时收尾。实现都在：
 *   lib/state.js   进程表 / 任务表 / 日志落盘 / pid 判活 / state.json / 自动清除
 *   lib/scan.js    工作区发现 / 根目录白名单 / 项目扫描 / mvn·pnpm·JDK 定位
 *   lib/build.js   启动脚本生成 / 启动 / 停止 / 打包 / 一键清除
 *   lib/deploy.js  SSH 会话 / SFTP 上传 / 部署 / 发布
 *   routes.js      全部同源路由（路径与响应结构在这里，改动要顾及 client.js）
 *   lib/prefs.js   prefs.json / deploy.json / ~/.dsh/dsh-ssh.json 读写
 *   lib/util.js    小工具（读文本、目录判定、shell 引号、命令行拆分……）
 */
import { createBuild } from './lib/build.js';
import { createDeploy } from './lib/deploy.js';
import { createRoutes } from './routes.js';
import { createScanner } from './lib/scan.js';
import { createState } from './lib/state.js';

const plugin = {
  name: 'dsh-devship',
  inject: ['webServer', 'subprocess', 'sandboxPolicy'],
  apply(ctx) {
    const state = createState();
    const scanner = createScanner(ctx);
    const runner = createBuild(ctx, { ...state, ...scanner });
    const deploy = createDeploy(ctx, { ...state, ...scanner, ...runner });

    for (const route of createRoutes(ctx, { ...state, ...scanner, ...runner, ...deploy })) {
      ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: route.path, handler: route.handler }), `dsh-devship: ${route.path}`);
    }

    /** 插件卸载 / DSH 退出：先停掉自动清除计时器，再收掉还在跑的进程与任务。 */
    ctx.effect(() => async () => {
      for (const timer of state.autoClearTimers.values()) clearTimeout(timer);
      state.autoClearTimers.clear();
      for (const entry of [...state.processes.values(), ...state.builds.values()]) {
        try {
          entry.handle.terminate();
        } catch {
          /* 已经退出 */
        }
      }
    }, 'dsh-devship: stop children on dispose');
  },
};

export default plugin;
