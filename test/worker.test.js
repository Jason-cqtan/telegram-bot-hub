import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Worker } from '../src/worker.js';
import { TelegramError } from '../src/telegram.js';
import { quarterInfo } from '../src/schedule.js';

function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'renewal-test-'));
  const path = join(dir, 'state.sqlite');
  const store = new Store(path);
  const stores = [store];
  t.after(() => { for (const s of stores) { try { s.close(); } catch {} } rmSync(dir, { recursive: true, force: true }); });
  let now = quarterInfo(2026, 4).due;
  let sends = 0;
  const config = {
    groups: [{ category: 'A', chatId: '-100', name: 'A群', template: '续费 {quarter_key}' },
      { category: 'B', chatId: '-200', name: 'B群', template: 'B续费 {next_quarter}' }],
    catchUpHours: 72, maxAttempts: 3, retryBaseMs: 1000, retryMaxMs: 4000, timeoutMs: 1000,
  };
  const telegram = {
    assertCanSend: async () => {},
    send: async id => { sends++; return { message_id: sends, chat: { id: Number(id) } }; },
    ...overrides,
  };
  const logs = [];
  const logger = Object.fromEntries(['info', 'warn', 'error'].map(key => [key, (event, data) => logs.push({ event, ...data })]));
  const worker = new Worker({ config, store, telegram, logger, now: () => now, random: () => 0 });
  return { store, path, config, telegram, worker, logs, stores,
    sends: () => sends, time: () => now, advance: ms => { now += ms; } };
}

test('A/B 独立发送，反复轮询不重复，重新打开 SQLite 后仍防重', async t => {
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
test('同一数据库的两个连接原子领取，同一群跨类别不能重复建单', t => {
  const f = fixture(t);
  f.config.groups = f.config.groups.slice(0, 1);
  f.worker.prepare();
  const other = new Store(f.path); f.stores.push(other);
  const claimed = f.store.claim(f.time(), 1000);
  assert.ok(claimed);
  assert.equal(other.claim(f.time(), 1000), undefined);
  const q = quarterInfo(2026, 4);
  assert.equal(other.enqueue(q, { category: 'B', chatId: '-100' }, 'changed', 72, f.time()), 0);
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
  f.config.groups[0].template = 'changed';
  const text = f.store.db.prepare('SELECT text FROM jobs WHERE id=1').get().text;
  assert.equal(text, '续费 2026-Q4');
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
