import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { Settings, runtimeConfig } from '../src/settings.js';
import { createAdminServer } from '../src/admin-server.js';
import { Auth } from '../src/auth.js';

const password = 'a-long-test-password-2026';
const token = '123456789:abcdefghijklmnopqrstuvwxyz_12345';
async function fixture(t, { secureCookie = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'renewal-admin-'));
  const store = new Store(join(dir, 'state.sqlite'));
  const settings = new Settings(store, dir, {});
  let checked = 0;
  let sending = false;
  const telegram = {
    call: async method => method === 'getMe' ? { is_bot: true, id: 12, username: 'test_bot' } : [
      { message: { text: 'never expose message content', chat: { type: 'supergroup', id: -100, title: '<测试群>' } } },
      { message: { chat: { type: 'private', id: 123, title: '个人' } } },
    ],
    assertCanSend: async () => { checked++; },
    send: async () => { throw new Error('管理接口不应该发送消息'); },
  };
  const logger = { info() {}, warn() {}, error() {} };
  const { server, auth } = createAdminServer({ store, settings, dataDir: dir, logger,
    clientFactory: () => telegram, secureCookie, isBusy: () => sending });
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
  return { dir, store, settings, auth, request, setup, checked: () => checked,
    setBusy: value => { sending = value; }, getCookie: () => cookie };
}

