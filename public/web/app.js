/* ============================================================================
 * QAQ Web — SPA client. Talks to the local qaq web server (/api/*) and the
 * /api/stream WebSocket. No build step, no framework: plain DOM + fetch.
 * ========================================================================== */
(function () {
  'use strict';
  var $ = function (sel) { return document.querySelector(sel); };
  var state = {
    status: null,
    view: 'dashboard',
    logTab: 'error',
    logScroll: 0,
    pluginFilter: '',
    backups: null,
    plugins: null,
    logs: null,
    ws: null,
    wsOk: false,
  };

  /* ---------------- i18n (zh primary, en fallback) ---------------- */
  var I = {
    dashboard: '总览', guard: '守卫', backups: '备份', plugins: '插件', logs: '日志', hot: '热更新', settings: '设置',
    mode: { idle: '空闲', launcher: '启动器', sideload: '侧载' },
    conn: { connected: '已连接', connecting: '连接中', disconnected: '未连接' },
    mounted: 'dsh-qaq 已挂载', notMounted: 'dsh-qaq 未挂载',
    host: '宿主失败', ui: 'UI 失败', lastSuccess: '上次成功', lastFailure: '上次失败', lastGood: 'last-good', rolledBack: '回滚时间',
    version: '版本', dshVersion: 'DSH 版本', profile: 'Profile', home: 'Home', checkout: 'Checkout', port: '端口', browser: '浏览器',
    process: 'DSH 进程', command: '启动命令', cwd: '工作目录',
    launch: '启动守卫', stop: '停止守卫', backupNow: '立即备份', resetCounters: '重置计数', installPlugin: '挂载 dsh-qaq',
    watchToggle: '侧载 watch', updateCheck: '检测更新',
    auto: '自动备份', manual: '手动备份', lastGoodLabel: 'last-good 快照', restore: '还原',
    enabled: '已启用', disabled: '已禁用', available: '可安装', uninstalled: '未安装',
    install: '安装', uninstall: '卸载', enable: '启用', disable: '禁用', search: '搜索插件…',
    error: 'error.log', access: 'access.log', host: 'host.log', qaq: 'qaq.log',
    hotWatch: 'client bundle 热更', hotRestartBundles: 'bundle 变化自动重启', hotRestartDist: 'web dist 变化自动重启', events: '最近事件',
    qaqUpd: 'QAQ 更新', dshUpd: 'DSH 更新',
    empty: '暂无数据', none: '（无）',
  };

  /* ---------------- helpers ---------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : c;
    });
  }
  function fmtTs(s) {
    if (!s) return '-';
    try { return new Date(s).toLocaleString(); } catch (e) { return s; }
  }
  function setPill(el, cls, text) {
    el.className = 'pill ' + cls;
    el.textContent = text;
  }
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._tm);
    t._tm = setTimeout(function () { t.classList.remove('show'); }, 2400);
  }
  function apiGet(path) {
    return fetch(path).then(function (r) { return r.json(); });
  }
  function apiAction(body) {
    return fetch('/api/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); });
  }

  /* ---------------- nav ---------------- */
  var NAV = [
    { id: 'dashboard', label: I.dashboard, icon: '◈' },
    { id: 'guard', label: I.guard, icon: '▶' },
    { id: 'backups', label: I.backups, icon: '▣' },
    { id: 'plugins', label: I.plugins, icon: '⧉' },
    { id: 'logs', label: I.logs, icon: '≣' },
    { id: 'hot', label: I.hot, icon: '♨' },
    { id: 'settings', label: I.settings, icon: '⚙' },
  ];
  function buildNav() {
    var nav = $('#nav');
    var html = '<div class="nav-group">守卫控制台</div>';
    NAV.forEach(function (item) {
      var dot = '#4176E6';
      if (item.id === 'dashboard') dot = '#22C55E';
      if (item.id === 'guard') dot = '#4176E6';
      if (item.id === 'logs') dot = '#F59E0B';
      if (item.id === 'settings') dot = '#9DA3AA';
      html += '<div class="nav-item' + (state.view === item.id ? ' active' : '') + '" data-view="' + item.id + '">' +
        '<span class="dot" style="background:' + dot + '"></span><span>' + item.label + '</span></div>';
    });
    nav.innerHTML = html;
    Array.prototype.forEach.call(nav.querySelectorAll('.nav-item'), function (el) {
      el.addEventListener('click', function () { state.view = el.getAttribute('data-view'); buildNav(); render(); });
    });
  }

  /* ---------------- topbar ---------------- */
  function renderTopbar() {
    var st = state.status;
    if (!st) return;
    $('#top-title').textContent = NAV.filter(function (n) { return n.id === state.view; })[0].label;
    var modeCls = st.mode === 'launcher' ? 'status-ok' : st.mode === 'sideload' ? 'status-info' : 'status-idle';
    setPill($('#top-mode'), modeCls, I.mode[st.mode] || st.mode);
    var c = st.conn && st.conn.state;
    var connCls = c === 'connected' ? 'status-ok' : c === 'connecting' ? 'status-warn' : 'status-bad';
    setPill($('#top-conn'), connCls, (I.conn[c] || c) + (st.conn && st.conn.port ? ' :' + st.conn.port : ''));
    $('#brand-ver').textContent = st.version ? 'v' + st.version : '';
    $('#foot-ver').textContent = st.version ? ('QAQ v' + st.version + (st.dshVersion ? ' · DSH v' + st.dshVersion : '')) : '';
  }

  /* ---------------- views ---------------- */
  function render() {
    if (!state.status) { $('#content').innerHTML = '<div class="empty">连接中…</div>'; return; }
    switch (state.view) {
      case 'dashboard': return renderDashboard();
      case 'guard': return renderGuard();
      case 'backups': return renderBackups();
      case 'plugins': return renderPlugins();
      case 'logs': return renderLogs();
      case 'hot': return renderHot();
      case 'settings': return renderSettings();
    }
  }

  function card(k, v, cls) {
    return '<div class="card"><div class="k">' + esc(k) + '</div><div class="v ' + (cls || '') + '">' + v + '</div></div>';
  }
  function row(k, v, cls) {
    return '<div class="row"><span class="rk">' + esc(k) + '</span><span class="rv ' + (cls || '') + '">' + v + '</span></div>';
  }

  function renderDashboard() {
    var st = state.status;
    var html = '<div class="page"><h2>' + I.dashboard + '</h2><div class="sub">QAQ ' + I.dashboard + ' · profile ' + esc(st.profile) + '</div>';
    html += '<div class="cards">';
    html += card('宿主失败', st.state.hostFailures, st.state.hostFailures > 0 ? 'bad' : 'ok');
    html += card('UI 失败', st.state.uiFailures, st.state.uiFailures > 0 ? 'bad' : 'ok');
    html += card('模式', I.mode[st.mode] || st.mode, '');
    html += card('dsh-qaq', st.mounted ? '已挂载' : '未挂载', st.mounted ? 'ok' : 'warn');
    html += card('QAQ 版本', st.version ? 'v' + st.version : '-', '');
    html += card('DSH 版本', st.dshVersion ? 'v' + st.dshVersion : '-', '');
    html += '</div>';
    html += '<div class="rows">';
    html += row('守卫 URL', st.activeGuard ? '<a href="' + esc(st.activeGuard.url) + '">' + esc(st.activeGuard.url) + '</a>' : '未启动');
    html += row('侧载 watch', st.sideGuard ? (st.sideGuard.url + ' · ' + esc(st.sideGuard.last)) : '未运行');
    html += row('DSH 进程', st.processUp ? ('pid=' + st.processPid + (st.processPort ? ' port=' + st.processPort : '')) : '未运行');
    html += row('Checkout', st.checkout ? esc(st.checkout) : '-', 'mono');
    html += row('上次成功', fmtTs(st.state.lastSuccess));
    html += row('上次失败', st.state.lastFailure ? (I[st.state.lastFailure.kind] || st.state.lastFailure.kind) + ' @ ' + fmtTs(st.state.lastFailure.ts) : '-');
    html += row('last-good', st.state.lastGoodSnapshot ? esc(st.state.lastGoodSnapshot) : '（无）');
    html += row('回滚时间', fmtTs(st.state.rolledBackAt));
    if (st.report) {
      html += row('启动命令', esc(st.report.command.join(' ')), 'mono');
      html += row('工作目录', esc(st.report.cwd), 'mono');
      html += row('目标端口', String(st.report.port));
      html += row('浏览器', esc(st.report.browser || '-'));
    }
    html += '</div>';
    if (st.message) html += '<div class="section">消息</div><div class="row"><span class="rv">' + esc(st.message) + '</span></div>';
    if (st.report && st.report.problems && st.report.problems.length) {
      html += '<div class="section">启动前自检</div><div class="rows">';
      st.report.problems.forEach(function (p) {
        html += row(p.sev.toUpperCase(), esc(p.message) + ' → ' + esc(p.hint), p.sev === 'error' ? 'bad' : 'warn');
      });
      html += '</div>';
    }
    html += '</div>';
    $('#content').innerHTML = html;
  }

  function renderGuard() {
    var st = state.status;
    var html = '<div class="page"><h2>' + I.guard + '</h2><div class="sub">' + I.dashboard + ' · profile ' + esc(st.profile) + '</div>';
    html += '<div class="actions">';
    if (st.activeGuard) {
      html += '<button class="btn danger" data-act="stop">' + I.stop + '</button>';
    } else {
      html += '<button class="btn primary" data-act="launch">' + I.launch + '</button>';
    }
    html += '<button class="btn" data-act="backup">' + I.backupNow + '</button>';
    html += '<button class="btn" data-act="reset">' + I.resetCounters + '</button>';
    if (!st.mounted) html += '<button class="btn" data-act="install-plugin">' + I.installPlugin + '</button>';
    html += '<button class="btn" data-act="watch-toggle">' + I.watchToggle + (st.sideGuard ? ' (开)' : ' (关)') + '</button>';
    html += '<button class="btn" data-act="update-check">' + I.updateCheck + '</button>';
    html += '</div>';
    html += '<div class="rows">';
    html += row('模式', I.mode[st.mode] || st.mode);
    html += row('守卫 URL', st.activeGuard ? esc(st.activeGuard.url) : '未启动');
    html += row('侧载 watch', st.sideGuard ? (esc(st.sideGuard.url) + ' · ' + esc(st.sideGuard.last)) : '未运行');
    html += row('宿主失败', String(st.state.hostFailures));
    html += row('UI 失败', String(st.state.uiFailures));
    html += row('last-good', st.state.lastGoodSnapshot ? esc(st.state.lastGoodSnapshot) : '（无）');
    html += '</div></div>';
    $('#content').innerHTML = html;
    bindActions();
  }

  function renderBackups() {
    var html = '<div class="page"><h2>' + I.backups + '</h2><div class="sub">' + I.dashboard + ' · profile ' + esc(state.status.profile) + '</div>';
    html += '<div class="actions"><button class="btn primary" data-act="backup">' + I.backupNow + '</button></div>';
    var b = state.backups;
    if (!b) { html += '<div class="empty">加载中…</div></div>'; $('#content').innerHTML = html; bindActions(); return; }
    html += '<div class="section">' + I.lastGoodLabel + '</div>';
    html += '<table class="list"><thead><tr><th>快照</th><th>时间</th><th>状态</th><th></th></tr></thead><tbody>';
    if (b.lastGood) {
      html += '<tr><td class="mono">' + esc(b.lastGood.name) + '</td><td>' + fmtTs(b.lastGood.ts) + '</td>' +
        '<td><span class="badge ' + (b.lastGood.usable ? 'enabled' : 'disabled') + '">' + (b.lastGood.usable ? '可用' : '不可用') + '</span></td>' +
        '<td>' + (b.lastGood.usable ? '<button class="btn sm" data-restore="' + esc(b.lastGood.name) + '">' + I.restore + '</button>' : '') + '</td></tr>';
    } else { html += '<tr><td colspan="4" class="empty">' + I.none + '</td></tr>'; }
    html += '</tbody></table>';
    html += '<div class="section">' + I.auto + '（' + b.auto.length + '）</div>';
    html += renderBackupTable(b.auto, 'auto');
    html += '<div class="section">' + I.manual + '（' + b.manual.length + '）</div>';
    html += renderBackupTable(b.manual, 'manual');
    html += '</div>';
    $('#content').innerHTML = html;
    bindActions();
    bindRestore();
  }
  function renderBackupTable(list, kind) {
    if (!list.length) return '<div class="empty">' + I.none + '</div>';
    var html = '<table class="list"><thead><tr><th>快照</th><th>时间</th><th>状态</th><th></th></tr></thead><tbody>';
    list.forEach(function (it) {
      html += '<tr><td class="mono">' + esc(it.name) + '</td><td>' + fmtTs(it.ts) + '</td>' +
        '<td><span class="badge kind-' + it.kind + '">' + (it.kind === 'auto' ? I.auto : I.manual) + '</span></td>' +
        '<td>' + (it.usable ? '<button class="btn sm" data-restore="' + esc(it.name) + '">' + I.restore + '</button>' : '<span class="badge disabled">损坏</span>') + '</td></tr>';
    });
    html += '</tbody></table>';
    return html;
  }

  function renderPlugins() {
    var html = '<div class="page"><h2>' + I.plugins + '</h2><div class="sub">' + I.dashboard + ' · profile ' + esc(state.status.profile) + '</div>';
    html += '<div class="actions"><input class="btn" id="plugin-filter" placeholder="' + I.search + '" value="' + esc(state.pluginFilter) + '" style="min-width:220px;cursor:text" /></div>';
    var p = state.plugins;
    if (!p) { html += '<div class="empty">加载中…</div></div>'; $('#content').innerHTML = html; bindFilter(); return; }
    html += '<div class="row"><span class="rk">DSH 连接</span><span class="rv">' + (I.conn[p.conn.state] || p.conn.state) +
      (p.conn.port ? ' port=' + p.conn.port : '') + (typeof p.conn.pluginCount === 'number' ? ' · ' + p.conn.pluginCount + ' 个' : '') + '</span></div>';
    html += '<table class="list"><thead><tr><th>插件</th><th>状态</th><th>操作</th></tr></thead><tbody>';
    if (!p.plugins.length) { html += '<tr><td colspan="3" class="empty">' + I.empty + '</td></tr>'; }
    p.plugins.forEach(function (pl) {
      var badge = pl.enabled ? '<span class="badge enabled">' + I.enabled + '</span>'
        : pl.installed ? '<span class="badge disabled">' + I.disabled + '</span>'
        : '<span class="badge avail">' + I.available + '</span>';
      var act = '';
      if (pl.installed) {
        act = pl.enabled
          ? '<button class="btn sm" data-plug-act="disable" data-name="' + esc(pl.name) + '">' + I.disable + '</button>'
          : '<button class="btn sm" data-plug-act="enable" data-name="' + esc(pl.name) + '">' + I.enable + '</button>';
        act += ' <button class="btn sm danger" data-plug-act="uninstall" data-name="' + esc(pl.name) + '">' + I.uninstall + '</button>';
      } else if (pl.source) {
        act = '<button class="btn sm" data-plug-act="install" data-name="' + esc(pl.name) + '" data-source="' + esc(pl.source) + '">' + I.install + '</button>';
      }
      html += '<tr><td>' + esc(pl.name) + '</td><td>' + badge + '</td><td>' + act + '</td></tr>';
    });
    html += '</tbody></table></div>';
    $('#content').innerHTML = html;
    bindFilter();
    bindPluginActions();
  }

  function renderLogs() {
    var html = '<div class="page"><h2>' + I.logs + '</h2><div class="sub">' + I.dashboard + ' · ' + I.dashboard + ' ' + I.logs + '</div>';
    html += '<div class="logtabs">';
    ['error', 'access', 'host', 'qaq'].forEach(function (tab) {
      html += '<button class="btn sm' + (state.logTab === tab ? ' primary' : '') + '" data-log-tab="' + tab + '">' + (I[tab] || tab) + '</button>';
    });
    html += '</div>';
    var lg = state.logs;
    if (!lg) { html += '<div class="logbox"><div class="empty">加载中…</div></div></div>'; $('#content').innerHTML = html; bindLogTabs(); return; }
    var body = '';
    if (!lg.lines.length) { body = '<span class="empty">' + I.none + '</span>'; }
    lg.lines.forEach(function (ln) {
      var cls = /error|warn/.test(ln) ? ' hl' : '';
      body += '<span class="ln' + cls + '">' + esc(ln) + '</span>';
    });
    html += '<div class="logbox" id="logbox">' + body + '</div>';
    html += '<div class="sub" style="margin-top:8px">共 ' + lg.total + ' 行 · 显示 ' + lg.lines.length + ' 行</div></div>';
    $('#content').innerHTML = html;
    bindLogTabs();
    // Scroll to bottom on load.
    var box = $('#logbox'); if (box) box.scrollTop = box.scrollHeight;
  }

  function renderHot() {
    var st = state.status;
    var html = '<div class="page"><h2>' + I.hot + '</h2><div class="sub">' + I.dashboard + ' · ' + I.hot + '</div>';
    var w = st.hot && st.hot.watching;
    var rw = st.hot && st.hot.restartWatch;
    html += '<div class="rows">';
    html += '<div class="row"><span class="rk">' + I.hotWatch + '</span><label class="toggle"><input type="checkbox" data-hot="watch"' + (w ? ' checked' : '') + '/><span class="track"></span><span>' + (w ? '开' : '关') + '</span></label></div>';
    html += '<div class="row"><span class="rk">' + I.hotRestartBundles + '</span><label class="toggle"><input type="checkbox" data-hot="bundles"' + (rw && rw.bundles ? ' checked' : '') + '/><span class="track"></span><span>' + (rw && rw.bundles ? '开' : '关') + '</span></label></div>';
    html += '<div class="row"><span class="rk">' + I.hotRestartDist + '</span><label class="toggle"><input type="checkbox" data-hot="dist"' + (rw && rw.dist ? ' checked' : '') + '/><span class="track"></span><span>' + (rw && rw.dist ? '开' : '关') + '</span></label></div>';
    html += '</div>';
    html += '<div class="section">' + I.events + '</div><div class="events">';
    var evs = (st.hot && st.hot.events) || [];
    if (!evs.length) html += '<div class="evt">' + I.none + '</div>';
    evs.forEach(function (e) { html += '<div class="evt">' + esc(e) + '</div>'; });
    html += '</div></div>';
    $('#content').innerHTML = html;
    bindHot();
  }

  function renderSettings() {
    var st = state.status;
    var html = '<div class="page"><h2>' + I.settings + '</h2><div class="sub">' + I.dashboard + '</div>';
    html += '<div class="rows">';
    html += row('Profile', esc(st.profile));
    html += row('Home', esc(st.home), 'mono');
    html += row('QAQ 版本', st.version ? 'v' + st.version : '-');
    html += row('DSH 版本', st.dshVersion ? 'v' + st.dshVersion : '-');
    html += row('Checkout', esc(st.checkout || '-'), 'mono');
    html += row('进程', st.processUp ? ('pid=' + st.processPid + (st.processPort ? ' port=' + st.processPort : '')) : '未运行');
    html += '</div>';
    html += '<div class="section">' + I.updateCheck + '</div>';
    html += '<div class="actions"><button class="btn" data-act="update-check">' + I.updateCheck + '</button></div>';
    html += '<div class="rows" id="update-result"></div>';
    html += '</div>';
    $('#content').innerHTML = html;
    bindActions();
  }

  /* ---------------- action binding ---------------- */
  function bindActions() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-act]'), function (el) {
      el.addEventListener('click', function () { doAction(el.getAttribute('data-act')); });
    });
  }
  function bindRestore() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-restore]'), function (el) {
      el.addEventListener('click', function () {
        var dir = el.getAttribute('data-restore');
        if (!confirm('还原到此快照？' + dir)) return;
        apiAction({ action: 'restore', dir: dir }).then(function (r) { toast(r.message || '完成'); refreshAll(); });
      });
    });
  }
  function bindPluginActions() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-plug-act]'), function (el) {
      el.addEventListener('click', function () {
        var act = el.getAttribute('data-plug-act');
        var name = el.getAttribute('data-name');
        var body = { action: 'plugin-' + act, name: name };
        if (act === 'install') body.source = el.getAttribute('data-source');
        apiAction(body).then(function (r) { toast(r.message || '完成'); refreshAll(); });
      });
    });
  }
  function bindFilter() {
    var input = $('#plugin-filter');
    if (!input) return;
    input.addEventListener('input', function () {
      state.pluginFilter = input.value;
      clearTimeout(input._tm);
      input._tm = setTimeout(function () { refreshPlugins(); }, 250);
    });
  }
  function bindLogTabs() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-log-tab]'), function (el) {
      el.addEventListener('click', function () { state.logTab = el.getAttribute('data-log-tab'); state.logScroll = 0; refreshLogs(); });
    });
  }
  function bindHot() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-hot]'), function (el) {
      el.addEventListener('change', function () {
        var k = el.getAttribute('data-hot');
        var on = el.checked;
        if (k === 'watch') apiAction({ action: 'hot-watch', on: on }).then(function (r) { toast(r.message || '完成'); refreshAll(); });
        else {
          var bundles = document.querySelector('[data-hot="bundles"]') && document.querySelector('[data-hot="bundles"]').checked;
          var dist = document.querySelector('[data-hot="dist"]') && document.querySelector('[data-hot="dist"]').checked;
          apiAction({ action: 'hot-restart', bundles: bundles, dist: dist }).then(function (r) { toast(r.message || '完成'); refreshAll(); });
        }
      });
    });
  }

  /* ---------------- actions ---------------- */
  function doAction(act) {
    var st = state.status || {};
    if (act === 'launch') {
      if (!confirm('启动受监督的 dsh web？（将接管并守卫 DSH）')) return;
      apiAction({ action: 'launch', yes: true }).then(function (r) { toast(r.message || '完成'); refreshAll(); });
    } else if (act === 'stop') {
      if (!confirm('停止受监督的 dsh web？')) return;
      apiAction({ action: 'stop' }).then(function (r) { toast(r.message || '完成'); refreshAll(); });
    } else if (act === 'backup') {
      apiAction({ action: 'backup' }).then(function (r) { toast(r.message || '完成'); refreshAll(); });
    } else if (act === 'reset') {
      if (!confirm('重置失败计数？')) return;
      apiAction({ action: 'reset' }).then(function (r) { toast(r.message || '完成'); refreshAll(); });
    } else if (act === 'install-plugin') {
      apiAction({ action: 'install-plugin' }).then(function (r) { toast(r.message || '完成'); refreshAll(); });
    } else if (act === 'watch-toggle') {
      apiAction({ action: 'watch-toggle' }).then(function (r) { toast(r.message || '完成'); refreshAll(); });
    } else if (act === 'update-check') {
      apiAction({ action: 'update-check' }).then(function (r) {
        var el = $('#update-result');
        if (el) {
          var h = '';
          h += '<div class="row"><span class="rk">' + I.qaqUpd + '</span><span class="rv">' +
            (r.qaq && r.qaq.updateAvailable ? '有更新 v' + r.qaq.latest : '已是最新 v' + (r.qaq && r.qaq.current)) + '</span></div>';
          h += '<div class="row"><span class="rk">' + I.dshUpd + '</span><span class="rv">' +
            (r.dsh && r.dsh.updateAvailable ? '有更新 v' + r.dsh.latest : '已是最新' + (r.dsh && r.dsh.current ? ' v' + r.dsh.current : '')) + '</span></div>';
          el.innerHTML = h;
        }
        toast('更新检查完成');
      });
    }
  }

  /* ---------------- refresh ---------------- */
  function refreshAll() {
    if (state.view === 'backups') refreshBackups();
    else if (state.view === 'plugins') refreshPlugins();
    else if (state.view === 'logs') refreshLogs();
    renderTopbar();
  }
  function refreshBackups() {
    apiGet('/api/backups').then(function (d) { state.backups = d; render(); });
  }
  function refreshPlugins() {
    apiGet('/api/plugins?filter=' + encodeURIComponent(state.pluginFilter)).then(function (d) { state.plugins = d; render(); });
  }
  function refreshLogs() {
    apiGet('/api/logs?tab=' + state.logTab + '&scroll=' + state.logScroll + '&max=60').then(function (d) { state.logs = d; render(); });
  }

  /* ---------------- ws ---------------- */
  function connectWS() {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var ws = new WebSocket(proto + location.host + '/api/stream');
    state.ws = ws;
    ws.onmessage = function (ev) {
      try {
        var msg = JSON.parse(ev.data);
        if (msg.type === 'status') {
          state.status = msg.data;
          renderTopbar();
          if (state.view === 'dashboard' || state.view === 'guard' || state.view === 'hot' || state.view === 'settings') render();
        }
      } catch (e) {}
    };
    ws.onclose = function () { state.wsOk = false; setTimeout(connectWS, 1500); };
    ws.onopen = function () { state.wsOk = true; };
  }

  /* ---------------- theme ---------------- */
  function applyTheme(t) {
    var dark = t === 'dark' || (t === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) document.body.setAttribute('data-ds-dark-theme', '');
    else document.body.removeAttribute('data-ds-dark-theme');
    try { localStorage.setItem('qaq-theme', t); } catch (e) {}
    Array.prototype.forEach.call(document.querySelectorAll('#theme-toggle button'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-theme') === t);
    });
  }
  function initTheme() {
    var t = window.__qaqTheme || 'system';
    applyTheme(t);
    Array.prototype.forEach.call(document.querySelectorAll('#theme-toggle button'), function (b) {
      b.addEventListener('click', function () { applyTheme(b.getAttribute('data-theme')); });
    });
    $('#btn-theme').addEventListener('click', function () {
      var cur = localStorage.getItem('qaq-theme') || 'system';
      applyTheme(cur === 'dark' ? 'light' : 'dark');
    });
  }

  /* ---------------- boot ---------------- */
  buildNav();
  initTheme();
  connectWS();
  // Initial data loads.
  apiGet('/api/status').then(function (d) { state.status = d; render(); renderTopbar(); });
  refreshBackups(); refreshPlugins(); refreshLogs();
})();
