import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { Bots } from '../src/bots.js';
import { Scheduler } from '../src/scheduler.js';
import { botTypes } from '../src/bot-types/index.js';
import { createAdminServer } from '../src/admin-server.js';
import { Auth } from '../src/auth.js';

const password = 'a-long-test-password-2026';
const token = '123456789:abcdefghijklmnopqrstuvwxyz_12345';
async function fixture(t, { secureCookie = false, trustProxy = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-admin-'));
  const store = new Store(join(dir, 'state.sqlite'));
  const bots = new Bots(store, botTypes);
  let checked = 0;
  let sent = [];
  let sending = false;
  let getMe = async () => ({ is_bot: true, id: 12, username: 'test_bot' });
  const telegram = {
    call: async method => method === 'getMe' ? getMe() : [
      { message: { text: 'never expose message content', chat: { type: 'supergroup', id: -100, title: '<测试群>' } } },
      { channel_post: { chat: { type: 'channel', id: -300, title: '频道' } } },
      { message: { chat: { type: 'private', id: 123, title: '个人' } } },
    ],
    assertCanSend: async () => { checked++; },
    send: async (chatId, text) => { sent.push({ chatId, text }); return { message_id: 7 }; },
  };
  const logger = { info() {}, warn() {}, error() {} };
  const scheduler = new Scheduler({ store, bots, logger });
  const { server, auth } = createAdminServer({ store, bots, scheduler, types: botTypes, dataDir: dir, logger,
    clientFactory: () => telegram, secureCookie, trustProxy, isBusy: () => sending });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let cookie = ''; let csrf = '';
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    store.close(); rmSync(dir, { recursive: true, force: true });
  });
  async function request(path, method = 'GET', data, extra = {}) {
    const response = await fetch(origin + path, { method, headers: {
      ...(method === 'GET' ? {} : { Origin: secureCookie ? origin.replace('http:', 'https:') : origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }),
      Cookie: cookie, ...extra,
    }, body: data === undefined ? undefined : JSON.stringify(data) });
    const content = response.headers.get('content-type') || '';
    const value = content.includes('application/json') ? await response.json() : await response.text();
    return { response, value };
  }
  async function setup() {
    const result = await request('/api/setup', 'POST', { key: readFileSync(auth.bootstrapPath, 'utf8'), username: 'admin', password });
    assert.equal(result.response.status, 200, JSON.stringify(result.value));
    cookie = result.response.headers.get('set-cookie').split(';')[0]; csrf = result.value.csrf;
    return result;
  }
  // 新建一个机器人并存好 Token 和目标，返回服务端状态。
  async function botWith({ type = 'renewal', chats = [{ name: 'A群', chatId: '-100' }] } = {}) {
    const created = (await request('/api/bots', 'POST', { name: '测试机器人', type })).value;
    const plans = created.config.plans.map((plan, index) => ({ ...plan, chats: index === 0 ? chats : [] }));
    const saved = await request(`/api/bots/${created.id}`, 'PUT', { revision: created.revision, name: created.name, timeZone: created.timeZone, token, options: created.options, config: { plans } });
    assert.equal(saved.response.status, 200, JSON.stringify(saved.value));
    return saved.value;
  }
  const form = bot => ({ revision: bot.revision, name: bot.name, timeZone: bot.timeZone, options: bot.options, config: bot.config });
  return { dir, store, bots, auth, request, setup, botWith, form, checked: () => checked, sent: () => sent,
    setBusy: value => { sending = value; }, setGetMe: fn => { getMe = fn; }, getCookie: () => cookie };
}

