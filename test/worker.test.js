import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Worker } from '../src/worker.js';
import { TelegramError } from '../src/telegram.js';

const DUE = Date.parse('2026-12-31T10:00:00+08:00');
const OCCURRENCE = '2026-12-31T10:00';
function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-test-'));
  const path = join(dir, 'state.sqlite');
  const store = new Store(path);
  store.db.prepare(`INSERT INTO bots (id,name,type,token,enabled,time_zone,options,config,created_at,updated_at)
    VALUES (1,'测试','renewal','t',1,'Asia/Shanghai','{}','{}',0,0)`).run();
  const stores = [store];
  t.after(() => { for (const s of stores) { try { s.close(); } catch {} } rmSync(dir, { recursive: true, force: true }); });
  let now = DUE;
  let sends = 0;
  const config = {
    groups: [{ label: 'A', chatId: '-100' }, { label: 'B', chatId: '-200' }],
    catchUpHours: 72, maxAttempts: 3, retryBaseMs: 1000, retryMaxMs: 4000,
  };
  const telegram = {
    assertCanSend: async () => {},
    send: async id => { sends++; return { message_id: sends, chat: { id: Number(id) } }; },
    ...overrides,
  };
  const logs = [];
  const logger = Object.fromEntries(['info', 'warn', 'error'].map(key => [key, (event, data) => logs.push({ event, ...data })]));
  const worker = new Worker({ store, logger, now: () => now, random: () => 0, leaseMs: 5000,
    runtime: () => ({ telegram, retryBaseMs: config.retryBaseMs, retryMaxMs: config.retryMaxMs }) });
  // 模拟调度器：入队（幂等）后做一次维护。
  worker.prepare = () => {
    for (const group of config.groups) {
      worker.store.enqueue({ botId: 1, scheduleKey: 'plan', occurrence: OCCURRENCE, chatId: group.chatId, label: group.label,
        text: group.text ?? `通知 ${group.label}`, dueAt: DUE, deadline: DUE + config.catchUpHours * 3600000, maxAttempts: config.maxAttempts }, now);
    }
    worker.store.maintain(now, job => config.groups.some(group => group.chatId === job.chat_id));
  };
  return { store, path, config, telegram, worker, logs, stores,
    sends: () => sends, time: () => now, advance: ms => { now += ms; } };
}

