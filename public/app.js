const $ = id => document.getElementById(id);
let csrf = '';
let initialized = false;
let settings = null;
let dashboard = null;
let dirty = false;
let currentPage = 'overview';
let resolvingId = null;
const numbers = ['catchUpHours', 'maxAttempts', 'retryBaseSeconds', 'retryMaxSeconds', 'timeoutSeconds', 'pollSeconds'];
const statuses = { pending: '等待发送', checking: '检查权限', sending: '正在发送', sent: '发送成功', failed: '发送失败', uncertain: '结果待核查', skipped: '已跳过' };
const events = { admin_started: '管理后台已启动', admin_created: '管理员已创建', admin_login: '管理员登录', settings_saved: '更新了群组与发送设置', job_created: '创建季度通知任务', job_sent: '通知发送成功', job_retry: '等待重试发送', job_failed: '任务发送失败', job_uncertain: '发送结果需要核查', manual_resolution: '人工处理了发送任务', admin_password_changed: '管理员密码已更新', service_stopped: '服务已停止' };
const date = n => n ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(n)) : '—';
function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { $('toast').hidden = true; }, 5000); }
async function api(path, method = 'GET', data) {
  const headers = {};
  if (method !== 'GET') { headers['Content-Type'] = 'application/json'; headers['X-CSRF-Token'] = csrf; }
  const result = await fetch('/api/' + path, { method, headers, credentials: 'same-origin', body: data === undefined ? undefined : JSON.stringify(data) });
  const value = await result.json();
  if (!result.ok) {
    if (result.status === 401 && !['login', 'setup'].includes(path)) await boot();
    throw new Error(value.error || '操作未完成，请重试');
  }
  return value;
}
async function action(button, fn) { if (button) button.disabled = true; try { await fn(); } catch (e) { toast(e.message); } finally { if (button) button.disabled = false; } }
function showPage(page) {
  if (currentPage === 'settings' && page !== 'settings' && dirty && !confirm('设置尚未保存。确认离开？未保存的修改会继续保留在表单中。')) return;
  currentPage = page;
  document.querySelectorAll('.page').forEach(node => { node.hidden = node.id !== 'page-' + page; });
  document.querySelectorAll('[data-page]').forEach(node => node.classList.toggle('active', node.dataset.page === page));
  $('breadcrumb').textContent = '工作空间 / ' + ({ overview: '总览', settings: '群组与设置', history: '发送记录', security: '账户安全' }[page]);
  if (page === 'overview' || page === 'history') refresh().catch(e => toast(e.message));
}
function markDirty() { dirty = true; $('save-indicator').textContent = '有未保存的修改'; $('settings-error').textContent = ''; }
function groupRow(category, value = { name: '', chatId: '' }) {
  const row = el('div', undefined, 'group-row');
  const head = el('div'); head.append(el('span', '群组信息'));
  const remove = el('button', '移除', 'remove-group'); remove.type = 'button'; remove.addEventListener('click', () => { row.remove(); markDirty(); }); head.append(remove); row.append(head);
  for (const [field, title, placeholder] of [['name', '群名称', '例如：A 类合租群'], ['chatId', '群 ID', '例如：-1001234567890']]) {
    const label = el('label', title); const input = el('input'); input.value = value[field] || ''; input.required = true;
    input.dataset.field = field; input.placeholder = placeholder; input.maxLength = field === 'name' ? 128 : 20;
    label.append(input); row.append(label);
  }
  $('groups-' + category).append(row);
}
function fillSettings(value) {
  settings = value; $('enabled').checked = value.enabled; $('bot-token').value = '';
  $('token-state').textContent = value.hasToken ? '已安全保存' : '未配置'; $('token-state').className = 'pill' + (value.hasToken ? ' success' : '');
  for (const category of ['A', 'B']) {
    $('groups-' + category).replaceChildren(); value.classes[category].groups.forEach(g => groupRow(category, g)); $('template-' + category).value = value.classes[category].template;
  }
  numbers.forEach(key => { $(key).value = value[key]; }); dirty = false; $('save-indicator').textContent = '所有设置已保存';
}
function collect() {
  const classes = {};
  for (const category of ['A', 'B']) {
    classes[category] = { template: $('template-' + category).value, groups: [...$('groups-' + category).children].map(row => ({
      name: row.querySelector('[data-field=name]').value.trim(), chatId: row.querySelector('[data-field=chatId]').value.trim(),
    })) };
  }
  return { revision: settings.revision, enabled: $('enabled').checked, token: $('bot-token').value.trim(), classes,
    ...Object.fromEntries(numbers.map(key => [key, Number($(key).value)])) };
}
function empty(message) { const div = el('div', undefined, 'empty'); div.append(el('span', '◷', 'empty-icon'), el('span', message)); return div; }
function renderJobs(container, jobs, compact = false) {
  container.replaceChildren(); if (!jobs.length) { container.append(empty('还没有发送记录。配置完成后，季度到期时会自动生成任务。')); return; }
  const wrap = el('div', undefined, 'table-wrap'); const table = el('table'); const thead = el('thead'); const tr = el('tr');
  ['群组 / 类别', '季度', '状态', '最近更新', ...(compact ? [] : ['尝试次数', '操作'])].forEach(t => tr.append(el('th', t))); thead.append(tr); table.append(thead);
  const tbody = el('tbody');
  for (const job of jobs) {
    const row = el('tr'); const group = el('td'); const groupName = settings && Object.values(settings.classes).flatMap(c => c.groups).find(g => g.chatId === job.chat_id)?.name;
    group.append(el('span', (groupName || job.chat_id) + ' · ' + job.category + '类'), el('span', job.chat_id, 'sub')); row.append(group, el('td', job.quarter));
    const state = el('td'); state.append(el('span', statuses[job.status] || job.status, 'pill ' + job.status));
    if (!compact && job.last_error) state.append(el('span', job.last_error, 'sub')); row.append(state, el('td', date(job.updated_at)));
    if (!compact) {
      row.append(el('td', String(job.attempts))); const operation = el('td');
      if (['failed', 'uncertain'].includes(job.status)) { const button = el('button', '处理任务', 'text-button'); button.type = 'button'; button.addEventListener('click', () => openResolve(job)); operation.append(button); }
      else operation.textContent = job.message_id ? '回执 #' + job.message_id : '—'; row.append(operation);
    }
    tbody.append(row);
  }
  table.append(tbody); wrap.append(table); container.append(wrap);
}
function renderHistory() {
  if (!dashboard) return;
  const filter = $('history-filter').value;
  const jobs = dashboard.jobs.filter(j => filter === 'all' || (filter === 'attention' ? ['failed', 'uncertain'].includes(j.status) : j.status === filter));
  renderJobs($('all-jobs'), jobs);
}
async function refresh() {
  dashboard = await api('dashboard');
  $('next-date').textContent = dashboard.nextDue.split(' ')[0].replaceAll('-', ' / ');
  $('service-state').textContent = dashboard.enabled ? '运行中' : '已暂停'; $('service-state').className = dashboard.enabled ? 'good' : '';
  $('service-description').textContent = dashboard.busy ? '当前正在处理发送任务' : dashboard.enabled ? '等待下一个季度提醒' : '可在设置中启用';
  $('group-count').textContent = dashboard.groupCount; $('sent-count').textContent = dashboard.counts.sent || 0;
  const attention = (dashboard.counts.failed || 0) + (dashboard.counts.uncertain || 0); $('attention-count').textContent = attention; $('attention-count').className = attention ? 'attention' : '';
  $('onboarding').hidden = dashboard.initialized && dashboard.groupCount > 0;
  renderJobs($('recent-jobs'), dashboard.jobs.slice(0, 5), true); renderHistory();
  $('events').replaceChildren();
  if (!dashboard.events.length) $('events').append(empty('暂无活动'));
  for (const item of dashboard.events.slice(0, 8)) {
    const row = el('div', undefined, 'activity-row'); row.append(el('span', item.level === 'error' ? '!' : '↗', 'activity-icon'), el('span', events[item.event] || item.event), el('time', date(item.time))); $('events').append(row);
  }
}
async function boot() {
  const state = await api('session'); initialized = state.initialized; csrf = state.csrf || '';
  $('workspace').hidden = !state.authenticated; $('auth-view').hidden = state.authenticated;
  if (!state.authenticated) {
    $('setup-key-label').hidden = initialized; $('setup-help').hidden = initialized; $('setup-key').required = !initialized;
    $('auth-title').textContent = initialized ? '登录管理后台' : '创建管理员';
    $('auth-description').textContent = initialized ? '继续管理你的季度续费提醒。' : '只需一次设置，之后直接在后台管理。';
    $('auth-submit').textContent = initialized ? '登录后台 →' : '创建账户，开始设置 →';
    $('password').autocomplete = initialized ? 'current-password' : 'new-password'; $('password').minLength = initialized ? 1 : 12;
    return;
  }
  $('current-user').textContent = state.username; document.querySelector('.user-avatar').textContent = state.username.slice(0, 1).toUpperCase();
  fillSettings(await api('settings')); await refresh();
}
$('auth-form').addEventListener('submit', async event => {
  event.preventDefault(); $('auth-error').textContent = ''; const button = $('auth-submit'); button.disabled = true;
  try { const result = await api(initialized ? 'login' : 'setup', 'POST', { key: $('setup-key').value.trim(), username: $('username').value.trim(), password: $('password').value }); csrf = result.csrf; $('password').value = ''; $('setup-key').value = ''; dirty = false; await boot(); }
  catch (e) { $('auth-error').textContent = e.message; } finally { button.disabled = false; }
});
document.querySelectorAll('[data-page]').forEach(b => b.addEventListener('click', () => showPage(b.dataset.page)));
document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => showPage(b.dataset.go)));
document.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => { groupRow(b.dataset.add); markDirty(); }));
$('settings-form').addEventListener('input', markDirty);
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = $('save-settings'); button.disabled = true; $('settings-error').textContent = '';
  try { const value = collect(); if (value.enabled && !settings.enabled && !confirm('开启后，若有过去补发窗口内的到期通知，将自动发送。确认开启？')) return;
    fillSettings(await api('settings', 'PUT', value)); toast('设置已保存，已自动生效'); await refresh(); }
  catch (e) { $('settings-error').textContent = e.message; } finally { button.disabled = false; }
});
$('refresh').addEventListener('click', () => action($('refresh'), refresh));
$('logout').addEventListener('click', () => action($('logout'), async () => { if (dirty && !confirm('有未保存的设置，确认退出？')) return; await api('logout', 'POST', {}); dirty = false; await boot(); }));
$('history-filter').addEventListener('change', renderHistory);
$('preview').addEventListener('click', () => action($('preview'), async () => {
  if (!$('settings-form').reportValidity()) return;
  const value = await api('preview', 'POST', collect()); $('preview-content').replaceChildren();
  if (!value.messages.length) $('preview-content').append(empty('先添加一个群组，即可预览消息。'));
  for (const m of value.messages) { const card = el('div', undefined, 'preview-card'); card.append(el('h3', m.name + ' · ' + m.category + '类'), el('span', value.quarter + ' / ' + value.due + ' 北京时间', 'small muted'), el('pre', m.text)); $('preview-content').append(card); }
  $('preview-dialog').showModal();
}));
$('close-preview').addEventListener('click', () => $('preview-dialog').close());
$('check-permissions').addEventListener('click', () => action($('check-permissions'), async () => {
  if (dirty) throw new Error('请先保存设置，再检查已保存的机器人和群权限');
  const result = await api('check', 'POST', {}); const box = $('check-results'); box.hidden = false; box.replaceChildren(el('strong', '机器人：@' + result.bot));
  if (!result.results.length) box.append(el('p', '机器人连接正常。添加群组后可继续检查群内发言权限。'));
  for (const row of result.results) box.append(el('p', (row.ok ? '✓ ' : '! ') + row.name + '：' + (row.ok ? '可以发送通知' : row.error), row.ok ? 'good-text' : 'bad-text'));
}));
$('discover-groups').addEventListener('click', () => action($('discover-groups'), async () => {
  if (dirty) throw new Error('请先保存 Token 和当前设置，再发现群组');
  const result = await api('discover', 'POST', {}); const box = $('discovered'); box.hidden = false; box.replaceChildren();
  box.append(el('p', result.groups.length ? '选择群所属类别，添加后记得保存。' : '未找到群。请先把机器人加入群，并在群内发送 /setup@你的机器人用户名，然后重试。'));
  for (const group of result.groups) {
    const row = el('div', undefined, 'result-row'); const label = el('span', group.name); label.append(el('span', group.chatId, 'sub')); row.append(label);
    for (const category of ['A', 'B']) { const button = el('button', '加入 ' + category + ' 类', 'text-button'); button.type = 'button'; button.addEventListener('click', () => {
      if ([...document.querySelectorAll('[data-field=chatId]')].some(i => i.value.trim() === group.chatId)) { toast('这个群已经添加'); return; }
      groupRow(category, group); markDirty(); toast('群已添加，请保存设置');
    }); row.append(button); } box.append(row);
  }
}));
function openResolve(job) { resolvingId = job.id; $('resolve-description').textContent = '任务 #' + job.id + ' · ' + job.quarter + ' · 群 ' + job.chat_id; $('resolve-decision').value = 'sent'; $('resolve-ack').checked = false; $('resolve-error').textContent = ''; $('resolve-dialog').showModal(); }
$('cancel-resolve').addEventListener('click', () => $('resolve-dialog').close());
$('resolve-form').addEventListener('submit', async event => { event.preventDefault(); const button = event.submitter; button.disabled = true;
  try { await api('resolve', 'POST', { id: resolvingId, decision: $('resolve-decision').value, ackDuplicateRisk: $('resolve-ack').checked }); $('resolve-dialog').close(); toast('任务处理完成'); await refresh(); }
  catch (e) { $('resolve-error').textContent = e.message; } finally { button.disabled = false; }
});
$('password-form').addEventListener('submit', async event => { event.preventDefault(); const button = event.submitter; button.disabled = true; $('password-error').textContent = '';
  try { if ($('new-password').value !== $('repeat-password').value) throw new Error('两次新密码不一致'); await api('password', 'POST', { currentPassword: $('current-password').value, newPassword: $('new-password').value }); $('password-form').reset(); toast('密码已更新，请重新登录'); await boot(); }
  catch (e) { $('password-error').textContent = e.message; } finally { button.disabled = false; }
});
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
setInterval(() => { if (!$('workspace').hidden && ['overview', 'history'].includes(currentPage)) refresh().catch(() => {}); }, 15000);
boot().catch(e => { $('auth-view').hidden = false; $('auth-error').textContent = '后台连接失败：' + e.message; });
