const $ = id => document.getElementById(id);
let csrf = '';
let initialized = false;
let meta = null;
let dashboard = null;
let currentBot = null;
let dirty = false;
let resolvingId = null;
let route = { page: 'overview' };
const statuses = { pending: '等待发送', checking: '检查权限', sending: '正在发送', sent: '发送成功', failed: '发送失败', uncertain: '结果待核查', skipped: '已跳过' };
const events = { admin_started: '管理后台已启动', admin_created: '管理员已创建', admin_login: '管理员登录', bot_created: '新建了机器人', bot_saved: '更新了机器人配置', bot_deleted: '删除了机器人', bot_enabled: '启用了机器人', bot_paused: '暂停了机器人', bot_checked: '检查了发送权限', test_sent: '发送了测试消息', job_created: '创建发送任务', job_sent: '消息发送成功', job_retry: '等待重试发送', job_failed: '任务发送失败', job_uncertain: '发送结果需要核查', manual_resolution: '人工处理了发送任务', admin_password_changed: '管理员密码已更新', schedule_failed: '计划执行失败', occurrences_skipped: '停机期间跳过了较早的时间点', loop_error: '后台循环出错', service_stopped: '服务已停止' };
const cronPresets = [['0 10 L 3,6,9,12 *', '每季度最后一天 10:00'], ['0 9 * * *', '每天 9:00'], ['0 9 * * 1-5', '工作日 9:00'], ['0 9 * * 1', '每周一 9:00'], ['0 10 1 * *', '每月 1 日 10:00'], ['0 10 L * *', '每月最后一天 10:00'], ['0 * * * *', '每小时整点']];
const date = n => n ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(n)) : '—';
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
function empty(message) { const div = el('div', undefined, 'empty'); div.append(el('span', '◷', 'empty-icon'), el('span', message)); return div; }
function markDirty() { dirty = true; $('save-indicator').textContent = '有未保存的修改'; $('bot-error').textContent = ''; }

// ---------- 路由 ----------
function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'bots' && /^\d+$/.test(parts[1] || '')) return { page: 'bot', id: Number(parts[1]), tab: ['guide', 'settings', 'jobs'].includes(parts[2]) ? parts[2] : 'guide' };
  return { page: ['overview', 'bots', 'jobs', 'help', 'security'].includes(parts[0]) ? parts[0] : 'overview' };
}
const names = { overview: '总览', bots: '机器人', bot: '机器人', jobs: '发送记录', help: '使用指南', security: '账户安全' };
async function navigate() {
  const next = parseRoute();
  const leaving = route.page === 'bot' && route.tab === 'settings' && !(next.page === 'bot' && next.id === route.id && next.tab === 'settings');
  if (leaving && dirty && !confirm('设置尚未保存，确认离开？')) { location.hash = `#/bots/${route.id}/settings`; return; }
  if (leaving) dirty = false;
  route = next;
  document.querySelectorAll('.page').forEach(node => { node.hidden = node.id !== 'page-' + route.page; });
  const navKey = route.page === 'bot' ? 'bots' : route.page;
  document.querySelectorAll('[data-nav]').forEach(node => node.classList.toggle('active', node.dataset.nav === navKey));
  $('breadcrumb').textContent = '工作空间 / ' + names[route.page];
  try {
    if (route.page === 'bot') await openBot(route.id, route.tab);
    else if (['overview', 'bots', 'jobs'].includes(route.page)) await refresh();
    else if (route.page === 'help') renderHelp();
  } catch (e) { toast(e.message); }
}
window.addEventListener('hashchange', navigate);

