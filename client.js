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
      },
    };

    /** 当前工作区路径（由 apply 注入：sessions + workspaces 快照）。 */
    let resolveRoot = () => undefined;

    async function post(path, body) {
      const root = resolveRoot();
      const payloadBody = { ...(body ?? {}), ...(typeof root === 'string' && root !== '' ? { root } : {}) };
      const response = await fetch('/dsh-devship' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payloadBody),
      });
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
        /** 部署配置编辑器状态。 */
        const [deployOpen, setDeployOpen] = React.useState(false);
        /** 服务器连接信息：host/port/user/password，alias 可选（dsh-ssh 里的别名）。 */
        const [deployForm, setDeployForm] = React.useState({ host: '', port: '', user: '', password: '', alias: '' });
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
              setError(typeof payload.error === 'string' ? payload.error : 'list failed');
            }
          } finally {
            setBusyRefresh(false);
          }
        }, [t]);

        const refreshStatus = React.useCallback(async () => {
          const payload = await post('/status');
          if (payload.ok !== true) return;
          setRunning(Array.isArray(payload.running) ? payload.running : []);
          setBuilds(Array.isArray(payload.builds) ? payload.builds : []);
          setPorts(payload.ports !== null && payload.ports !== undefined && typeof payload.ports === 'object' ? payload.ports : {});
          if (typeof payload.root === 'string' && payload.root !== '') setRoot(payload.root);
        }, []);

        React.useEffect(() => {
          refreshList();
          refreshStatus();
          let stopped = false;
          const timer = window.setInterval(() => {
            if (!stopped) refreshStatus();
          }, 2500);
          return () => {
            stopped = true;
            window.clearInterval(timer);
          };
        }, [refreshList, refreshStatus]);

        const act = React.useCallback(async (key, path, body) => {
          setBusy((current) => ({ ...current, [key]: true }));
          setError('');
          try {
            const payload = await post(path, body);
            if (payload.ok !== true) setError(typeof payload.error === 'string' ? payload.error : t('errorTitle'));
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
            await refreshStatus();
            window.setTimeout(() => { void refreshStatus(); }, 600);
            window.setTimeout(() => { void refreshStatus(); }, 1600);
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
            setError(typeof payload.error === 'string' ? payload.error : t('errorTitle'));
          }
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
              setError(typeof payload.error === 'string' ? payload.error : t('errorTitle'));
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
            await refreshStatus();
          }
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
                password: typeof config.password === 'string' ? config.password : '',
                alias: typeof config.alias === 'string' ? config.alias : '',
              });
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
              setError(typeof payload.error === 'string' ? payload.error : t('errorTitle'));
            }
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure));
          }
        };

        /** 保存部署配置：服务器地址 + 每个项目的远端目录。 */
        const saveDeployConfig = async () => {
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
              body: JSON.stringify({ root: resolveRoot(), config }),
            });
            const payload = await response.json();
            if (payload.ok === true) {
              setDeployNote(t('deploySaved'));
              await refreshList();
            } else {
              setDeployNote(typeof payload.error === 'string' ? payload.error : t('errorTitle'));
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
          setShowLog(true);
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
              setError(typeof payload.error === 'string' ? payload.error : t('errorTitle'));
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
              setError(typeof payload.error === 'string' ? payload.error : t('errorTitle'));
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
                ? h('button', {
                  type: 'button',
                  style: styles.button,
                  disabled: busy[project.id + ':forget'] === true,
                  onClick: () => act(project.id + ':forget', '/forget', { id: project.id }),
                }, busy[project.id + ':forget'] === true ? h(Spinner) : null, t('clear'))
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
              onClick: () => { void refreshList(true); void refreshStatus(); },
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
                  placeholder: t('deployPassword'),
                  type: 'password',
                  onChange: (event) => setDeployForm((current) => ({ ...current, password: event.target.value })),
                  style: { ...styles.input, flex: '1 1 110px', minWidth: 90 },
                }),
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
              builds.map((entry) => h(
                'div',
                { key: entry.id, style: styles.card },
                h('div', { style: styles.cardHead },
                  h('span', { style: { ...styles.dot, background: STATE_COLOR[entry.state] ?? '#98a2b3' } }),
                  h('span', { style: styles.name }, entry.name),
                  h('span', { style: styles.badge }, entry.tool === 'pnpm' ? 'pnpm' : entry.tool === 'ssh' ? 'SSH' : 'Maven'),
                  h('span', { style: styles.spacer }),
                  h('span', { style: { ...styles.tiny, color: STATE_COLOR[entry.state] ?? '#98a2b3' } }, stateLabel(entry)),
                ),
                h('div', { style: styles.actions },
                  h('button', { type: 'button', style: styles.button, onClick: () => openLog(entry.id) }, t('logs')),
                  h('button', { type: 'button', style: styles.button, onClick: () => act(entry.id + ':forget', '/forget', { id: entry.id }) }, t('clear')),
                ),
              )),
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