test('多个目标独立发送，反复轮询不重复，重新打开 SQLite 后仍防重', async t => {
  const f = fixture(t);
  f.worker.prepare();
  assert.equal(await f.worker.processOne(), true);
  assert.equal(await f.worker.processOne(), true);
  f.worker.prepare();
  assert.equal(await f.worker.processOne(), false);
  assert.equal(f.sends(), 2);
  assert.deepEqual(f.store.list().map(j => j.status), ['sent', 'sent']);
  f.store.close();
  const reopened = new Store(f.path); f.stores.push(reopened);
  f.worker.store = reopened;
  f.worker.prepare();
  assert.equal(await f.worker.processOne(), false);
  assert.equal(f.sends(), 2);
});
test('429 持久化 retry_after 并在到期后重试成功，其他群可正常发送', async t => {
  const f = fixture(t);
  let attempts = 0;
  f.telegram.send = async id => {
    if (id === '-100' && ++attempts === 1) throw new TelegramError('api', 429, 120);
    return { message_id: 42, chat: { id: Number(id) } };
  };
  f.worker.prepare();
  await f.worker.processOne();
  const retry = f.store.list().find(j => j.chat_id === '-100');
  assert.equal(retry.status, 'pending');
  assert.equal(retry.next_attempt, f.time() + 120000);
  // 在重试前模拟服务重启，验证 next_attempt 与尝试次数确实持久化。
  f.store.close();
  f.store = new Store(f.path); f.stores.push(f.store); f.worker.store = f.store;
  assert.equal(f.store.list().find(j => j.id === retry.id).next_attempt, retry.next_attempt);
  await f.worker.processOne();
  assert.equal(f.store.list().find(j => j.chat_id === '-200').status, 'sent');
  assert.equal(await f.worker.processOne(), false);
  f.advance(120000);
  await f.worker.processOne();
  assert.equal(f.store.list().find(j => j.chat_id === '-100').status, 'sent');
});
test('发送超时置 uncertain，后续轮询和重启恢复都不自动重发', async t => {
  const f = fixture(t, { send: async () => { throw new TelegramError('transport'); } });
  f.config.groups = f.config.groups.slice(0, 1);
  f.worker.prepare();
  await f.worker.processOne();
  assert.equal(f.store.list()[0].status, 'uncertain');
  f.advance(1000000); f.worker.prepare();
  assert.equal(await f.worker.processOne(), false);
  assert.equal(f.store.needsAttention(), 1);
});
test('权限不足为永久失败且不调用 send', async t => {
  const f = fixture(t, { assertCanSend: async () => { throw new TelegramError('permission_denied'); } });
  f.worker.prepare(); await f.worker.processOne();
  assert.equal(f.store.list().find(j => j.id === 1).status, 'failed');
  assert.equal(f.sends(), 0);
});
test('发送前网络错误指数退避，到最大尝试次数后停止', async t => {
  const f = fixture(t, { assertCanSend: async () => { throw new TelegramError('transport'); } });
  f.config.groups = f.config.groups.slice(0, 1);
  f.worker.prepare();
  for (const delay of [1000, 2000, 4000]) {
    await f.worker.processOne();
    const row = f.store.list()[0];
    assert.equal(row.next_attempt, f.time() + delay);
    f.advance(delay);
  }
  assert.equal(f.store.list()[0].attempts, 3);
  assert.equal(f.store.list()[0].status, 'failed');
  assert.equal(await f.worker.processOne(), false);
  assert.equal(f.sends(), 0);
});
test('同一数据库的两个连接原子领取，同一时间点同一目标不能重复建单', t => {
  const f = fixture(t);
  f.config.groups = f.config.groups.slice(0, 1);
  f.worker.prepare();
  const other = new Store(f.path); f.stores.push(other);
  const claimed = f.store.claim(f.time(), 1000);
  assert.ok(claimed);
  assert.equal(other.claim(f.time(), 1000), undefined);
  assert.equal(other.enqueue({ botId: 1, scheduleKey: 'plan', occurrence: OCCURRENCE, chatId: '-100', label: 'B', text: 'changed', dueAt: DUE, deadline: DUE + 1000, maxAttempts: 3 }, f.time()), 0);
  assert.equal(other.list().length, 1);
});
test('checking 崩溃安全回收；过期租约的旧 worker 不能再发送', t => {
  const f = fixture(t); f.config.groups = f.config.groups.slice(0, 1); f.worker.prepare();
  const old = f.store.claim(f.time(), 1000);
  f.advance(1000); f.worker.prepare();
  const current = f.store.claim(f.time(), 1000);
  assert.notEqual(current.owner, old.owner);
  assert.equal(f.store.beginSend(old, f.time(), 1000), false);
  assert.equal(f.store.beginSend(current, f.time(), 1000), true);
});
test('连续在权限校验阶段崩溃仍受最大尝试次数限制', t => {
  const f = fixture(t); f.config.groups = f.config.groups.slice(0, 1); f.worker.prepare();
  for (let attempt = 1; attempt <= f.config.maxAttempts; attempt++) {
    assert.equal(f.store.claim(f.time(), 1000).attempts, attempt);
    f.advance(1000); f.worker.prepare();
  }
  assert.equal(f.store.list()[0].status, 'failed');
  assert.equal(f.store.list()[0].last_error, 'attempts_exhausted');
  assert.equal(f.store.claim(f.time(), 1000), undefined);
});
test('sending 崩溃租约到期后置 uncertain，不抢占未过期任务', t => {
  const f = fixture(t); f.config.groups = f.config.groups.slice(0, 1); f.worker.prepare();
  const job = f.store.claim(f.time(), 1000);
  f.store.beginSend(job, f.time(), 1000);
  f.worker.prepare(); assert.equal(f.store.list()[0].status, 'sending');
  f.advance(1000); f.worker.prepare(); assert.equal(f.store.list()[0].status, 'uncertain');
  assert.equal(f.store.claim(f.time(), 1000), undefined);
});
test('成功发送后的写库失败不会触发自动重发', async t => {
  const f = fixture(t); f.config.groups = f.config.groups.slice(0, 1); f.worker.prepare();
  const finish = f.store.finish.bind(f.store);
  f.store.finish = () => { throw new Error('disk full'); };
  await assert.rejects(f.worker.processOne(), /disk full/);
  assert.equal(f.sends(), 1);
  f.store.finish = finish;
  f.advance(f.worker.leaseMs); f.worker.prepare();
  assert.equal(f.store.list()[0].status, 'uncertain');
  assert.equal(await f.worker.processOne(), false);
  assert.equal(f.sends(), 1);
});
test('过期任务与移除目标被跳过，任务正文保持入队快照', async t => {
  const f = fixture(t); f.worker.prepare();
  f.config.groups[0].text = 'changed'; f.worker.prepare();
  const text = f.store.db.prepare('SELECT text FROM jobs WHERE id=1').get().text;
  assert.equal(text, '通知 A');
  f.config.groups = f.config.groups.slice(0, 1); f.worker.prepare();
  assert.equal(f.store.list().find(j => j.id === 2).last_error, 'target_removed');
  f.advance(72 * 3600000); f.worker.prepare();
  assert.equal(f.store.list().find(j => j.id === 1).status, 'skipped');
  assert.equal(await f.worker.processOne(), false);
});
test('权限检查期间到达补发截止时间也不再发送', async t => {
  const f = fixture(t); f.config.groups = f.config.groups.slice(0, 1); f.worker.prepare();
  f.telegram.assertCanSend = async () => f.advance(72 * 3600000);
  await f.worker.processOne();
  assert.equal(f.store.list()[0].status, 'skipped');
  assert.equal(f.sends(), 0);
});
test('网页在权限检查期间暂停或移除目标时，发送前再次拦截', async t => {
  const f = fixture(t); f.config.groups = f.config.groups.slice(0, 1); f.worker.prepare();
  f.worker.beforeSend = () => 'paused';
  await f.worker.processOne();
  assert.equal(f.store.list()[0].status, 'pending'); assert.equal(f.sends(), 0);
  f.advance(1000); f.worker.beforeSend = () => 'target_removed';
  await f.worker.processOne();
  assert.equal(f.store.list()[0].status, 'skipped'); assert.equal(f.sends(), 0);
});
test('人工核查可确认已发送或允许重试，保留审计记录并禁止过期重试', async t => {
  const f = fixture(t, { send: async () => { throw new TelegramError('transport'); } });
  f.worker.prepare(); await f.worker.processOne();
  assert.throws(() => f.store.resolve(2, 'retry', f.time()), /只能/);
  f.store.resolve(1, 'retry', f.time());
  assert.equal(f.store.list().find(j => j.id === 1).status, 'pending');
  await f.worker.processOne();
  f.store.resolve(1, 'sent', f.time());
  assert.equal(f.store.list().find(j => j.id === 1).status, 'sent');
  await f.worker.processOne();
  f.advance(72 * 3600000);
  assert.throws(() => f.store.resolve(2, 'retry', f.time()), /已过期/);
  f.store.resolve(2, 'skipped', f.time());
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM resolutions').get().n, 3);
});
test('暂停的机器人不领取任务，恢复后继续；机器人被删时任务跳过', async t => {
  const f = fixture(t); f.config.groups = f.config.groups.slice(0, 1); f.worker.prepare();
  f.store.db.exec('UPDATE bots SET enabled=0');
  assert.equal(await f.worker.processOne(), false);
  assert.equal(f.store.hasReady(f.time()), false);
  f.store.db.exec('UPDATE bots SET enabled=1');
  f.worker.runtime = () => null;
  assert.equal(await f.worker.processOne(), true);
  assert.equal(f.store.list()[0].status, 'skipped');
  assert.equal(f.store.list()[0].last_error, 'bot_deleted');
  assert.equal(f.sends(), 0);
});