// ---------- 总览与列表 ----------
function nextRun(bot) { return bot.upcoming.find(item => item.nextAt)?.nextAt; }
function botCard(bot) {
  const card = el('a', undefined, 'bot-card'); card.href = `#/bots/${bot.id}`;
  const head = el('div', undefined, 'bot-card-head'); head.append(el('strong', bot.name), el('span', bot.enabled ? '运行中' : '已暂停', 'pill ' + (bot.enabled ? 'success' : '')));
  const lines = el('div', undefined, 'bot-card-body');
  lines.append(el('span', `${bot.typeName}${bot.username ? ' · @' + bot.username : ''}`, 'muted small'));
  lines.append(el('span', bot.hasToken ? `${bot.targetCount} 个目标 · ${bot.upcoming.length} 个计划` : '未配置 Token，点开查看向导', 'small'));
  const at = nextRun(bot);
  lines.append(el('span', at ? (bot.enabled ? '下次执行：' : '启用后下次执行：') + date(at) : '没有计划', 'small muted'));
  card.append(head, lines); return card;
}
function renderJobs(container, jobs, compact = false) {
  container.replaceChildren(); if (!jobs.length) { container.append(empty('还没有发送记录。启用机器人后，到点会自动生成任务。')); return; }
  const wrap = el('div', undefined, 'table-wrap'); const table = el('table'); const thead = el('thead'); const tr = el('tr');
  ['机器人 / 计划', '目标', '时间点', '状态', '最近更新', ...(compact ? [] : ['尝试次数', '操作'])].forEach(t => tr.append(el('th', t))); thead.append(tr); table.append(thead);
  const tbody = el('tbody');
  for (const job of jobs) {
    const row = el('tr'); const bot = el('td'); bot.append(el('span', job.bot_name), el('span', job.label, 'sub'));
    row.append(bot, el('td', job.chat_id), el('td', job.occurrence.replace('T', ' ')));
    const state = el('td'); state.append(el('span', statuses[job.status] || job.status, 'pill ' + job.status));
    if (!compact && job.last_error) state.append(el('span', job.last_error, 'sub')); row.append(state, el('td', date(job.updated_at)));
    if (!compact) {
      row.append(el('td', `${job.attempts} / ${job.max_attempts}`)); const operation = el('td');
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
  renderJobs($('all-jobs'), dashboard.jobs.filter(j => filter === 'all' || (filter === 'attention' ? ['failed', 'uncertain'].includes(j.status) : j.status === filter)));
}
async function refresh() {
  dashboard = await api('dashboard');
  const running = dashboard.bots.filter(bot => bot.enabled);
  $('metric-running').textContent = running.length; $('metric-total').textContent = `共 ${dashboard.bots.length} 个机器人`;
  const upcoming = running.map(bot => ({ bot, at: nextRun(bot) })).filter(item => item.at).sort((a, b) => a.at - b.at)[0];
  $('metric-next').textContent = upcoming ? date(upcoming.at) : '—'; $('metric-next-bot').textContent = upcoming ? upcoming.bot.name : '暂无运行中的计划';
  $('metric-sent').textContent = dashboard.counts.sent || 0;
  const attention = (dashboard.counts.failed || 0) + (dashboard.counts.uncertain || 0); $('metric-attention').textContent = attention; $('metric-attention').className = attention ? 'attention' : '';
  $('onboarding').hidden = dashboard.bots.length > 0;
  for (const id of ['overview-bots', 'bot-list']) {
    $(id).replaceChildren(...dashboard.bots.map(botCard));
    if (!dashboard.bots.length) $(id).append(empty('还没有机器人，点「新建机器人」开始。'));
  }
  renderJobs($('recent-jobs'), dashboard.jobs.slice(0, 5), true); renderHistory();
  if (route.page === 'bot') renderJobs($('bot-jobs'), dashboard.jobs.filter(j => j.bot_id === route.id));
  $('events').replaceChildren();
  if (!dashboard.events.length) $('events').append(empty('暂无活动'));
  for (const item of dashboard.events.slice(0, 8)) {
    const row = el('div', undefined, 'activity-row'); row.append(el('span', item.level === 'error' ? '!' : '↗', 'activity-icon'), el('span', events[item.event] || item.event), el('time', date(item.time))); $('events').append(row);
  }
}

// ---------- 由类型声明生成的表单 ----------
function cronField(field, value, onTimeZone) {
  const wrap = el('div', undefined, 'cron-field');
  const label = el('label', field.label); const input = el('input'); input.value = value ?? field.default ?? ''; input.required = field.required === true; input.dataset.cron = '1'; input.spellcheck = false; input.placeholder = '分 时 日 月 周，例如 0 10 L 3,6,9,12 *'; label.append(input);
  const presets = el('select', undefined, 'cron-presets'); presets.setAttribute('aria-label', '常用时间');
  presets.append(new Option('常用时间…', ''));
  for (const [cron, name] of cronPresets) presets.append(new Option(name, cron));
  const preview = el('div', undefined, 'cron-preview');
  let timer;
  const update = async () => {
    const cron = input.value.trim();
    if (!cron) { preview.replaceChildren(el('span', '请填写 cron 表达式', 'bad-text')); return; }
    try {
      const result = await api('cron', 'POST', { cron, timeZone: onTimeZone() });
      const list = el('div', undefined, 'cron-runs'); result.runs.forEach(run => list.append(el('span', run)));
      preview.replaceChildren(el('strong', result.description), el('span', `接下来 5 次（${result.timeZone}）`, 'small muted'), list);
    } catch (e) { preview.replaceChildren(el('span', e.message, 'bad-text')); }
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(update, 300); };
  input.addEventListener('input', schedule);
  input.addEventListener('refresh-cron', update);
  presets.addEventListener('change', () => { if (presets.value) { input.value = presets.value; presets.value = ''; markDirty(); update(); } });
  wrap.append(label, presets, preview); wrap.read = () => input.value.trim();
  update(); return wrap;
}
function chatRow(container, value = { name: '', chatId: '' }) {
  const row = el('div', undefined, 'chat-row'); row.dataset.chat = '1';
  for (const [key, title, placeholder] of [['name', '名称', '例如：A 类合租群'], ['chatId', 'ID', '-1001234567890']]) {
    const input = el('input'); input.value = value[key] || ''; input.required = true; input.placeholder = placeholder; input.dataset.key = key; input.setAttribute('aria-label', title); input.maxLength = key === 'name' ? 128 : 24; row.append(input);
  }
  const remove = el('button', '移除', 'remove-group'); remove.type = 'button'; remove.addEventListener('click', () => { row.remove(); markDirty(); }); row.append(remove);
  container.append(row);
}
function chatsField(field, value) {
  const wrap = el('div', undefined, 'chats-field'); wrap.append(el('div', field.label, 'field-label'));
  const rows = el('div', undefined, 'chat-rows'); (value || []).forEach(chat => chatRow(rows, chat));
  const add = el('button', '＋ 手动添加', 'text-button'); add.type = 'button'; add.addEventListener('click', () => { chatRow(rows); markDirty(); });
  wrap.append(rows, add, el('small', '群和频道的 ID 是负整数。不知道 ID 时，到「配置向导」点「发现机器人所在群」会自动带出来。', 'field-help')); wrap.dataset.chats = '1'; wrap.chatRows = rows;
  wrap.read = () => [...rows.children].map(row => ({ name: row.querySelector('[data-key=name]').value.trim(), chatId: row.querySelector('[data-key=chatId]').value.trim() }));
  return wrap;
}
function listField(field, value, timeZone) {
  const wrap = el('div', undefined, 'panel settings-panel');
  const head = el('div', undefined, 'setting-heading'); head.append(el('h2', field.label));
  const add = el('button', `＋ 添加${field.itemLabel || '一项'}`, 'text-button'); add.type = 'button'; head.append(add); wrap.append(head);
  const items = el('div', undefined, 'list-items'); wrap.append(items);
  const appendItem = item => {
    const box = el('div', undefined, 'list-item'); const fields = buildFields(field.fields, item || {}, timeZone);
    const remove = el('button', '删除这项', 'remove-group'); remove.type = 'button'; remove.addEventListener('click', () => { box.remove(); markDirty(); });
    const bar = el('div', undefined, 'list-item-bar'); bar.append(el('span', field.itemLabel || '项目', 'small muted'), remove);
    box.append(bar, ...fields.nodes); box.read = () => ({ ...(item?.id ? { id: item.id } : {}), ...fields.read() }); items.append(box);
  };
  (value || []).forEach(appendItem);
  add.addEventListener('click', () => { appendItem(); markDirty(); });
  wrap.read = () => [...items.children].map(box => box.read());
  return wrap;
}
function buildFields(fields, value, timeZone) {
  const readers = {}; const nodes = [];
  for (const field of fields) {
    const current = value[field.key];
    let node;
    if (field.type === 'cron') node = cronField(field, current, timeZone);
    else if (field.type === 'chats') node = chatsField(field, current);
    else if (field.type === 'list') node = listField(field, current, timeZone);
    else {
      node = el('label', field.label); let input;
      if (field.type === 'textarea') { input = el('textarea'); input.rows = field.rows || 5; input.value = current ?? field.default ?? ''; }
      else if (field.type === 'select') { input = el('select'); field.options.forEach(option => input.append(new Option(option.label, option.value))); input.value = current ?? field.default ?? ''; }
      else if (field.type === 'boolean') { input = el('input'); input.type = 'checkbox'; input.checked = current ?? field.default ?? false; node.className = 'switch-label'; }
      else { input = el('input'); input.type = field.type === 'number' ? 'number' : 'text'; input.value = current ?? field.default ?? ''; if (field.min !== undefined) input.min = field.min; if (field.max !== undefined) input.max = field.max; }
      if (field.required && field.type !== 'boolean') input.required = true;
      if (field.maxLength) input.maxLength = field.maxLength;
      if (field.placeholder) input.placeholder = field.placeholder;
      node.append(input);
      node.read = () => field.type === 'boolean' ? input.checked : field.type === 'number' ? (input.value === '' ? null : Number(input.value)) : input.value;
    }
    if (field.help && !['list', 'chats', 'cron'].includes(field.type)) node.append(el('small', field.help, 'field-help'));
    if (field.help && field.type === 'cron') node.append(el('small', field.help, 'field-help'));
    readers[field.key] = node.read; nodes.push(node);
  }
  return { nodes, read: () => Object.fromEntries(Object.entries(readers).map(([key, read]) => [key, read()])) };
}

// ---------- 单个机器人 ----------
let formFields = null; let optionFields = null;
async function openBot(id, tab) {
  const same = currentBot?.id === id;
  currentBot = await api('bots/' + id);
  renderBotHead();
  document.querySelectorAll('[data-tab]').forEach(node => { node.href = `#/bots/${id}/${node.dataset.tab}`; node.classList.toggle('active', node.dataset.tab === tab); });
  for (const name of ['guide', 'settings', 'jobs']) $('tab-' + name).hidden = name !== tab;
  $('breadcrumb').textContent = '工作空间 / 机器人 / ' + currentBot.name;
  if (tab === 'guide') renderGuide();
  if (tab === 'settings' && !(same && dirty)) fillForm();
  if (tab === 'jobs') { dashboard = await api('dashboard'); renderJobs($('bot-jobs'), dashboard.jobs.filter(j => j.bot_id === id)); }
}
function renderBotHead() {
  const bot = currentBot;
  $('bot-title').textContent = bot.name; $('bot-type-label').textContent = bot.typeName;
  const at = nextRun(bot);
  $('bot-subtitle').textContent = `${bot.username ? '@' + bot.username + ' · ' : ''}${bot.targetCount} 个目标 · ${at ? (bot.enabled ? '下次执行 ' : '启用后下次执行 ') + date(at) : '没有计划'}`;
  $('bot-state').textContent = bot.enabled ? '运行中' : '已暂停'; $('bot-state').className = 'pill ' + (bot.enabled ? 'success' : '');
  $('bot-toggle').textContent = bot.enabled ? '暂停' : '启用';
}
function fieldsOf(bot) { return meta.types.find(type => type.id === bot.type)?.fields; }
function fillForm() {
  const bot = currentBot;
  $('bot-name').value = bot.name; $('bot-timezone').value = bot.timeZone; $('bot-token').value = '';
  $('token-help').textContent = bot.hasToken ? `已保存${bot.username ? '，当前机器人 @' + bot.username : ''}。Token 保存后不再显示。` : '还没有 Token。在 Telegram 打开 @BotFather，发送 /newbot 创建后复制过来。';
  const fields = fieldsOf(bot);
  if (fields) { formFields = buildFields(fields, bot.config, () => $('bot-timezone').value.trim() || 'Asia/Shanghai'); $('type-fields').replaceChildren(...formFields.nodes); }
  else $('type-fields').replaceChildren(el('div', `类型 ${bot.type} 的代码不存在，配置已保留但无法编辑。`, 'notice'));
  optionFields = buildFields(meta.optionFields, bot.options, () => '');
  $('option-fields').replaceChildren(...optionFields.nodes);
  dirty = false; $('save-indicator').textContent = '所有设置已保存'; $('bot-error').textContent = '';
}
function collect() {
  return { revision: currentBot.revision, name: $('bot-name').value.trim(), timeZone: $('bot-timezone').value.trim(), token: $('bot-token').value.trim(), options: optionFields.read(), config: formFields.read() };
}
function renderGuide() {
  const guide = currentBot.guide;
  const bar = el('div', undefined, 'progress-track'); const fill = el('span'); fill.style.width = `${Math.round(guide.doneCount / guide.totalCount * 100)}%`; bar.append(fill);
  const done = guide.doneCount === guide.totalCount;
  $('guide-progress').replaceChildren(el('strong', done ? '配置完成，机器人运行中' : `必做步骤 ${guide.doneCount} / ${guide.totalCount}`), bar);
  const firstOpen = guide.steps.find(step => !step.done && !step.optional)?.id;
  $('guide-steps').replaceChildren(...guide.steps.map(step => {
    const item = el('li', undefined, 'guide-step' + (step.done ? ' done' : '') + (step.id === firstOpen ? ' current' : ''));
    const head = el('div', undefined, 'guide-head'); head.append(el('span', step.done ? '✓' : '', 'guide-mark'));
    const title = el('div', undefined, 'guide-title'); title.append(el('strong', step.title));
    if (step.optional) title.append(el('span', '可选', 'pill'));
    head.append(title, el('span', step.status, 'guide-status')); item.append(head);
    const body = el('div', undefined, 'guide-body'); const list = el('ul'); step.items.forEach(text => list.append(el('li', text))); body.append(list);
    if (step.note) body.append(el('p', step.note, 'guide-note'));
    const actions = el('div', undefined, 'button-row');
    for (const link of step.links || []) { const a = el('a', link.label + ' ↗', 'link-button'); a.href = link.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; actions.append(a); }
    if (step.tab) { const a = el('a', '去参数设置 →', 'link-button'); a.href = `#/bots/${currentBot.id}/${step.tab}`; actions.append(a); }
    const makeButton = (label, handler) => { const button = el('button', label, 'secondary'); button.type = 'button'; button.disabled = step.actionNeedsToken && !currentBot.hasToken; button.addEventListener('click', () => action(button, handler)); actions.append(button); };
    if (step.action === 'discover') makeButton('发现机器人所在群', discover);
    if (step.action === 'check') { makeButton('检查连接与权限', check); }
    if (step.action === 'test') makeButton('发送测试消息', openTest);
    if (step.action === 'enable') makeButton(currentBot.enabled ? '暂停机器人' : '启用机器人', toggleBot);
    if (actions.children.length) body.append(actions);
    if (step.action === 'check') { const box = el('div', undefined, 'result-box'); box.id = 'check-results'; box.hidden = true; body.append(box); }
    item.append(body); return item;
  }));
}
async function reloadBot() { currentBot = await api('bots/' + currentBot.id); renderBotHead(); if (route.tab === 'guide') renderGuide(); }
async function toggleBot() {
  const enabled = !currentBot.enabled;
  if (enabled && !confirm('启用后从此刻起按 cron 执行，已经过去的时间点不会补发。确认启用？')) return;
  await api(`bots/${currentBot.id}/enabled`, 'POST', { enabled });
  toast(enabled ? '机器人已启用' : '机器人已暂停'); await reloadBot();
}
async function check() {
  const result = await api(`bots/${currentBot.id}/check`, 'POST', {});
  await reloadBot();
  const box = $('check-results'); if (!box) { toast('已连接 @' + result.bot); return; }
  box.hidden = false; box.replaceChildren(el('strong', '机器人：@' + result.bot));
  if (!result.results.length) box.append(el('p', 'Token 正常。添加发送目标后可继续检查权限。'));
  for (const row of result.results) box.append(el('p', (row.ok ? '✓ ' : '! ') + row.name + '：' + (row.ok ? '可以发送' : row.error), row.ok ? 'good-text' : 'bad-text'));
}
async function discover() {
  const result = await api(`bots/${currentBot.id}/discover`, 'POST', {});
  const content = $('discover-content'); content.replaceChildren();
  $('discover-hint').textContent = result.groups.length ? '点「加入」把它放进对应计划，然后去参数设置保存。' : `没有发现。把机器人加进群后，在群里发一条 /start@${currentBot.username || '机器人用户名'}，然后重试。Telegram 只保留 24 小时内的更新。`;
  const plans = currentBot.config.plans;
  for (const group of result.groups) {
    const row = el('div', undefined, 'result-row'); const label = el('span', group.name); label.append(el('span', `${group.chatId}${group.type === 'channel' ? ' · 频道' : ''}`, 'sub')); row.append(label);
    const buttons = el('div', undefined, 'result-actions');
    for (const plan of plans || []) {
      const button = el('button', plan.chats.some(chat => chat.chatId === group.chatId) ? `已在 ${plan.name}` : `加入 ${plan.name}`, 'text-button'); button.type = 'button';
      button.disabled = plan.chats.some(chat => chat.chatId === group.chatId);
      button.addEventListener('click', () => action(button, async () => {
        plan.chats.push({ name: group.name, chatId: group.chatId });
        const saved = await api('bots/' + currentBot.id, 'PUT', { revision: currentBot.revision, name: currentBot.name, timeZone: currentBot.timeZone, options: currentBot.options, config: currentBot.config });
        currentBot.revision = saved.revision; button.textContent = `已在 ${plan.name}`; toast(`已加入 ${plan.name} 并保存`); await reloadBot();
      }));
      buttons.append(button);
    }
    if (!plans) buttons.append(el('span', '请到参数设置手动填写', 'small muted'));
    row.append(buttons); content.append(row);
  }
  $('discover-dialog').showModal();
}
function openTest() {
  const select = $('test-target'); select.replaceChildren();
  const seen = new Set();
  for (const plan of currentBot.config.plans || []) for (const chat of plan.chats) { if (seen.has(chat.chatId)) continue; seen.add(chat.chatId); select.append(new Option(`${chat.name}（${chat.chatId}）`, chat.chatId)); }
  if (!select.options.length) throw new Error('请先在参数设置里添加发送目标并保存');
  $('test-error').textContent = ''; $('test-dialog').showModal();
}
function renderHelp() {
  const box = $('help-content'); box.replaceChildren();
  for (const section of meta.help) {
    const panel = el('div', undefined, 'panel settings-panel help-section'); panel.append(el('h2', section.title));
    const list = el('ul'); section.items.forEach(text => list.append(el('li', text))); panel.append(list);
    if (section.table) {
      const wrap = el('div', undefined, 'table-wrap'); const table = el('table'); const tbody = el('tbody');
      for (const [expr, meaning] of section.table) { const row = el('tr'); const cell = el('td'); cell.append(el('code', expr)); row.append(cell, el('td', meaning)); tbody.append(row); }
      table.append(tbody); wrap.append(table); panel.append(wrap);
    }
    if (section.note) panel.append(el('p', section.note, 'guide-note'));
    box.append(panel);
  }
}

// ---------- 启动与事件 ----------
async function boot() {
  const state = await api('session'); initialized = state.initialized; csrf = state.csrf || '';
  $('workspace').hidden = !state.authenticated; $('auth-view').hidden = state.authenticated;
  if (!state.authenticated) {
    $('setup-key-label').hidden = initialized; $('setup-help').hidden = initialized; $('setup-key').required = !initialized;
    $('auth-title').textContent = initialized ? '登录管理后台' : '创建管理员';
    $('auth-description').textContent = initialized ? '继续管理你的机器人。' : '只需一次设置，之后直接在后台管理。';
    $('auth-submit').textContent = initialized ? '登录后台 →' : '创建账户，开始设置 →';
    $('password').autocomplete = initialized ? 'current-password' : 'new-password'; $('password').minLength = initialized ? 1 : 12;
    return;
  }
  $('current-user').textContent = state.username; document.querySelector('.user-avatar').textContent = state.username.slice(0, 1).toUpperCase();
  meta = await api('meta'); await navigate();
}
$('auth-form').addEventListener('submit', async event => {
  event.preventDefault(); $('auth-error').textContent = ''; const button = $('auth-submit'); button.disabled = true;
  try { const result = await api(initialized ? 'login' : 'setup', 'POST', { key: $('setup-key').value.trim(), username: $('username').value.trim(), password: $('password').value }); csrf = result.csrf; $('password').value = ''; $('setup-key').value = ''; dirty = false; await boot(); }
  catch (e) { $('auth-error').textContent = e.message; } finally { button.disabled = false; }
});
$('new-bot').addEventListener('click', () => {
  $('new-bot-types').replaceChildren(...meta.types.map((type, index) => {
    const label = el('label', undefined, 'type-choice'); const input = el('input'); input.type = 'radio'; input.name = 'bot-type'; input.value = type.id; input.checked = index === 0;
    const text = el('span'); text.append(el('strong', type.name), el('small', type.description)); label.append(input, text); return label;
  }));
  $('new-bot-name').value = ''; $('new-bot-error').textContent = ''; $('new-bot-dialog').showModal();
});
$('cancel-new-bot').addEventListener('click', () => $('new-bot-dialog').close());
$('new-bot-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try { const type = document.querySelector('input[name=bot-type]:checked')?.value; const bot = await api('bots', 'POST', { name: $('new-bot-name').value.trim(), type }); $('new-bot-dialog').close(); location.hash = `#/bots/${bot.id}/guide`; }
  catch (e) { $('new-bot-error').textContent = e.message; } finally { button.disabled = false; }
});
$('bot-toggle').addEventListener('click', () => action($('bot-toggle'), toggleBot));
$('bot-form').addEventListener('input', markDirty);
$('bot-timezone').addEventListener('change', () => document.querySelectorAll('[data-cron]').forEach(input => input.dispatchEvent(new Event('refresh-cron'))));
$('bot-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = $('save-bot'); button.disabled = true; $('bot-error').textContent = '';
  try { await api('bots/' + currentBot.id, 'PUT', collect()); dirty = false; currentBot = await api('bots/' + currentBot.id); renderBotHead(); fillForm(); toast('设置已保存，已自动生效'); }
  catch (e) { $('bot-error').textContent = e.message; } finally { button.disabled = false; }
});
$('preview').addEventListener('click', () => action($('preview'), async () => {
  if (!$('bot-form').reportValidity()) return;
  const value = await api(`bots/${currentBot.id}/preview`, 'POST', collect()); $('preview-content').replaceChildren();
  const messages = value.groups.flatMap(group => group.messages.map(message => ({ ...message, at: group.at })));
  if (!messages.length) $('preview-content').append(empty('先添加一个发送目标，即可预览消息。'));
  for (const m of messages) { const card = el('div', undefined, 'preview-card'); card.append(el('h3', `${m.chatName || m.chatId} · ${m.label}`), el('span', `下次执行 ${date(m.at)}`, 'small muted'), el('pre', m.text)); $('preview-content').append(card); }
  $('preview-dialog').showModal();
}));
$('delete-bot').addEventListener('click', () => action($('delete-bot'), async () => {
  if (!confirm(`确认删除「${currentBot.name}」？Token 和配置会被删除，等待中的任务会跳过，已有发送记录保留。`)) return;
  await api('bots/' + currentBot.id, 'DELETE'); dirty = false; currentBot = null; toast('已删除'); location.hash = '#/bots';
}));
$('close-preview').addEventListener('click', () => $('preview-dialog').close());
$('close-discover').addEventListener('click', () => { $('discover-dialog').close(); if (route.tab === 'settings' && !dirty) fillForm(); });
$('cancel-test').addEventListener('click', () => $('test-dialog').close());
$('test-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; $('test-error').textContent = '';
  try { const result = await api(`bots/${currentBot.id}/test-send`, 'POST', { chatId: $('test-target').value }); $('test-dialog').close(); toast(`已发送到 ${result.name}，请到 Telegram 查看`); }
  catch (e) { $('test-error').textContent = e.message; } finally { button.disabled = false; }
});
$('refresh').addEventListener('click', () => action($('refresh'), refresh));
$('logout').addEventListener('click', () => action($('logout'), async () => { if (dirty && !confirm('有未保存的设置，确认退出？')) return; await api('logout', 'POST', {}); dirty = false; await boot(); }));
$('history-filter').addEventListener('change', renderHistory);
function openResolve(job) { resolvingId = job.id; $('resolve-description').textContent = `任务 #${job.id} · ${job.bot_name} · ${job.occurrence.replace('T', ' ')} · 目标 ${job.chat_id}`; $('resolve-decision').value = 'sent'; $('resolve-ack').checked = false; $('resolve-error').textContent = ''; $('resolve-dialog').showModal(); }
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
setInterval(() => { if (!$('workspace').hidden && ['overview', 'bots', 'jobs'].includes(route.page)) refresh().catch(() => {}); }, 15000);
boot().catch(e => { $('auth-view').hidden = false; $('auth-error').textContent = '后台连接失败：' + e.message; });
