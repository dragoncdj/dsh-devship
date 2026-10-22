/**
 * dsh-devship — 应用运行面板（Client 半，右侧栏标签页）。
 *
 * 形态：dsh.client web 模块（__ModuleLoader__ 加载的普通模块，可用 React / fetch）。
 * 机制：
 *   - 往右侧栏注册一个 tab 类型（sidebarRightTabs）+ 「+」菜单入口（guide），
 *     内容挂在 keyed 槽 sidebar.right.pane.tab / .title 上（key = tab 类型 id）；
 *   - 激活后自动在有会话时打开一次，像 IDEA 的 Run 窗口一样常驻右侧；
 *   - 按钮通过同源 fetch 调用 Host 半的 /dsh-devship/* 路由（index.js），
 *     每 2.5 秒轮询状态与日志尾部。
 *
 * 注册 id 必须与组合行 name 完全一致：'dsh-devship'。
 */
window.__ModuleLoader__.load({
  id: 'dsh-devship',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'dsh-devship';
    /** tab 类型 id（槽 key）与 kind（打开时用）。 */
    const TAB_ID = 'dsh-devship.panel';
    const TAB_KIND = 'dsh-devship';

    const DICT = {
      zh: {
        panel: '研发直发台',
        guide: '扫描工作区的微服务与前端：一键启动 / 停止、打包、部署到测试机并重启容器',
        title: '研发直发台',
        refresh: '刷新',
        buildAll: '全量打包',
        clean: 'clean',
        profile: 'Profile',
        profileDefault: '默认 dev',
        profileLocal: '本地 local',
        run: '启动',
        stop: '停止',
        restart: '重启',
        build: '打包',
        logs: '日志',
        clear: '清除',
        tasks: '执行任务',
        clearAll: '一键清除',
        clearConfirmInline: '确认清除？会中断任务',
        confirmYes: '是',
        confirmNo: '否',
        clearIn: '{seconds} 秒后收起',
        clearAnyNow: '即将收起',
        progressHint: '上传进度：已传 / 总量 · 速度',
        autoClearTitle: '完成自动清除',
        autoClearHint: '勾选的任务类型跑完后自动从「执行任务」里移除（日志文件保留，随时能翻）；失败的任务不会自动清除',
        autoClearDelay: '延迟',
        autoClearNow: '立即',
        autoClearSecondsUnit: '秒',
        showLog: '展开日志',
        hideLog: '收起日志',
        stateRunning: '运行中',
        stateAdopted: '运行中（接管）',
        stateStopped: '已停止',
        stateExited: '已退出',
        stateFailed: '失败',
        stateStopping: '停止中',
        stateBuilding: '打包中',
        stateSuccess: '打包完成',
        stateDeps: '安装依赖…',
        stateExternal: '端口占用',
        stateHidden: '已隐藏',
        select: '勾选',
        selectAll: '全选',
        hide: '隐藏',
        unhide: '取消隐藏',
        showHidden: '显示已隐藏',
        hideHidden: '收起已隐藏',
        allHidden: '所有服务都被隐藏了',
        startSelected: '启动选中',
        stopSelected: '停止选中',
        nothingSelected: '还没有勾选任何服务',
        batchPartial: '批量操作完成，部分失败',
        deploy: '部署',
        deploySelected: '部署选中',
        deployConfig: '部署配置',
        deploySave: '保存配置',
        deploySaved: '部署配置已保存',
        deployServer: '测试服务器',
        deployHost: '地址（IP/域名）',
        deployPort: '端口',
        deployUser: '用户',
        deployPassword: '密码',
        deployPasswordSaved: '已保存 · 留空表示不改',
        deployPasswordClear: '清除已存密码',
        deployPasswordClearHint: '删掉 deploy.json 里存着的密码；下次部署改用密钥，或在这里重新填',
        deployAliasHint: '可选：dsh-ssh 主机别名（留空则用上面的地址）',
        deployTargetsTitle: '各服务部署目录',
        deployRemoteDir: '远端目录（留空 = 不部署）',
        deployContainer: '容器名',
        deployTarget: '远端目录',
        release: '发布',
        releaseSelected: '发布选中',
        fastBuild: '快速打包',
        detachRun: '关 DSH 不停止',
        detachRunHint: '勾选：服务脱离 DSH 独立运行，关掉 DSH 也不会停；不勾：关 DSH 就一起停',
        fastBuildHint: '不带 -am：只编目标模块，依赖需已 install 过',
        refreshing: '刷新中…',
        waitingOutput: '等待输出…',
        releasing: '发布中…',
        empty: '未发现可启动的项目',
        emptyHint: '支持根 pom.xml 里带 *Application 启动类的 Maven 模块，以及带 dev 脚本的 package.json 项目。',
        kindJava: 'Java',
        kindNode: '前端',
        port: '端口',
        noLog: '暂无日志。',
        logTitle: '运行日志',
        copyLog: '复制',
        openLogFile: '打开文件',
        logCopied: '已复制',
        logLimitHint: '面板只显示最近 100k 字，完整日志见文件',
        working: '处理中…',
        errorTitle: '操作失败',
        staleHost: '后台插件仍在运行旧代码：请在插件管理里停用再启用 dsh-devship（或重启 DSH 后台服务）后重试。',
        netError: '连不上后台：请求超时或连接中断，稍后会自动重试。',
      },
      en: {
        panel: 'DSH DevShip',
        guide: 'List runnable workspace services and frontends; start, stop, or package them',
        title: 'DSH DevShip',
        refresh: 'Refresh',
        buildAll: 'Build all',
        clean: 'clean',
        profile: 'Profile',
        profileDefault: 'default dev',
        profileLocal: 'local',
        run: 'Start',
        stop: 'Stop',
        restart: 'Restart',
        build: 'Package',
        logs: 'Logs',
        clear: 'Clear',
        tasks: 'Tasks',
        clearAll: 'Clear all',
        clearConfirmInline: 'Clear running tasks? They will be interrupted.',
        confirmYes: 'Yes',
        confirmNo: 'No',
        clearIn: 'auto-clears in {seconds}s',
        clearAnyNow: 'auto-clearing…',
        progressHint: 'Upload progress: transferred / total · speed',
        autoClearTitle: 'Auto-clear',
        autoClearHint: 'Checked task types are removed from the task list once they finish (log files are kept); failed tasks stay until cleared manually',
        autoClearDelay: 'delay',
        autoClearNow: 'Now',
        autoClearSecondsUnit: 's',
        showLog: 'Show logs',
        hideLog: 'Hide logs',
        stateRunning: 'running',
        stateAdopted: 'running (adopted)',
        stateStopped: 'stopped',
        stateExited: 'exited',
        stateFailed: 'failed',
        stateStopping: 'stopping',
        stateBuilding: 'packaging',
        stateSuccess: 'packaged',
        stateDeps: 'building deps…',
        stateExternal: 'port in use',
        stateHidden: 'hidden',
        select: 'Select',
        selectAll: 'Select all',
        hide: 'Hide',
        unhide: 'Unhide',
        showHidden: 'Show hidden',
        hideHidden: 'Hide hidden',
        allHidden: 'All services are hidden',
        startSelected: 'Start selected',
        stopSelected: 'Stop selected',
        nothingSelected: 'No service selected',
        batchPartial: 'Batch finished with failures',
        deploy: 'Deploy',
        deploySelected: 'Deploy selected',
        deployConfig: 'Deploy config',
        deploySave: 'Save config',
        deploySaved: 'Deploy config saved',
        deployServer: 'Test server',
        deployHost: 'host (IP/domain)',
        deployPort: 'port',
        deployUser: 'user',
        deployPassword: 'password',
        deployPasswordSaved: 'saved · leave blank to keep',
        deployPasswordClear: 'clear saved password',
        deployPasswordClearHint: 'remove the password stored in deploy.json; next deploy uses the key, or type a new one here',
        deployAliasHint: 'optional: dsh-ssh alias (leave empty to use the address above)',
        deployTargetsTitle: 'Deploy directories',
        deployRemoteDir: 'remote dir (empty = skip)',
        deployContainer: 'container',
        deployTarget: 'remote dir',
        release: 'Release',
        releaseSelected: 'Release selected',
        fastBuild: 'Fast build',
        detachRun: 'Survive DSH exit',
        detachRunHint: 'checked: service keeps running after DSH exits; unchecked: stops with DSH',
        fastBuildHint: 'skip -am: build only this module, dependencies must be installed',
        refreshing: 'Refreshing…',
        waitingOutput: 'Waiting for output…',
        releasing: 'releasing…',
        empty: 'No runnable project found',
        emptyHint: 'Maven modules with a *Application class from the root pom.xml and package.json projects with a dev script are listed here.',
        kindJava: 'Java',
        kindNode: 'Frontend',
        port: 'port',
        noLog: 'No output yet.',
        logTitle: 'Output',
        copyLog: 'Copy',
        openLogFile: 'Open file',
        logCopied: 'Copied',
        logLimitHint: 'Panel shows the last 100k chars; the full log is in the file',
        working: 'Working…',
        errorTitle: 'Operation failed',
        staleHost: 'The host half is still running older code. Disable and re-enable dsh-devship in Plugins (or restart the DSH backend), then retry.',
        netError: 'Cannot reach the backend: the request timed out or the connection dropped. Retrying automatically.',
      },
    };

    /** 当前工作区路径（由 apply 注入：sessions + workspaces 快照）。 */
    let resolveRoot = () => undefined;

    /**
     * 面板自己的请求：带超时、可取消，失败一律收成 {ok:false,error}（不往外抛）。
     * 走局域网 HTTPS 时慢请求很容易堆起来——浏览器对同一个源最多开 6 条 HTTP/1.1 连接，
     * 面板把连接占满，DSH 自己的接口就得排队，连接生成超时就变成「重新连接中」。
     */
    async function post(path, body, options) {
      const root = resolveRoot();
      const payloadBody = { ...(body ?? {}), ...(typeof root === 'string' && root !== '' ? { root } : {}) };
      const controller = new AbortController();
      const external = options?.signal;
      if (external !== undefined && external !== null) {
        if (external.aborted === true) controller.abort();
        else external.addEventListener('abort', () => controller.abort(), { once: true });
      }
      const timeoutMs = typeof options?.timeoutMs === 'number' ? options.timeoutMs : 10000;
      const timer = timeoutMs > 0 ? window.setTimeout(() => controller.abort(), timeoutMs) : undefined;
      let response;
      try {
        response = await fetch('/dsh-devship' + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payloadBody),
          signal: controller.signal,
        });
      } catch {
        if (timer !== undefined) window.clearTimeout(timer);
        return { ok: false, error: controller.signal.aborted === true ? 'timeout' : 'network' };
      }
      if (timer !== undefined) window.clearTimeout(timer);
      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = { ok: false, error: 'bad response' };
      }
      if (payload === null || typeof payload !== 'object') return { ok: false, error: 'bad response' };
      return payload;
    }

    const styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '12px 12px 24px',
        height: '100%',
        boxSizing: 'border-box',
        overflowY: 'auto',
        fontSize: 12.5,
        color: 'var(--dsw-alias-label-primary, #1a1a1a)',
      },
      headerRow: { display: 'flex', alignItems: 'center', gap: 8 },
      title: { fontSize: 14, fontWeight: 600 },
      muted: { color: 'var(--dsw-alias-label-secondary, #666)', fontSize: 11.5 },
      tiny: { color: 'var(--dsw-alias-label-tertiary, #8a8a8a)', fontSize: 11 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 11 },
      spacer: { flex: 1 },
      /** 小转圈（配合 index 注入的 keyframes）。 */
      spinner: {
        display: 'inline-block',
        width: 10,
        height: 10,
        marginRight: 4,
        borderRadius: '50%',
        border: '2px solid rgba(128,128,128,.35)',
        borderTopColor: 'currentColor',
        verticalAlign: '-1px',
        animation: 'dshDevshipSpin .7s linear infinite',
      },
      button: {
        height: 24,
        padding: '0 8px',
        borderRadius: 7,
        border: '1px solid var(--dsw-alias-border-l, rgba(9,9,11,.18))',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: 11.5,
        whiteSpace: 'nowrap',
      },
      buttonPrimary: {
        height: 24,
        padding: '0 9px',
        borderRadius: 7,
        border: '1px solid transparent',
        background: 'var(--dsw-alias-state-business-primary, #2f6fed)',
        color: 'var(--dsw-alias-label-primary-inverted, #fff)',
        cursor: 'pointer',
        fontSize: 11.5,
        whiteSpace: 'nowrap',
      },
      buttonDanger: {
        height: 24,
        padding: '0 8px',
        borderRadius: 7,
        border: '1px solid var(--dsw-alias-state-error-primary, #d92d20)',
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary, #d92d20)',
        cursor: 'pointer',
        fontSize: 11.5,
        whiteSpace: 'nowrap',
      },
      /** 内联确认（点「清除」后就地变成是/否，不弹系统对话框）。 */
      inlineConfirm: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 6px',
        borderRadius: 7,
        border: '1px solid var(--dsw-alias-state-error-primary, #d92d20)',
        background: 'var(--dsw-alias-state-error-bg, rgba(217,45,32,.08))',
        whiteSpace: 'nowrap',
      },
      confirmText: {
        fontSize: 11.5,
        color: 'var(--dsw-alias-state-error-primary, #d92d20)',
      },
      input: {
        height: 24,
        borderRadius: 7,
        border: '1px solid var(--dsw-alias-border-l, rgba(9,9,11,.18))',
        background: 'transparent',
        color: 'inherit',
        fontSize: 11.5,
        padding: '0 6px',
        boxSizing: 'border-box',
      },
      select: {
        height: 24,
        borderRadius: 7,
        border: '1px solid var(--dsw-alias-border-l, rgba(9,9,11,.18))',
        background: 'transparent',
        color: 'inherit',
        fontSize: 11.5,
        padding: '0 4px',
      },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        padding: '8px 9px',
        borderRadius: 9,
        border: '1px solid var(--dsw-alias-border-l, rgba(9,9,11,.1))',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
      },
      cardHead: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
      name: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      badge: {
        fontSize: 10,
        lineHeight: '15px',
        padding: '0 5px',
        borderRadius: 5,
        border: '1px solid var(--dsw-alias-border-l, rgba(9,9,11,.18))',
        color: 'var(--dsw-alias-label-secondary, #666)',
        flex: '0 0 auto',
      },
      dot: { width: 7, height: 7, borderRadius: 4, flex: '0 0 auto' },
      progressRow: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, minWidth: 0 },
      progressTrack: {
        flex: 1,
        minWidth: 0,
        height: 6,
        borderRadius: 4,
        overflow: 'hidden',
        background: 'var(--dsw-alias-bg-layer-2, rgba(9,9,11,.07))',
      },
      progressFill: {
        height: '100%',
        borderRadius: 4,
        background: 'var(--dsw-alias-state-business-primary, #2f6fed)',
        transition: 'width .3s ease',
      },
      actions: { display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' },
      logBox: {
        // 固定高度：日志区不随内容伸缩，避免面板布局跳动
        height: 260,
        minHeight: 260,
        flex: '0 0 auto',
        boxSizing: 'border-box',
        overflow: 'auto',
        margin: 0,
        padding: '8px 9px',
        borderRadius: 9,
        border: '1px solid var(--dsw-alias-border-l, rgba(9,9,11,.12))',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 11,
        lineHeight: '16px',
      },
      error: { color: 'var(--dsw-alias-state-error-primary, #d92d20)', fontSize: 11.5, whiteSpace: 'pre-wrap' },
    };

    const STATE_COLOR = {
      running: '#12b76a',
      building: '#f79009',
      stopping: '#f79009',
      stopped: '#98a2b3',
      exited: '#98a2b3',
      success: '#12b76a',
      failed: '#d92d20',
    };

    /** 「+」菜单里的图标。 */
    function GuideIcon(props) {
      const size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 26;
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': true, style: { display: 'block', color: 'inherit' } },
        h('path', { d: 'M4.2 2.6v10.8L13 8z', fill: 'currentColor' }),
      );
    }

    /**
     * 自检上报：模块每次 apply 都给 Host 发一条事件，便于确认「客户端半到底有没有加载」。
     * fire-and-forget，失败静默（Host 没有该路由时也不影响面板）。
     */
    function report(event, extra) {
      try {
        fetch('/dsh-devship/client-report', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ event, ...(extra === undefined ? {} : { extra }) }),
        }).catch(() => {});
      } catch {
        /* 忽略 */
      }
    }

    function apply(ctx) {
      report('apply-start');
      try {
        applyInner(ctx);
        report('apply-ok');
      } catch (error) {
        report('apply-error', error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error));
        throw error;
      }
    }

    function applyInner(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, DICT), 'dsh-devship: dictionaries');

      /** 传输层失败（超时 / 断线 / 请求作废）别把英文代码丢给用户看，换成本地文案。 */
      const errorText = (value, fallback) => {
        if (value === 'network' || value === 'timeout' || value === 'aborted') return t('netError');
        return typeof value === 'string' ? value : fallback;
      };

      /** 主视图会话的 id。 */
      function currentSessionId() {
        try {
          const snapshot = ctx.sessions.list.getSnapshot();
          const rows = snapshot !== null && snapshot !== undefined && snapshot.byId !== undefined
            ? Object.values(snapshot.byId)
            : [];
          const row = rows.find((candidate) => (candidate?.retainedBy?.mainView ?? 0) > 0);
          return row !== null && row !== undefined && typeof row.id === 'string' ? row.id : undefined;
        } catch {
          return undefined;
        }
      }

      /** 当前工作区路径：优先取包含当前会话的工作区，否则取第一个工作区。 */
      resolveRoot = () => {
        try {
          const snapshot = ctx.workspaces.list.getSnapshot();
          const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
          const sessionId = currentSessionId();
          const matched = sessionId === undefined
            ? undefined
            : items.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId));
          const picked = matched ?? items[0];
          return picked !== null && picked !== undefined && typeof picked.path === 'string' && picked.path !== ''
            ? picked.path
            : undefined;
        } catch {
          return undefined;
        }
      };

      // 右侧栏 tab 类型：标题 + 「+」菜单入口
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        priority: 'builtin',
        keepMounted: true,
        title: () => t('title'),
        guide: [{
          id: 'open',
          order: 60,
          title: () => t('panel'),
          description: () => t('guide'),
          icon: GuideIcon,
        }],
      }), 'dsh-devship: tab type');

      /** 自动清除延迟的档位：和 Host 的 AUTO_CLEAR_DELAYS 保持一致（lib/prefs.js）。 */
      const AUTO_CLEAR_DELAYS = [0, 5000, 15000, 30000, 60000];

      /** Host 返回的 autoClear 归一化：面板里的开关状态只认这个形状。 */
      function normalizeAutoClear(value) {
        const raw = value !== null && typeof value === 'object' ? value : {};
        const delay = typeof raw.delayMs === 'number' ? raw.delayMs : Number.NaN;
        return {
          build: raw.build === true,
          deploy: raw.deploy === true,
          release: raw.release === true,
          delayMs: AUTO_CLEAR_DELAYS.includes(delay) ? delay : 15000,
        };
      }

      function PanelTitle() {
        return h('span', null, t('title'));
      }

      function Panel() {
        const [projects, setProjects] = React.useState([]);
        const [root, setRoot] = React.useState('');
        const [running, setRunning] = React.useState([]);
        const [builds, setBuilds] = React.useState([]);
        const [ports, setPorts] = React.useState({});
        const [error, setError] = React.useState('');
        const [busy, setBusy] = React.useState({});
        const [selected, setSelected] = React.useState('');
        /** 当前选中任务的 id：轮询时告诉 Host「日志只要这条」，别每轮把全部任务的 tail 都端上来。 */
        const selectedRef = React.useRef('');
        selectedRef.current = selected;
        const [showLog, setShowLog] = React.useState(false);
        /** 日志操作提示（复制/文件路径）。 */
        const [logNote, setLogNote] = React.useState('');
        const [clean, setClean] = React.useState(false);
        /** 快速打包：不带 -am。 */
        const [fastBuild, setFastBuild] = React.useState(false);
        /** 关 DSH 不停止：用 WMI 脱离启动（默认开启）。 */
        const [detachRun, setDetachRun] = React.useState(true);
        const [profile, setProfile] = React.useState('');
        /** 已勾选待批量操作的项目 id。 */
        const [checked, setChecked] = React.useState({});
        /** 被隐藏的项目 id（Host 端持久化在 .dsh-devship/prefs.json）。 */
        const [hidden, setHidden] = React.useState([]);
        const [showHidden, setShowHidden] = React.useState(false);
        /** 任务完成自动清除：打包 / 部署 / 发布分别一个开关，Host 端持久化在 .dsh-devship/prefs.json。 */
        const [autoClear, setAutoClear] = React.useState({ build: false, deploy: false, release: false, delayMs: 15000 });
        /** 部署配置编辑器状态。 */
        const [deployOpen, setDeployOpen] = React.useState(false);
        /** 服务器连接信息：host/port/user/password，alias 可选（dsh-ssh 里的别名）。 */
        const [deployForm, setDeployForm] = React.useState({ host: '', port: '', user: '', password: '', alias: '' });
        /** Host 只告诉我们「deploy.json 里存没存密码」，明文不进浏览器。 */
        const [deployHasPassword, setDeployHasPassword] = React.useState(false);
        /** 每个项目的远端目录（空 = 不部署）。 */
        const [deployTargets, setDeployTargets] = React.useState({});
        /** 每个项目的容器名（部署后 docker restart 用，空 = 不重启）。 */
        const [deployContainers, setDeployContainers] = React.useState({});
        const [deployHosts, setDeployHosts] = React.useState([]);
        const [deployNote, setDeployNote] = React.useState('');
        /** 正在刷新列表（扫描工作区可能要几秒，用转圈给出反馈）。 */
        const [busyRefresh, setBusyRefresh] = React.useState(false);

        // 转圈用的 keyframes（内联样式写不了 @keyframes，注入一次）
        React.useEffect(() => {
          const id = 'dsh-devship-spin';
          if (typeof document === 'undefined' || document.getElementById(id) !== null) return undefined;
          const style = document.createElement('style');
          style.id = id;
          style.textContent = '@keyframes dshDevshipSpin{to{transform:rotate(360deg)}}';
          document.head.appendChild(style);
          return undefined;
        }, []);

        /** 转圈（跟随字号颜色）。 */
        const Spinner = () => h('span', { style: styles.spinner, 'aria-hidden': 'true' });

        const hiddenSet = React.useMemo(() => new Set(hidden), [hidden]);

        const runningMap = React.useMemo(() => {
          const map = new Map();
          for (const entry of running) map.set(entry.id, entry);
          return map;
        }, [running]);
        const buildMap = React.useMemo(() => {
          const map = new Map();
          for (const entry of builds) map.set(entry.id, entry);
          return map;
        }, [builds]);

        const refreshList = React.useCallback(async (force) => {
          setBusyRefresh(true);
          try {
            const payload = await post('/list', force === true ? { force: true } : undefined);
            if (payload.ok === true) {
              const list = Array.isArray(payload.projects) ? payload.projects : [];
              setProjects(list);
              setRoot(typeof payload.root === 'string' ? payload.root : '');
              setHidden(Array.isArray(payload.hidden) ? payload.hidden : []);
              setAutoClear(normalizeAutoClear(payload.autoClear));
              // 已不存在的项目从勾选集合里剔除
              setChecked((current) => {
                const ids = new Set(list.map((project) => project.id));
                const next = {};
                let changed = false;
                for (const [id, value] of Object.entries(current)) {
                  if (value === true && ids.has(id)) next[id] = true;
                  else changed = true;
                }
                return changed ? next : current;
              });
              const wanted = resolveRoot();
              if (list.length === 0 && typeof wanted === 'string' && typeof payload.root === 'string' && payload.root !== wanted) {
                setError(t('staleHost'));
              } else {
                setError('');
              }
            } else {
              setError(errorText(payload.error, 'list failed'));
            }
          } finally {
            setBusyRefresh(false);
          }
        }, [t]);

        /** Host 只回选中那条的 tail：其余条目这一轮没带，就沿用上轮已经拿到的那份。 */
        const keepTail = React.useCallback((next, previous) => next.map((entry) => {
          if (typeof entry.tail === 'string') return entry;
          const old = previous.find((item) => item.id === entry.id);
          return old === undefined || typeof old.tail !== 'string' ? entry : { ...entry, tail: old.tail };
        }), []);

        /**
         * 一轮 /status 只允许一个在路上：上一轮还没回来就跳过这一跳（定时轮询最容易在这里
         * 把请求堆成 3 条 4 条）；用户动作后的刷新用 force 顶掉旧请求，保证看到新状态。
         */
        const statusFlight = React.useRef({ seq: 0, running: false, controller: undefined, fails: 0 });

        const refreshStatus = React.useCallback(async (options) => {
          const flight = statusFlight.current;
          const force = options?.force === true;
          if (flight.running === true && force !== true) return;
          if (flight.running === true) flight.controller?.abort();
          const controller = new AbortController();
          const token = flight.seq + 1;
          flight.seq = token;
          flight.running = true;
          flight.controller = controller;
          const payload = await post('/status', { logFor: selectedRef.current }, { signal: controller.signal, timeoutMs: 9000 });
          if (flight.seq === token) {
            flight.running = false;
            flight.controller = undefined;
          }
          if (controller.signal.aborted === true) return;
          if (payload.ok !== true) {
            // 超时 / 断线：连着失败就退避，别在 Host 正忙或正在重连的时候继续催
            flight.fails += 1;
            return;
          }
          flight.fails = 0;
          const running = Array.isArray(payload.running) ? payload.running : [];
          const builds = Array.isArray(payload.builds) ? payload.builds : [];
          setRunning((current) => keepTail(running, current));
          setBuilds((current) => keepTail(builds, current));
          setPorts(payload.ports !== null && payload.ports !== undefined && typeof payload.ports === 'object' ? payload.ports : {});
          if (typeof payload.root === 'string' && payload.root !== '') setRoot(payload.root);
        }, [keepTail]);

        // 有部署 / 发布正在传文件时轮询密一点：进度条和速度 2.5 秒一跳太钝
        const transferring = builds.some((entry) => entry.progress !== undefined && entry.state === 'running');
        React.useEffect(() => {
          let stopped = false;
          let timer = undefined;
          const base = transferring ? 1200 : 2500;
          const delay = () => {
            const fails = statusFlight.current.fails;
            if (fails === 0) return base;
            return Math.min(base * 2 ** Math.min(fails, 3), 15000);
          };
          const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
          const schedule = (ms) => {
            if (stopped) return;
            if (timer !== undefined) window.clearTimeout(timer);
            timer = window.setTimeout(() => {
              timer = undefined;
              if (stopped) return;
              // 后台标签页（局域网把面板开着当后台页）不占连接：每 5 秒看一眼有没有回到前台
              if (visible() !== true) { schedule(5000); return; }
              void refreshStatus()
                .catch(() => { statusFlight.current.fails += 1; })
                .then(() => schedule(delay()));
            }, ms);
          };
          refreshList();
          void refreshStatus({ force: true });
          schedule(base);
          const onVisibility = () => { if (visible() === true) schedule(0); };
          if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
          return () => {
            stopped = true;
            if (timer !== undefined) window.clearTimeout(timer);
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
            // 面板切走 / 重新挂载：在路上的那条请求直接作废，别留一条没人收的连接
            statusFlight.current.controller?.abort();
            statusFlight.current.running = false;
            statusFlight.current.controller = undefined;
          };
        }, [refreshList, refreshStatus, transferring]);

        /** 有任务在等自动收起时每秒滴一下：轮询 2.5s 一轮，倒数要更细一点。 */
        const [countdownTick, setCountdownTick] = React.useState(0);
        React.useEffect(() => {
          if (!builds.some((entry) => Number.isInteger(entry.clearAt))) return undefined;
          const timer = window.setInterval(() => setCountdownTick((current) => current + 1), 1000);
          return () => window.clearInterval(timer);
        }, [builds]);

        /** 自动清除倒计时：Host 把「什么时候收起」写在 clearAt 里，这里换算成秒。 */
        const clearInLabel = (entry) => {
          if (!Number.isInteger(entry.clearAt)) return '';
          void countdownTick; // 每秒滴一次，让下面的 Date.now() 跟着重新渲染
          const seconds = Math.max(0, Math.round((entry.clearAt - Date.now()) / 1000));
          return seconds === 0 ? t('clearAnyNow') : t('clearIn').replace('{seconds}', String(seconds));
        };

        /** 上传进度：Host 只给字节数和速度，写法在这里换算（和 Host 侧 lib/progress.js 保持一致）。 */
        const sizeLabel = (bytes) => {
          const value = Number(bytes);
          if (!Number.isFinite(value) || value <= 0) return '0 B';
          if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
          if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
          if (value >= 1024) return `${Math.round(value / 1024)} KB`;
          return `${Math.round(value)} B`;
        };
        const speedLabel = (bytesPerSecond) => {
          const value = Number(bytesPerSecond);
          if (!Number.isFinite(value) || value <= 0) return '—';
          if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB/s`;
          if (value >= 1024) return `${Math.round(value / 1024)} KB/s`;
          return `${Math.round(value)} B/s`;
        };
        const progressOf = (entry) => (
          entry.progress !== undefined && typeof entry.progress.percent === 'number' ? entry.progress : undefined
        );

        const act = React.useCallback(async (key, path, body) => {
          setBusy((current) => ({ ...current, [key]: true }));
          setError('');
          try {
            const payload = await post(path, body);
            if (payload.ok !== true) setError(errorText(payload.error, t('errorTitle')));
            return payload;
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure));
            return { ok: false };
          } finally {
            setBusy((current) => {
              const next = { ...current };
              delete next[key];
              return next;
            });
            // 先同步一次（多数动作 Host 侧已有结果），再用短间隔补两次，
            // 让「点完立刻出现」而不是等 2.5s 的常规轮询
            await refreshStatus({ force: true });
            window.setTimeout(() => { void refreshStatus({ force: true }); }, 600);
            window.setTimeout(() => { void refreshStatus({ force: true }); }, 1600);
          }
        }, [refreshStatus, t]);

        /** 勾选 / 取消勾选一个项目。 */
        const toggleChecked = (id, value) => {
          setChecked((current) => {
            const next = { ...current };
            if (value) next[id] = true;
            else delete next[id];
            return next;
          });
        };

        /** 隐藏 / 取消隐藏一个项目（Host 端持久化）。 */
        const toggleHide = async (id, hide) => {
          setError('');
          const payload = await post('/hide', { id, hidden: hide === true });
          if (payload.ok === true) {
            setHidden(Array.isArray(payload.hidden) ? payload.hidden : []);
            if (hide === true) toggleChecked(id, false);
          } else {
            setError(errorText(payload.error, t('errorTitle')));
          }
        };

        /** 保存「任务完成自动清除」偏好；Host 端顺手把已经跑完的同类任务清掉。 */
        const saveAutoClear = async (next) => {
          const value = normalizeAutoClear(next);
          setAutoClear(value);
          const payload = await post('/prefs', { autoClear: value });
          if (payload.ok !== true) {
            setError(errorText(payload.error, t('errorTitle')));
            return;
          }
          setAutoClear(normalizeAutoClear(payload.autoClear));
          // Host 刚清过一轮，立刻刷一次，不用等 2.5s 的常规轮询
          await refreshStatus({ force: true });
        };

        /** 批量启动 / 停止选中项，汇总失败信息。 */
        const runBatch = async (path, ids) => {
          if (ids.length === 0) {
            setError(t('nothingSelected'));
            return;
          }
          setBusy((current) => ({ ...current, batch: true }));
          setError('');
          try {
            const payload = await post(path, { projectIds: ids, profile, clean, fast: fastBuild, detach: detachRun });
            if (payload.ok !== true) {
              setError(errorText(payload.error, t('errorTitle')));
              return;
            }
            const results = Array.isArray(payload.results) ? payload.results : [];
            const failures = results.filter((result) => result.ok !== true);
            if (failures.length > 0) {
              setError(`${t('batchPartial')}：` + failures.map((failure) => `${failure.id} — ${failure.error}`).join('；'));
            }
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure));
          } finally {
            setBusy((current) => {
              const next = { ...current };
              delete next.batch;
              return next;
            });
            await refreshStatus({ force: true });
          }
        };

        /** 任务是否还在跑：清除它之前要确认，确认后会先中断。 */
        const taskLive = (entry) => entry !== undefined
          && (entry.state === 'running' || entry.state === 'building' || entry.state === 'stopping');

        /** 就地确认状态：{ ids, key, force }；3 秒不点自动收回。 */
        const [pendingClear, setPendingClear] = React.useState(undefined);
        const pendingClearTimer = React.useRef(undefined);

        const clearPendingTimer = () => {
          if (pendingClearTimer.current !== undefined) {
            window.clearTimeout(pendingClearTimer.current);
            pendingClearTimer.current = undefined;
          }
        };

        const armClear = (ids, key, force) => {
          clearPendingTimer();
          setPendingClear({ ids, key, force: force === true });
          pendingClearTimer.current = window.setTimeout(() => { setPendingClear(undefined); }, 3000);
        };

        const cancelClear = () => {
          clearPendingTimer();
          setPendingClear(undefined);
        };

        React.useEffect(() => clearPendingTimer, []);

        /** 真正发清除请求。 */
        const runClear = async (ids, key, force) => {
          setBusy((current) => ({ ...current, clearing: true, [key]: true }));
          setError('');
          try {
            const payload = await post('/clear-tasks', { ids, force: force === true });
            if (payload.ok !== true && payload.needsConfirm === true) {
              // Host 说这任务其实还在跑：把确认重新摆回按钮上，等用户点「是」
              armClear(ids, key, true);
              return;
            }
            if (payload.ok !== true) {
              setError(errorText(payload.error, t('errorTitle')));
              return;
            }
            setSelected((current) => (current !== '' && ids.includes(current) ? '' : current));
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure));
          } finally {
            setBusy((current) => {
              const next = { ...current };
              delete next.clearing;
              delete next[key];
              return next;
            });
            // 与 act 一致：先同步一次，再补两次，清除后列表立刻收起来
            await refreshStatus({ force: true });
            window.setTimeout(() => { void refreshStatus({ force: true }); }, 600);
            window.setTimeout(() => { void refreshStatus({ force: true }); }, 1600);
          }
        };

        /**
         * 清除任务（单个「清除」和「一键清除」共用）。
         * 运行中的任务就地确认（不弹系统对话框）；Host 端还会再确认一次（needsConfirm），防止面板状态过期。
         */
        const clearTasks = (ids, key) => {
          if (ids.length === 0) return;
          const live = ids.some((id) => taskLive(buildMap.get(id)) || taskLive(runningMap.get(id)));
          if (live) {
            armClear(ids, key, false);
            return;
          }
          void runClear(ids, key, false);
        };

        /** 「清除」按钮：点下去就地变成是/否；只有确认状态对同一个 key 才替换。 */
        const clearButton = (ids, key, label) => {
          if (pendingClear !== undefined && pendingClear.key === key) {
            return h('span', { style: styles.inlineConfirm },
              h('span', { style: styles.confirmText }, t('clearConfirmInline')),
              h('button', {
                type: 'button',
                style: styles.buttonDanger,
                onClick: () => {
                  const live = pendingClear.force === true
                    || ids.some((id) => taskLive(buildMap.get(id)) || taskLive(runningMap.get(id)));
                  cancelClear();
                  void runClear(ids, key, live);
                },
              }, t('confirmYes')),
              h('button', { type: 'button', style: styles.button, onClick: cancelClear }, t('confirmNo')));
          }
          return h('button', {
            type: 'button',
            style: styles.button,
            disabled: busy.clearing === true,
            onClick: () => { clearTasks(ids, key); },
          }, busy[key] === true ? h(Spinner) : null, label);
        };

        const visibleProjects = projects.filter((project) => showHidden || !hiddenSet.has(project.id));
        const checkedIds = visibleProjects.filter((project) => checked[project.id] === true).map((project) => project.id);
        const allChecked = visibleProjects.length > 0 && checkedIds.length === visibleProjects.length;

        /** 打开 / 关闭部署配置（打开时拉一次当前配置和可用主机）。 */
        const toggleDeployConfig = async () => {
          if (deployOpen) {
            setDeployOpen(false);
            return;
          }
          setDeployNote('');
          try {
            const response = await fetch('/dsh-devship/deploy-config', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ root: resolveRoot() }),
            });
            const payload = await response.json();
            if (payload.ok === true) {
              const config = payload.config ?? {};
              setDeployForm({
                host: typeof config.host === 'string' ? config.host : '',
                port: Number.isInteger(config.port) ? String(config.port) : '',
                user: typeof config.user === 'string' ? config.user : '',
                // Host 不再回传明文密码：输入框留空，占位符说明「不改就保持原值」
                password: '',
                alias: typeof config.alias === 'string' ? config.alias : '',
              });
              setDeployHasPassword(config.hasPassword === true);
              const targets = {};
              const containers = {};
              for (const [id, target] of Object.entries(config.targets ?? {})) {
                if (target === null || typeof target !== 'object') continue;
                if (typeof target.remoteDir === 'string') targets[id] = target.remoteDir;
                if (typeof target.container === 'string') containers[id] = target.container;
              }
              setDeployTargets(targets);
              setDeployContainers(containers);
              setDeployHosts(Array.isArray(payload.hosts) ? payload.hosts : []);
              setDeployOpen(true);
            } else {
              setError(errorText(payload.error, t('errorTitle')));
            }
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure));
          }
        };

        /** 保存部署配置：服务器地址 + 每个项目的远端目录。密码留空 = 保持 Host 上已存的值。 */
        const saveDeployConfig = async (options = {}) => {
          const config = {
            ...deployForm.host.trim() === '' ? {} : { host: deployForm.host.trim() },
            ...deployForm.port.trim() === '' || !Number.isInteger(Number(deployForm.port)) ? {} : { port: Number(deployForm.port) },
            ...deployForm.user.trim() === '' ? {} : { user: deployForm.user.trim() },
            ...deployForm.password === '' ? {} : { password: deployForm.password },
            ...deployForm.alias.trim() === '' ? {} : { alias: deployForm.alias.trim() },
            targets: {},
          };
          for (const [id, remoteDir] of Object.entries(deployTargets)) {
            if (typeof remoteDir !== 'string' || remoteDir.trim() === '') continue;
            const container = typeof deployContainers[id] === 'string' ? deployContainers[id].trim() : '';
            config.targets[id] = {
              remoteDir: remoteDir.trim(),
              ...container === '' ? {} : { container },
            };
          }
          try {
            const response = await fetch('/dsh-devship/deploy-config', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                root: resolveRoot(),
                config,
                ...options.clearPassword === true ? { clearPassword: true } : {},
              }),
            });
            const payload = await response.json();
            if (payload.ok === true) {
              setDeployNote(t('deploySaved'));
              // 明文密码不在输入框里过夜：保存完就擦掉，只留「有没有存」这个状态
              setDeployForm((current) => ({ ...current, password: '' }));
              setDeployHasPassword(payload.config?.hasPassword === true);
              await refreshList();
            } else {
              setDeployNote(errorText(payload.error, t('errorTitle')));
            }
          } catch (failure) {
            setDeployNote(failure instanceof Error ? failure.message : String(failure));
          }
        };

        const selectedEntry = runningMap.get(selected) ?? buildMap.get(selected);
        const tail = selectedEntry !== undefined && typeof selectedEntry.tail === 'string' ? selectedEntry.tail : '';

        const logRef = React.useRef(null);
        React.useEffect(() => {
          const node = logRef.current;
          if (node !== null && node !== undefined) node.scrollTop = node.scrollHeight;
        }, [tail, selected, showLog]);

        const stateLabel = (entry) => {
          if (entry.state === 'running') return entry.adopted === true ? t('stateAdopted') : entry.phase === 'deps' ? t('stateDeps') : t('stateRunning');
          if (entry.state === 'building') return t('stateDeps');
          if (entry.state === 'stopping') return t('stateStopping');
          if (entry.state === 'stopped') return t('stateStopped');
          if (entry.state === 'exited') return t('stateExited');
          if (entry.state === 'success') return t('stateSuccess');
          if (entry.state === 'failed') return t('stateFailed');
          return t('stateBuilding');
        };

        const openLog = (id) => {
          setSelected(id);
          selectedRef.current = id;
          setShowLog(true);
          // 选谁就得马上看到谁的日志：别等下一轮 2.5s 轮询
          void refreshStatus({ force: true });
        };

        /** 复制完整日志（来自落盘文件，不受面板尾部长度限制）。 */
        const copyLog = async (id) => {
          try {
            const response = await fetch('/dsh-devship/log', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ root: resolveRoot(), id }),
            });
            const payload = await response.json();
            if (payload.ok !== true) {
              setError(errorText(payload.error, t('errorTitle')));
              return;
            }
            const text = typeof payload.text === 'string' ? payload.text : '';
            try {
              await navigator.clipboard.writeText(text);
            } catch {
              const area = document.createElement('textarea');
              area.value = text;
              document.body.appendChild(area);
              area.select();
              document.execCommand('copy');
              document.body.removeChild(area);
            }
            setLogNote(`${t('logCopied')} ${text.length} 字`);
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure));
          }
        };

        /** 在资源管理器里定位日志文件。 */
        const openLogFile = async (id) => {
          try {
            const response = await fetch('/dsh-devship/log-open', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ root: resolveRoot(), id }),
            });
            const payload = await response.json();
            if (payload.ok !== true) {
              setError(errorText(payload.error, t('errorTitle')));
              return;
            }
            setLogNote(typeof payload.path === 'string' ? payload.path : '');
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure));
          }
        };

        const projectCard = (project) => {
          const run = runningMap.get(project.id);
          const buildKey = 'build:' + project.id;
          const building = buildMap.get(buildKey);
          const canBuild = project.kind === 'java' || typeof project.buildScript === 'string';
          const live = run !== undefined && (run.state === 'running' || run.state === 'stopping' || run.state === 'building');
          const external = run === undefined && ports[project.id] === true;
          const isHidden = hiddenSet.has(project.id);
          const dotColor = run !== undefined
            ? (STATE_COLOR[run.state] ?? '#98a2b3')
            : external
              ? STATE_COLOR.running
              : building !== undefined && building.state === 'running' ? STATE_COLOR.building : '#d0d5dd';
          const isBusy = busy[project.id] === true || busy[buildKey] === true;
          const canRestart = run !== undefined && run.state !== 'building' && run.state !== 'stopping';
          return h(
            'div',
            { key: project.id, style: isHidden ? { ...styles.card, opacity: 0.55 } : styles.card },
            h('div', { style: styles.cardHead },
              h('input', {
                type: 'checkbox',
                checked: checked[project.id] === true,
                title: t('select'),
                onChange: (event) => toggleChecked(project.id, event.target.checked),
                style: { flex: '0 0 auto', margin: 0 },
              }),
              h('span', { style: { ...styles.dot, background: dotColor } }),
              h('span', { style: styles.name, title: project.name }, project.name),
              h('span', { style: styles.badge }, project.kind === 'java' ? t('kindJava') : t('kindNode')),
              project.port === undefined || project.port === null
                ? null
                : h('span', { style: styles.tiny }, `${t('port')} ${project.port}`),
              h('span', { style: styles.spacer }),
              isHidden
                ? h('span', { style: styles.tiny }, t('stateHidden'))
                : live
                  ? h('span', { style: { ...styles.tiny, color: run.state === 'building' ? STATE_COLOR.building : STATE_COLOR.running } }, stateLabel(run))
                  : external
                    ? h('span', { style: { ...styles.tiny, color: STATE_COLOR.running }, title: project.name }, t('stateExternal'))
                    : building !== undefined
                      ? h('span', { style: { ...styles.tiny, color: STATE_COLOR[building.state] ?? '#98a2b3' } }, stateLabel(building))
                      : null,
            ),
            h('div', { style: { ...styles.mono, ...styles.tiny, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: project.command }, project.command),
            typeof project.note === 'string' && project.note !== ''
              ? h('div', { style: { ...styles.tiny, whiteSpace: 'normal' } }, project.note)
              : null,
            h('div', { style: styles.actions },
              live
                ? h('button', {
                  type: 'button',
                  style: styles.buttonDanger,
                  disabled: isBusy,
                  onClick: () => act(project.id, '/stop', { projectId: project.id }),
                }, t('stop'))
                : h('button', {
                  type: 'button',
                  style: styles.buttonPrimary,
                  disabled: isBusy,
                  onClick: () => act(project.id, '/launch', { projectId: project.id, profile, detach: detachRun }),
                }, isBusy ? t('working') : (run === undefined || !canRestart ? t('run') : t('restart'))),
              canBuild
                ? h('button', {
                  type: 'button',
                  style: styles.button,
                  disabled: isBusy || (building !== undefined && building.state === 'running'),
                  title: project.kind === 'node' ? `pnpm run ${project.buildScript ?? 'build'}` : undefined,
                  onClick: () => { openLog(buildKey); void act(buildKey, '/build', { projectId: project.id, clean, fast: fastBuild }); },
                }, busy[buildKey] === true ? h(Spinner) : null, busy[buildKey] === true ? t('working') : t('build'))
                : null,
              h('button', {
                type: 'button',
                style: styles.button,
                onClick: () => openLog(project.id),
              }, t('logs')),
              run !== undefined && run.state !== 'running' && run.state !== 'building' && run.state !== 'stopping'
                ? clearButton([project.id], project.id + ':forget', t('clear'))
                : null,
              h('button', {
                type: 'button',
                style: styles.button,
                onClick: () => toggleHide(project.id, !isHidden),
              }, isHidden ? t('unhide') : t('hide')),
              typeof project.deploy === 'object' && project.deploy !== null
                ? h('button', {
                  type: 'button',
                  style: styles.button,
                  disabled: isBusy || busy['deploy:' + project.id] === true,
                  title: `${t('deployTarget')}: ${project.deploy.remoteDir}`,
                  onClick: () => { openLog('deploy:' + project.id); void act('deploy:' + project.id, '/deploy', { projectId: project.id }); },
                }, busy['deploy:' + project.id] === true ? h(Spinner) : null, busy['deploy:' + project.id] === true ? t('working') : t('deploy'))
                : null,
              typeof project.deploy === 'object' && project.deploy !== null
                ? h('button', {
                  type: 'button',
                  style: styles.buttonPrimary,
                  disabled: isBusy || busy['release:' + project.id] === true,
                  title: `打包 → 部署${project.deploy.container === undefined ? '' : ` → 重启 ${project.deploy.container}`}`,
                  onClick: () => { openLog('release:' + project.id); void act('release:' + project.id, '/release', { projectId: project.id, clean, fast: fastBuild }); },
                }, busy['release:' + project.id] === true ? h(Spinner) : null, busy['release:' + project.id] === true ? t('releasing') : t('release'))
                : null,
            ),
          );
        };

        return h(
          'div',
          { style: styles.root },
          h('div', { style: styles.headerRow },
            h('span', { style: styles.title }, t('title')),
            h('span', { style: styles.spacer }),
            h('button', { type: 'button', style: styles.button, onClick: toggleDeployConfig }, t('deployConfig')),
            h('button', {
              type: 'button',
              style: styles.button,
              disabled: busyRefresh,
              onClick: () => { void refreshList(true); void refreshStatus({ force: true }); },
            }, busyRefresh ? h(Spinner) : null, busyRefresh ? t('refreshing') : t('refresh')),
          ),
          h('div', { style: { ...styles.tiny, ...styles.mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: root }, root),
          h('div', { style: styles.actions },
            h('select', {
              style: styles.select,
              value: profile,
              title: t('profile'),
              onChange: (event) => setProfile(event.target.value),
            },
              h('option', { value: '' }, t('profileDefault')),
              h('option', { value: 'local' }, t('profileLocal')),
              h('option', { value: 'dev' }, 'dev'),
            ),
            h('label', { style: { ...styles.tiny, display: 'flex', alignItems: 'center', gap: 3 } },
              h('input', { type: 'checkbox', checked: clean, onChange: (event) => setClean(event.target.checked) }),
              t('clean'),
            ),
            h('label', { style: { ...styles.tiny, display: 'flex', alignItems: 'center', gap: 3 }, title: t('fastBuildHint') },
              h('input', { type: 'checkbox', checked: fastBuild, onChange: (event) => setFastBuild(event.target.checked) }),
              t('fastBuild'),
            ),
            h('label', { style: { ...styles.tiny, display: 'flex', alignItems: 'center', gap: 3 }, title: t('detachRunHint') },
              h('input', { type: 'checkbox', checked: detachRun, onChange: (event) => setDetachRun(event.target.checked) }),
              t('detachRun'),
            ),
            h('span', { style: styles.spacer }),
            h('button', {
              type: 'button',
              style: styles.button,
              disabled: busy['build:<root>'] === true,
              onClick: () => { openLog('build:<root>'); void act('build:<root>', '/build', { modulePath: '', clean, fast: fastBuild }); },
            }, busy['build:<root>'] === true ? h(Spinner) : null, t('buildAll')),
          ),
          h('div', { style: styles.actions },
            h('input', {
              type: 'checkbox',
              checked: allChecked,
              title: t('selectAll'),
              onChange: (event) => {
                if (!event.target.checked) {
                  setChecked({});
                  return;
                }
                const next = {};
                for (const project of visibleProjects) next[project.id] = true;
                setChecked(next);
              },
              style: { flex: '0 0 auto', margin: 0 },
            }),
            h('span', { style: styles.tiny }, t('selectAll')),
            h('button', {
              type: 'button',
              style: styles.buttonPrimary,
              disabled: busy.batch === true || checkedIds.length === 0,
              onClick: () => runBatch('/launch-batch', checkedIds),
            }, busy.batch === true ? h(Spinner) : null, busy.batch === true ? t('working') : `${t('startSelected')}${checkedIds.length === 0 ? '' : ` (${checkedIds.length})`}`),
            h('button', {
              type: 'button',
              style: styles.buttonDanger,
              disabled: busy.batch === true || checkedIds.length === 0,
              onClick: () => runBatch('/stop-batch', checkedIds),
            }, busy.batch === true ? h(Spinner) : null, t('stopSelected')),
            h('button', {
              type: 'button',
              style: styles.button,
              disabled: busy.batch === true || checkedIds.length === 0,
              onClick: () => runBatch('/deploy-batch', checkedIds),
            }, busy.batch === true ? h(Spinner) : null, t('deploySelected')),
            h('button', {
              type: 'button',
              style: styles.buttonPrimary,
              disabled: busy.batch === true || checkedIds.length === 0,
              onClick: () => runBatch('/release-batch', checkedIds),
            }, busy.batch === true ? h(Spinner) : null, t('releaseSelected')),
            h('span', { style: styles.spacer }),
            hidden.length === 0
              ? null
              : h('button', {
                type: 'button',
                style: styles.button,
                onClick: () => setShowHidden((value) => !value),
              }, showHidden ? t('hideHidden') : `${t('showHidden')} (${hidden.length})`),
          ),
          h('div', { style: styles.actions, title: t('autoClearHint') },
            h('span', { style: { ...styles.tiny, fontWeight: 600 } }, t('autoClearTitle')),
            h('label', { style: { ...styles.tiny, display: 'flex', alignItems: 'center', gap: 3 } },
              h('input', {
                type: 'checkbox',
                checked: autoClear.build,
                onChange: (event) => { void saveAutoClear({ ...autoClear, build: event.target.checked }); },
              }),
              t('build'),
            ),
            h('label', { style: { ...styles.tiny, display: 'flex', alignItems: 'center', gap: 3 } },
              h('input', {
                type: 'checkbox',
                checked: autoClear.deploy,
                onChange: (event) => { void saveAutoClear({ ...autoClear, deploy: event.target.checked }); },
              }),
              t('deploy'),
            ),
            h('label', { style: { ...styles.tiny, display: 'flex', alignItems: 'center', gap: 3 } },
              h('input', {
                type: 'checkbox',
                checked: autoClear.release,
                onChange: (event) => { void saveAutoClear({ ...autoClear, release: event.target.checked }); },
              }),
              t('release'),
            ),
            h('select', {
              style: styles.select,
              value: String(autoClear.delayMs),
              title: t('autoClearDelay'),
              onChange: (event) => { void saveAutoClear({ ...autoClear, delayMs: Number(event.target.value) }); },
            },
              ...AUTO_CLEAR_DELAYS.map((ms) => h('option', {
                key: ms,
                value: String(ms),
              }, ms === 0 ? t('autoClearNow') : `${ms / 1000} ${t('autoClearSecondsUnit')}`)),
            ),
          ),
          autoClear.build === true || autoClear.deploy === true || autoClear.release === true
            ? h('div', { style: styles.tiny }, t('autoClearHint'))
            : null,
          deployOpen
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '2px 0' } },
              h('div', { style: { fontWeight: 600, fontSize: 12 } }, t('deployServer')),
              h('div', { style: styles.actions },
                h('input', {
                  value: deployForm.host,
                  placeholder: t('deployHost'),
                  spellCheck: false,
                  onChange: (event) => setDeployForm((current) => ({ ...current, host: event.target.value })),
                  style: { ...styles.input, flex: '1 1 130px', minWidth: 110 },
                }),
                h('input', {
                  value: deployForm.port,
                  placeholder: t('deployPort'),
                  inputMode: 'numeric',
                  onChange: (event) => setDeployForm((current) => ({ ...current, port: event.target.value })),
                  style: { ...styles.input, flex: '0 0 58px' },
                }),
              ),
              h('div', { style: styles.actions },
                h('input', {
                  value: deployForm.user,
                  placeholder: t('deployUser'),
                  spellCheck: false,
                  onChange: (event) => setDeployForm((current) => ({ ...current, user: event.target.value })),
                  style: { ...styles.input, flex: '1 1 90px', minWidth: 80 },
                }),
                h('input', {
                  value: deployForm.password,
                  placeholder: deployHasPassword ? t('deployPasswordSaved') : t('deployPassword'),
                  ...(deployHasPassword ? { title: t('deployPasswordSaved') } : {}),
                  type: 'password',
                  autoComplete: 'new-password',
                  onChange: (event) => setDeployForm((current) => ({ ...current, password: event.target.value })),
                  style: { ...styles.input, flex: '1 1 110px', minWidth: 90 },
                }),
                deployHasPassword && deployForm.password === ''
                  ? h('button', {
                      title: t('deployPasswordClearHint'),
                      onClick: () => { void saveDeployConfig({ clearPassword: true }); },
                    }, t('deployPasswordClear'))
                  : null,
              ),
              h('input', {
                value: deployForm.alias,
                placeholder: t('deployAliasHint'),
                spellCheck: false,
                onChange: (event) => setDeployForm((current) => ({ ...current, alias: event.target.value })),
                style: { ...styles.input, width: '100%', boxSizing: 'border-box' },
              }),
              deployHosts.length === 0
                ? null
                : h('div', { style: styles.tiny }, 'dsh-ssh: ' + deployHosts.map((host) => `${host.alias}=${host.user}@${host.host}`).join('  ')),
              h('div', { style: { fontWeight: 600, fontSize: 12, marginTop: 2 } }, t('deployTargetsTitle')),
              projects.length === 0
                ? h('div', { style: styles.tiny }, t('empty'))
                : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                  projects.map((project) => h('div', { key: project.id, style: { display: 'flex', alignItems: 'center', gap: 6 } },
                    h('span', { style: { ...styles.tiny, flex: '0 0 120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: project.id }, project.name),
                    h('input', {
                      value: deployTargets[project.id] ?? '',
                      placeholder: t('deployRemoteDir'),
                      spellCheck: false,
                      onChange: (event) => setDeployTargets((current) => ({ ...current, [project.id]: event.target.value })),
                      style: { ...styles.input, flex: 1, minWidth: 0 },
                    }),
                    h('input', {
                      value: deployContainers[project.id] ?? '',
                      placeholder: t('deployContainer'),
                      spellCheck: false,
                      onChange: (event) => setDeployContainers((current) => ({ ...current, [project.id]: event.target.value })),
                      style: { ...styles.input, flex: '0 0 92px' },
                    }),
                  )),
                ),
              h('div', { style: styles.actions },
                h('button', { type: 'button', style: styles.buttonPrimary, onClick: saveDeployConfig }, t('deploySave')),
                h('button', { type: 'button', style: styles.button, onClick: () => setDeployOpen(false) }, t('hide')),
              ),
              deployNote === '' ? null : h('div', { style: styles.tiny }, deployNote),
            )
            : null,
          error === '' ? null : h('div', { style: styles.error }, error),
          visibleProjects.length === 0
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 2px' } },
              h('div', { style: { fontWeight: 600 } }, projects.length === 0 ? t('empty') : t('allHidden')),
              h('div', { style: styles.tiny }, projects.length === 0 ? t('emptyHint') : ''),
            )
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, visibleProjects.map(projectCard)),
          builds.length === 0
            ? null
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              h('div', { style: styles.actions },
                h('span', { style: { fontWeight: 600, fontSize: 12 } }, `${t('tasks')} (${builds.length})`),
                h('span', { style: styles.spacer }),
                clearButton(builds.map((entry) => entry.id), 'clear:all', t('clearAll')),
              ),
              builds.map((entry) => {
                const progress = progressOf(entry);
                const percent = progress === undefined ? 0 : Math.max(0, Math.min(100, progress.percent));
                return h(
                  'div',
                  { key: entry.id, style: styles.card },
                  h('div', { style: styles.cardHead },
                    h('span', { style: { ...styles.dot, background: STATE_COLOR[entry.state] ?? '#98a2b3' } }),
                    h('span', { style: styles.name }, entry.name),
                    h('span', { style: styles.badge }, entry.tool === 'pnpm' ? 'pnpm' : entry.tool === 'ssh' ? 'SSH' : 'Maven'),
                    h('span', { style: styles.spacer }),
                    h('span', { style: { ...styles.tiny, color: STATE_COLOR[entry.state] ?? '#98a2b3' } }, stateLabel(entry)),
                    clearInLabel(entry) === ''
                      ? null
                      : h('span', { style: styles.tiny }, clearInLabel(entry)),
                  ),
                  progress === undefined
                    ? null
                    : h('div', { style: styles.progressRow, title: t('progressHint') },
                      h('span', { style: styles.tiny }, `${percent}%`),
                      h('div', { style: styles.progressTrack },
                        h('div', { style: { ...styles.progressFill, width: `${percent}%` } }),
                      ),
                      h('span', { style: styles.tiny }, `${sizeLabel(progress.uploaded)} / ${sizeLabel(progress.total)}`),
                      h('span', { style: styles.tiny }, speedLabel(progress.bytesPerSecond)),
                    ),
                  h('div', { style: styles.actions },
                    h('button', { type: 'button', style: styles.button, onClick: () => openLog(entry.id) }, t('logs')),
                    clearButton([entry.id], entry.id + ':forget', t('clear')),
                  ),
                );
              }),
            ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 } },
            h('span', { style: { fontWeight: 600, fontSize: 12 } }, selectedEntry === undefined ? t('logTitle') : t('logTitle') + ' · ' + selectedEntry.name),
            h('span', { style: styles.spacer }),
            selectedEntry === undefined
              ? null
              : h('button', { type: 'button', style: styles.button, title: t('logLimitHint'), onClick: () => { void copyLog(selectedEntry.id); } }, t('copyLog')),
            selectedEntry === undefined
              ? null
              : h('button', { type: 'button', style: styles.button, onClick: () => { void openLogFile(selectedEntry.id); } }, t('openLogFile')),
            h('button', { type: 'button', style: styles.button, onClick: () => setShowLog((value) => !value) }, showLog ? t('hideLog') : t('showLog')),
          ),
          logNote === '' ? null : h('div', { style: { ...styles.tiny, ...styles.mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: logNote }, logNote),
          showLog
            ? h('pre', { ref: logRef, style: styles.logBox }, tail !== '' ? tail : (selectedEntry === undefined ? t('noLog') : (busy[selected] === true ? t('waitingOutput') : t('noLog'))))
            : null,
        );
      }

      ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: TAB_ID,
        locale: NS,
      }, Panel));

      ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title',
        key: TAB_ID,
        locale: NS,
      }, PanelTitle));

      // 注意：不要注册 sidebar.right.tab.guide.entry。
      // 那个槽是「自定义整张卡片」的入口，注册后会把 owner 的标准卡片（图标+标题+描述+点击打开）
      // 整个替换掉，只剩自己的组件——表现就是「+」菜单里看不到这一项。

      // 自动打开：右栏页签 + 展开右栏。
      // 刚启动时会话还没挂到右栏（openTab 会抛），所以用 1s 定时重试，
      // 成功后停止；用户手动关掉页签后不再抢开。
      const opened = new Set();
      let attempts = 0;
      let lastSession;
      let retry;
      const stopRetry = () => {
        if (retry !== undefined) {
          window.clearInterval(retry);
          retry = undefined;
        }
      };
      const tryOpen = () => {
        const sessionId = currentSessionId();
        if (sessionId !== lastSession) {
          lastSession = sessionId;
          attempts = 0;
        }
        if (sessionId === undefined || opened.has(sessionId)) {
          stopRetry();
          return;
        }
        attempts += 1;
        try {
          ctx.sidebarRight.openTab(TAB_KIND);
          if (typeof ctx.sidebarRight.isExpanded === 'function' && ctx.sidebarRight.isExpanded() === false) {
            ctx.sidebarRight.toggleExpanded();
          }
          opened.add(sessionId);
          stopRetry();
          report('open-ok', `attempt ${attempts}`);
        } catch (error) {
          if (attempts >= 30) {
            stopRetry();
            report('open-failed', error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error));
          }
        }
      };
      ctx.effect(() => {
        tryOpen();
        retry = window.setInterval(tryOpen, 1000);
        let stop = () => {};
        try {
          if (typeof ctx.sessions.list.subscribe === 'function') {
            stop = ctx.sessions.list.subscribe(tryOpen);
          }
        } catch {
          stop = () => {};
        }
        return () => {
          stopRetry();
          try {
            stop();
          } catch {
            /* 已释放 */
          }
        };
      }, 'dsh-devship: auto open tab');
    }

    return {
      inject: ['slots', 'locale', 'sessions', 'workspaces', 'sidebarRightTabs', 'sidebarRight'],
      apply,
    };
  },
});