test('开启置顶时发送成功后置顶一次，用的是这条消息的 ID', async t => {
  const pins = [];
  const f = fixture(t, { pin: async (chatId, messageId) => { pins.push([chatId, messageId]); } });
  f.store.enqueue({ botId: 1, scheduleKey: 'plan', occurrence: OCCURRENCE, chatId: '-100', label: 'A', text: 'x', dueAt: DUE, deadline: DUE + 1000, maxAttempts: 3, pin: true }, f.time());
  f.store.enqueue({ botId: 1, scheduleKey: 'plan', occurrence: OCCURRENCE, chatId: '-200', label: 'B', text: 'y', dueAt: DUE, deadline: DUE + 1000, maxAttempts: 3 }, f.time());
  await f.worker.processOne();
  await f.worker.processOne();
  assert.equal(await f.worker.processOne(), false);
  assert.deepEqual(pins, [['-100', 1]]);
  assert.deepEqual(f.store.list().map(j => j.status), ['sent', 'sent']);
});
test('置顶失败时任务仍是发送成功，不重发、不计入待处理，并写入活动记录', async t => {
  const f = fixture(t, { pin: async () => { throw new TelegramError('api', 400); } });
  f.store.enqueue({ botId: 1, scheduleKey: 'plan', occurrence: OCCURRENCE, chatId: '-100', label: 'A', text: 'x', dueAt: DUE, deadline: DUE + 1000, maxAttempts: 3, pin: true }, f.time());
  assert.equal(await f.worker.processOne(), true);
  assert.equal(await f.worker.processOne(), false);
  assert.equal(f.sends(), 1);
  assert.equal(f.store.list()[0].status, 'sent');
  assert.equal(f.store.needsAttention(), 0);
  assert.equal(f.logs.find(log => log.event === 'job_pin_failed').error, 'api:400');
});
test('发送失败时不置顶', async t => {
  let pinned = false;
  const f = fixture(t, { send: async () => { throw new TelegramError('api', 403); }, pin: async () => { pinned = true; } });
  f.store.enqueue({ botId: 1, scheduleKey: 'plan', occurrence: OCCURRENCE, chatId: '-100', label: 'A', text: 'x', dueAt: DUE, deadline: DUE + 1000, maxAttempts: 3, pin: true }, f.time());
  await f.worker.processOne();
  assert.equal(f.store.list()[0].status, 'failed');
  assert.equal(pinned, false);
});
test('旧数据库打开时自动补上 pin 列，已有任务默认不置顶', async t => {
  const f = fixture(t);
  f.worker.prepare();
  f.store.db.exec('ALTER TABLE jobs DROP COLUMN pin');
  f.store.close();
  const reopened = new Store(f.path); f.stores.push(reopened);
  f.worker.store = reopened;
  const job = reopened.claim(f.time(), 5000);
  assert.equal(job.pin, 0);
});