test('接口要求登录、同源来源与 CSRF；安全响应头存在', async t => {
  const f = await fixture(t); await f.setup();
  const index = await f.request('/');
  assert.match(index.response.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.equal(index.response.headers.get('cache-control'), 'no-store');
  assert.equal(index.response.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(index.value, /Bot Hub/);
  assert.equal((await f.request('/api/bots', 'POST', {}, { Origin: 'https://evil.example' })).response.status, 403);
  assert.equal((await f.request('/api/bots', 'POST', {}, { 'X-CSRF-Token': '' })).response.status, 403);
  assert.equal((await f.request('/api/bots', 'POST', {}, { Origin: '' })).response.status, 403);
  assert.equal((await f.request('/api/bots', 'POST', {}, { Cookie: '' })).response.status, 401);
});
test('更换密码使已有会话失效，旧密码不能再登录', async t => {
  const f = await fixture(t); await f.setup();
  const changed = await f.request('/api/password', 'POST', { currentPassword: password, newPassword: password + '-new' });
  assert.equal(changed.response.status, 200);
  assert.equal((await f.request('/api/meta')).response.status, 401);
  assert.equal((await f.request('/api/login', 'POST', { username: 'admin', password })).response.status, 401);
  assert.equal((await f.request('/api/login', 'POST', { username: 'admin', password: password + '-new' })).response.status, 200);
});
test('连续错误登录会被限流，重启后仍保留限流记录', async t => {
  const f = await fixture(t); await f.setup();
  for (let i = 0; i < 5; i++) assert.equal((await f.request('/api/login', 'POST', { username: 'admin', password: 'wrong' })).response.status, 401);
  assert.equal((await f.request('/api/login', 'POST', { username: 'admin', password })).response.status, 429);
  const other = new Auth(f.store, f.dir);
  await assert.rejects(other.login('admin', password, '127.0.0.1'), error => error.status === 429);
});
test('HTTPS 模式使用 Secure Cookie 和 HSTS，退出登录使会话失效', async t => {
  const f = await fixture(t, { secureCookie: true }); const result = await f.setup();
  assert.match(result.response.headers.get('set-cookie'), /; Secure/);
  assert.match(result.response.headers.get('strict-transport-security'), /max-age=/);
  assert.equal((await f.request('/api/logout', 'POST', {})).response.status, 200);
  assert.equal((await f.request('/api/meta')).response.status, 401);
});
test('首次启动无需配置，初始化需口令且只能执行一次', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/session')).value.initialized, false);
  assert.equal((await f.request('/api/dashboard')).response.status, 401);
  assert.equal((await f.request('/api/setup', 'POST', { key: 'wrong', username: 'admin', password })).response.status, 403);
  const result = await f.setup();
  assert.match(result.response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal(existsSync(f.auth.bootstrapPath), false);
  assert.equal((await f.request('/api/session')).value.authenticated, true);
  assert.equal((await f.request('/api/setup', 'POST', { key: 'irrelevant', username: 'other', password })).response.status, 409);
  const admin = f.store.db.prepare('SELECT * FROM admins').get();
  assert.notEqual(admin.hash, password);
  const session = f.store.db.prepare('SELECT * FROM sessions').get();
  assert.equal(session.token_hash.includes(f.getCookie().split('=')[1]), false);
});
test('类型元数据驱动后台：两种内置类型都可创建，未知类型被拒绝', async t => {
  const f = await fixture(t); await f.setup();
  const meta = (await f.request('/api/meta')).value;
  assert.deepEqual(meta.types.map(type => type.id).sort(), ['renewal', 'scheduled-message']);
  assert.ok(meta.help.length > 0);
  assert.equal((await f.request('/api/bots', 'POST', { name: 'x', type: 'nope' })).response.status, 400);
  assert.equal((await f.request('/api/bots', 'POST', { name: '', type: 'renewal' })).response.status, 400);
  const created = (await f.request('/api/bots', 'POST', { name: '定时', type: 'scheduled-message' })).value;
  assert.equal(created.typeName, '定时消息');
  assert.equal(created.hasToken, false);
  assert.equal(created.upcoming.length, 1);
});
test('Token 不回传，留空保持，旧版本保存被拒绝，同一 Token 不能给两个机器人', async t => {
  const f = await fixture(t); await f.setup();
  const saved = await f.botWith();
  assert.equal(saved.hasToken, true);
  assert.equal(saved.username, 'test_bot');
  assert.equal(saved.token, undefined);
  assert.equal(JSON.stringify(saved).includes(token), false);
  assert.equal(JSON.stringify((await f.request('/api/dashboard')).value).includes(token), false);
  assert.equal(JSON.stringify((await f.request(`/api/bots/${saved.id}`)).value).includes(token), false);
  assert.equal(f.bots.get(saved.id).token, token);
  assert.equal((await f.request(`/api/bots/${saved.id}`, 'PUT', { ...f.form(saved), revision: 1 })).response.status, 409);
  const kept = await f.request(`/api/bots/${saved.id}`, 'PUT', { ...f.form(saved), token: '' });
  assert.equal(kept.response.status, 200);
  assert.equal(f.bots.get(saved.id).token, token);
  const other = (await f.request('/api/bots', 'POST', { name: '另一个', type: 'renewal' })).value;
  const duplicate = await f.request(`/api/bots/${other.id}`, 'PUT', { ...f.form(other), token });
  assert.equal(duplicate.response.status, 400);
  assert.match(duplicate.value.error, /另一个机器人/);
});
test('保存时验证 Token：Telegram 拒绝则不保存，网络问题不阻塞', async t => {
  const f = await fixture(t); await f.setup();
  const bot = (await f.request('/api/bots', 'POST', { name: 'x', type: 'renewal' })).value;
  f.setGetMe(async () => { throw Object.assign(new Error('x'), { kind: 'api', code: 401 }); });
  const rejected = await f.request(`/api/bots/${bot.id}`, 'PUT', { ...f.form(bot), token });
  assert.equal(rejected.response.status, 400);
  assert.equal(f.bots.get(bot.id).token, '');
  assert.equal((await f.request(`/api/bots/${bot.id}`, 'PUT', { ...f.form(bot), token: 'not-a-token' })).response.status, 400);
  f.setGetMe(async () => { throw Object.assign(new Error('x'), { kind: 'transport' }); });
  const offline = await f.request(`/api/bots/${bot.id}`, 'PUT', { ...f.form(bot), token });
  assert.equal(offline.response.status, 200);
  assert.equal(offline.value.username, null);
});
test('不能启用空配置，错误 cron 和参数越界不会保存', async t => {
  const f = await fixture(t); await f.setup();
  const bot = (await f.request('/api/bots', 'POST', { name: 'x', type: 'renewal' })).value;
  assert.equal((await f.request(`/api/bots/${bot.id}/enabled`, 'POST', { enabled: true })).response.status, 400);
  const badCron = structuredClone(f.form(bot)); badCron.config.plans[0].cron = '99 * * * *';
  const result = await f.request(`/api/bots/${bot.id}`, 'PUT', badCron);
  assert.equal(result.response.status, 400); assert.match(result.value.error, /cron/);
  assert.equal((await f.request(`/api/bots/${bot.id}`, 'PUT', { ...f.form(bot), options: { ...bot.options, catchUpHours: 99999 } })).response.status, 400);
  assert.equal((await f.request(`/api/bots/${bot.id}`, 'PUT', { ...f.form(bot), timeZone: 'Mars/Base' })).response.status, 400);
  assert.equal(f.bots.get(bot.id).revision, 1);
});
test('运行中的机器人不能清空 Token 或目标；发送中不能换 Token 或删除', async t => {
  const f = await fixture(t); await f.setup();
  const bot = await f.botWith();
  const on = (await f.request(`/api/bots/${bot.id}/enabled`, 'POST', { enabled: true })).value;
  assert.equal(on.enabled, true);
  assert.equal((await f.request(`/api/bots/${bot.id}`, 'PUT', { ...f.form(on), clearToken: true })).response.status, 400);
  const noChats = structuredClone(f.form(on)); noChats.config.plans[0].chats = [];
  assert.equal((await f.request(`/api/bots/${bot.id}`, 'PUT', noChats)).response.status, 400);
  f.setBusy(true);
  assert.equal((await f.request(`/api/bots/${bot.id}`, 'PUT', { ...f.form(on), token: token + 'x' })).response.status, 409);
  assert.equal((await f.request(`/api/bots/${bot.id}`, 'DELETE')).response.status, 409);
});
test('cron 接口返回中文含义和接下来 5 次，错误表达式返回 400', async t => {
  const f = await fixture(t); await f.setup();
  const ok = await f.request('/api/cron', 'POST', { cron: '0 10 L 3,6,9,12 *', timeZone: 'Asia/Shanghai' });
  assert.equal(ok.value.description, '每年 3、6、9、12 月的最后一天 10:00');
  assert.equal(ok.value.runs.length, 5);
  assert.equal((await f.request('/api/cron', 'POST', { cron: 'nope', timeZone: 'Asia/Shanghai' })).response.status, 400);
  assert.equal((await f.request('/api/cron', 'POST', { cron: '0 0 31 2 *', timeZone: 'Asia/Shanghai' })).response.status, 400);
  assert.equal((await f.request('/api/cron', 'POST', { cron: '0 0 * * *', timeZone: 'Mars/Base' })).response.status, 400);
});
test('检查、发现和预览不发送；发现不泄露私人聊天或正文；检查结果绑定目标', async t => {
  const f = await fixture(t); await f.setup();
  const bot = await f.botWith();
  const checked = await f.request(`/api/bots/${bot.id}/check`, 'POST', {});
  assert.equal(checked.value.results[0].ok, true); assert.equal(f.checked(), 1);
  const state = (await f.request(`/api/bots/${bot.id}`)).value;
  assert.equal(state.checked, true);
  assert.equal(state.guide.steps.find(step => step.id === 'check').done, true);
  const discovered = await f.request(`/api/bots/${bot.id}/discover`, 'POST', {});
  assert.deepEqual(discovered.value.groups, [{ name: '<测试群>', chatId: '-100', type: 'supergroup' }, { name: '频道', chatId: '-300', type: 'channel' }]);
  assert.equal(JSON.stringify(discovered.value).includes('never expose'), false);
  const preview = await f.request(`/api/bots/${bot.id}/preview`, 'POST', f.form(state));
  assert.equal(preview.value.groups.flatMap(group => group.messages).length, 1);
  assert.equal(f.store.list().length, 0); assert.equal(f.sent().length, 0);
  const changed = structuredClone(f.form(state)); changed.config.plans[0].chats.push({ name: '新群', chatId: '-200' });
  await f.request(`/api/bots/${bot.id}`, 'PUT', changed);
  assert.equal((await f.request(`/api/bots/${bot.id}`)).value.checked, false);
});
test('测试消息只能发给已保存的目标，带前缀且不进发送记录', async t => {
  const f = await fixture(t); await f.setup();
  const bot = await f.botWith();
  assert.equal((await f.request(`/api/bots/${bot.id}/test-send`, 'POST', { chatId: '-999' })).response.status, 400);
  const sent = await f.request(`/api/bots/${bot.id}/test-send`, 'POST', { chatId: '-100' });
  assert.equal(sent.response.status, 200);
  assert.equal(f.sent()[0].chatId, '-100');
  assert.match(f.sent()[0].text, /^【测试】\n【A类合租续费通知】/);
  assert.equal(f.store.list().length, 0);
});
test('向导按配置进度给出下一步，并生成添加到群的链接', async t => {
  const f = await fixture(t); await f.setup();
  const fresh = (await f.request('/api/bots', 'POST', { name: 'x', type: 'renewal' })).value;
  const guide = (await f.request(`/api/bots/${fresh.id}`)).value.guide;
  assert.equal(guide.doneCount, 0);
  assert.equal(guide.steps[0].links[0].url, 'https://t.me/BotFather');
  assert.match(guide.steps[0].note, /api_id/);
  const bot = await f.botWith();
  const steps = (await f.request(`/api/bots/${bot.id}`)).value.guide.steps;
  assert.equal(steps.find(step => step.id === 'token').done, true);
  assert.equal(steps.find(step => step.id === 'chats').links[0].url, 'https://t.me/test_bot?startgroup=setup');
  assert.equal(steps.find(step => step.id === 'enable').done, false);
});
test('删除机器人后等待中的任务跳过，历史保留', async t => {
  const f = await fixture(t); await f.setup();
  const bot = await f.botWith();
  const now = Date.now();
  f.store.enqueue({ botId: bot.id, scheduleKey: 'k', occurrence: 'o', chatId: '-100', label: 'l', text: 't', dueAt: now, deadline: now + 3600000, maxAttempts: 3 }, now);
  assert.equal((await f.request(`/api/bots/${bot.id}`, 'DELETE')).response.status, 200);
  assert.equal((await f.request(`/api/bots/${bot.id}`)).response.status, 404);
  const job = (await f.request('/api/dashboard')).value.jobs[0];
  assert.equal(job.status, 'skipped'); assert.equal(job.last_error, 'bot_deleted'); assert.equal(job.bot_name, '（已删除）');
});
test('发送任务处理需要显式重发确认，写入审计记录', async t => {
  const f = await fixture(t); await f.setup();
  const bot = await f.botWith();
  const now = Date.now();
  f.store.enqueue({ botId: bot.id, scheduleKey: 'k', occurrence: 'o', chatId: '-100', label: 'l', text: 't', dueAt: now, deadline: now + 3600000, maxAttempts: 3 }, now);
  f.store.db.exec("UPDATE jobs SET status='uncertain'");
  assert.equal((await f.request('/api/resolve', 'POST', { id: 1, decision: 'retry' })).response.status, 400);
  assert.equal((await f.request('/api/resolve', 'POST', { id: 1, decision: 'retry', ackDuplicateRisk: true })).response.status, 200);
  assert.equal(f.store.list()[0].status, 'pending');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM resolutions').get().n, 1);
});
test('会话过期与密码长度限制', async t => {
  const f = await fixture(t); await f.setup();
  assert.equal((await f.request('/api/password', 'POST', { currentPassword: password, newPassword: 'short' })).response.status, 400);
  f.store.db.prepare('UPDATE sessions SET expires=?').run(Date.now() - 1);
  assert.equal((await f.request('/api/dashboard')).response.status, 401);
});
test('活动日志持久化且限制返回数量', async t => {
  const f = await fixture(t); await f.setup();
  for (let i = 0; i < 105; i++) f.store.event({ event: 'bot_saved', time: new Date().toISOString() });
  const data = (await f.request('/api/dashboard')).value;
  assert.equal(data.events.length, 100);
  assert.deepEqual(data.bots, []);
});
test('反向代理下按 X-Forwarded-For 最后一段限流，他人失败不会锁住管理员', async t => {
  const f = await fixture(t, { trustProxy: true }); await f.setup();
  const attacker = { 'X-Forwarded-For': 'spoofed, 203.0.113.9' };
  for (let i = 0; i < 5; i++) assert.equal((await f.request('/api/login', 'POST', { username: 'admin', password: 'wrong' }, attacker)).response.status, 401);
  assert.equal((await f.request('/api/login', 'POST', { username: 'admin', password }, attacker)).response.status, 429);
  assert.equal((await f.request('/api/login', 'POST', { username: 'admin', password }, { 'X-Forwarded-For': '198.51.100.7' })).response.status, 200);
});