test('首次启动无需 Token 或配置，初始化需口令且只能执行一次', async t => {
  const f = await fixture(t);
  assert.equal(f.settings.get().enabled, false);
  assert.equal(f.settings.get().token, '');
  assert.equal((await f.request('/api/session')).value.initialized, false);
  assert.equal((await f.request('/api/settings')).response.status, 401);
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
test('接口要求登录、同源来源与 CSRF；安全响应头存在', async t => {
  const f = await fixture(t); await f.setup();
  const index = await f.request('/');
  assert.match(index.response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(index.response.headers.get('cache-control'), 'no-store');
  assert.equal(index.response.headers.get('x-frame-options'), 'DENY');
  assert.match(index.value, /续费日历/);
  assert.equal((await f.request('/api/settings', 'PUT', {}, { Origin: 'https://evil.example' })).response.status, 403);
  assert.equal((await f.request('/api/settings', 'PUT', {}, { 'X-CSRF-Token': '' })).response.status, 403);
  assert.equal((await f.request('/api/settings', 'PUT', {}, { Origin: '' })).response.status, 403);
  assert.equal((await f.request('/api/settings', 'PUT', {}, { Cookie: '' })).response.status, 401);
});
test('网页设置持久化、Token 不回传，留空保持，旧版本保存被拒绝', async t => {
  const f = await fixture(t); await f.setup();
  const value = (await f.request('/api/settings')).value;
  value.token = token; value.classes.A.groups = [{ name: 'A群', chatId: '-100' }];
  const saved = await f.request('/api/settings', 'PUT', value);
  assert.equal(saved.response.status, 200);
  assert.equal(saved.value.hasToken, true);
  assert.equal(JSON.stringify(saved.value).includes(token), false);
  assert.equal(saved.value.token, undefined);
  assert.equal(f.settings.get().token, token);
  assert.equal((await f.request('/api/settings', 'PUT', value)).response.status, 409);
  const next = { ...saved.value, enabled: true, token: '' };
  assert.equal((await f.request('/api/settings', 'PUT', next)).response.status, 200);
  assert.equal(f.settings.get().enabled, true);
  assert.equal(f.settings.get().token, token);
  const reopened = new Store(join(f.dir, 'state.sqlite'));
  try { assert.equal(new Settings(reopened, f.dir, {}).get().token, token); } finally { reopened.close(); }
});
test('不能启用空配置，重复群和参数越界不会保存', async t => {
  const f = await fixture(t); await f.setup();
  const current = f.settings.public();
  assert.equal((await f.request('/api/settings', 'PUT', { ...current, enabled: true })).response.status, 400);
  const invalid = { ...current, catchUpHours: 99999 };
  assert.equal((await f.request('/api/settings', 'PUT', invalid)).response.status, 400);
  current.classes.A.groups = [{ name: 'A', chatId: '-100' }];
  current.classes.B.groups = [{ name: 'B', chatId: '-100' }];
  assert.equal((await f.request('/api/settings', 'PUT', current)).response.status, 400);
  assert.equal(f.settings.get().revision, 1);
});
test('检查、发现和消息预览不发送消息；发现不泄露私人聊天或正文', async t => {
  const f = await fixture(t); await f.setup();
  const current = f.settings.public(); current.token = token; current.classes.A.groups = [{ name: 'A', chatId: '-100' }];
  assert.equal((await f.request('/api/settings', 'PUT', current)).response.status, 200);
  const checked = await f.request('/api/check', 'POST', {});
  assert.equal(checked.value.results[0].ok, true); assert.equal(f.checked(), 1);
  const discovered = await f.request('/api/discover', 'POST', {});
  assert.deepEqual(discovered.value.groups, [{ name: '<测试群>', chatId: '-100' }]);
  assert.equal(JSON.stringify(discovered.value).includes('never expose'), false);
  const preview = await f.request('/api/preview', 'POST', f.settings.public());
  assert.equal(preview.value.messages.length, 1);
  assert.equal(f.store.list().length, 0);
});
test('发送任务处理需要显式重发确认，写入审计记录', async t => {
  const f = await fixture(t); await f.setup();
  const now = Date.now();
  f.store.db.prepare(`INSERT INTO jobs (quarter,chat_id,category,text,due_at,deadline,status,next_attempt,updated_at)
    VALUES('test','-100','A','text',?,?,'uncertain',?,?)`).run(now, now + 3600000, now, now);
  assert.equal((await f.request('/api/resolve', 'POST', { id: 1, decision: 'retry' })).response.status, 400);
  assert.equal((await f.request('/api/resolve', 'POST', { id: 1, decision: 'retry', ackDuplicateRisk: true })).response.status, 200);
  assert.equal(f.store.list()[0].status, 'pending');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM resolutions').get().n, 1);
});
test('更换密码使已有会话失效，旧密码不能再登录', async t => {
  const f = await fixture(t); await f.setup();
  const changed = await f.request('/api/password', 'POST', { currentPassword: password, newPassword: password + '-new' });
  assert.equal(changed.response.status, 200);
  assert.equal((await f.request('/api/settings')).response.status, 401);
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
  assert.equal((await f.request('/api/settings')).response.status, 401);
});
test('会话过期、密码长度和发消息时更换 Token 的限制', async t => {
  const f = await fixture(t); await f.setup();
  const current = f.settings.public(); current.token = token;
  await f.request('/api/settings', 'PUT', current);
  f.setBusy(true);
  assert.equal((await f.request('/api/settings', 'PUT', { ...f.settings.public(), token: token + 'x' })).response.status, 409);
  assert.equal((await f.request('/api/settings', 'PUT', { ...f.settings.public(), clearToken: true })).response.status, 409);
  assert.equal((await f.request('/api/password', 'POST', { currentPassword: password, newPassword: 'short' })).response.status, 400);
  f.store.db.prepare('UPDATE sessions SET expires=?').run(Date.now() - 1);
  assert.equal((await f.request('/api/settings')).response.status, 401);
});
test('设置事件日志持久化且限制返回数量', async t => {
  const f = await fixture(t); await f.setup();
  for (let i = 0; i < 105; i++) f.settings.event({ event: 'settings_saved', time: new Date().toISOString() });
  const data = (await f.request('/api/dashboard')).value;
  assert.equal(data.events.length, 100);
  assert.equal(data.enabled, false);
  assert.equal(data.groupCount, 0);
  assert.equal(runtimeConfig(f.settings.get(), f.dir).groups.length, 0);
});
test('首次导入旧配置保留双类模板和原任务，后续不覆盖网页设置', async t => {
  const f = await fixture(t);
  f.store.db.exec('DELETE FROM app_settings');
  const path = join(f.dir, 'legacy.json');
  writeFileSync(path, JSON.stringify({ classes: {
    A: { template: '自定义 A {year}', groups: [{ name: '旧群', chatId: '${A_CHAT_ID}' }] },
    B: { template: '未启用的 B 模板', groups: [] },
  } }));
  const now = Date.now();
  f.store.db.prepare(`INSERT INTO jobs (quarter,chat_id,category,text,due_at,deadline,status,next_attempt,updated_at)
    VALUES('old-quarter','-100','A','旧通知',?,?,'sent',?,?)`).run(now, now, now, now);
  const imported = new Settings(f.store, f.dir, { CONFIG_PATH: path, BOT_TOKEN: token, A_CHAT_ID: '-100' });
  assert.equal(imported.get().enabled, false);
  assert.equal(imported.get().token, token);
  assert.equal(imported.get().classes.A.template, '自定义 A {year}');
  assert.equal(imported.get().classes.B.template, '未启用的 B 模板');
  assert.equal(f.store.list()[0].status, 'sent');
  assert.equal(new Settings(f.store, f.dir, {}).get().token, token);
});
