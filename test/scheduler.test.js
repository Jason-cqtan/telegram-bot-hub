import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Bots } from '../src/bots.js';
import { Scheduler } from '../src/scheduler.js';
import { botTypes } from '../src/bot-types/index.js';

const token = '123456789:abcdefghijklmnopqrstuvwxyz_12345';
const at = text => Date.parse(text);
function fixture(t, { cron = '0 10 * * *', start = at('2026-11-01T09:00:00+08:00') } = {}) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let now = start;
  const clock = () => now;
  const bots = new Bots(store, botTypes, clock);
  const logs = [];
  const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, (event, data) => logs.push({ level, event, ...data })]));
  const scheduler = new Scheduler({ store, bots, logger, now: clock });
  const bot = bots.create({ name: '测试', type: 'scheduled-message' });
  const plan = { ...bot.config.plans[0], cron, chats: [{ name: '群', chatId: '-100' }] };
  bots.save(bot.id, { revision: bot.revision, name: bot.name, timeZone: 'Asia/Shanghai', token, options: bot.options, config: { plans: [plan] } });
  const update = changes => {
    const current = bots.get(bot.id);
    return bots.save(bot.id, { revision: current.revision, name: current.name, timeZone: current.timeZone, options: current.options, config: current.config, ...changes });
  };
  return { store, bots, scheduler, logs, id: bot.id, plan, update, set: text => { now = at(text); }, jobs: () => store.list() };
}

test('启用前不生成任务，到点生成一次，反复 tick 不重复', async t => {
  const f = fixture(t);
  await f.scheduler.tick(); assert.equal(f.jobs().length, 0);
  f.bots.setEnabled(f.id, true);
  await f.scheduler.tick(); assert.equal(f.jobs().length, 0);
  f.set('2026-11-01T10:00:00+08:00');
  await f.scheduler.tick(); await f.scheduler.tick();
  assert.equal(f.jobs().length, 1);
  assert.equal(f.jobs()[0].occurrence, '2026-11-01T10:00');
  f.set('2026-11-02T10:00:30+08:00');
  await f.scheduler.tick();
  assert.equal(f.jobs().length, 2);
});
test('启用时不补发已过去的时间点', async t => {
  const f = fixture(t, { start: at('2026-11-01T15:00:00+08:00') });
  f.bots.setEnabled(f.id, true);
  await f.scheduler.tick();
  f.set('2026-11-01T16:00:00+08:00'); await f.scheduler.tick();
  assert.equal(f.jobs().length, 0);
});
test('修改 cron 从现在起算，不因新时间已过去而立刻触发', async t => {
  const f = fixture(t); f.bots.setEnabled(f.id, true); await f.scheduler.tick();
  f.set('2026-11-01T09:30:00+08:00');
  f.update({ config: { plans: [{ ...f.plan, cron: '0 8 * * *' }] } });
  await f.scheduler.tick();
  f.set('2026-11-01T10:30:00+08:00'); await f.scheduler.tick();
  assert.equal(f.jobs().length, 0);
  f.set('2026-11-02T08:00:00+08:00'); await f.scheduler.tick();
  assert.equal(f.jobs().length, 1);
});
test('暂停期间的时间点恢复后不补发', async t => {
  const f = fixture(t); f.bots.setEnabled(f.id, true); await f.scheduler.tick();
  f.bots.setEnabled(f.id, false); await f.scheduler.tick();
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM schedules').get().n, 0);
  f.set('2026-11-01T11:00:00+08:00');
  f.bots.setEnabled(f.id, true); await f.scheduler.tick();
  assert.equal(f.jobs().length, 0);
});
test('停机恢复只补发窗口内最近一次，并记录跳过数量', async t => {
  const f = fixture(t); f.bots.setEnabled(f.id, true); await f.scheduler.tick();
  f.set('2026-11-03T12:00:00+08:00');
  await f.scheduler.tick();
  assert.deepEqual(f.jobs().map(j => j.occurrence), ['2026-11-03T10:00']);
  assert.equal(f.logs.find(l => l.event === 'occurrences_skipped').skipped, 2);
  assert.equal(f.jobs()[0].deadline, at('2026-11-03T10:00:00+08:00') + 72 * 3600000);
});
test('停机超过窗口时不补发', async t => {
  const f = fixture(t); f.bots.setEnabled(f.id, true); await f.scheduler.tick();
  f.update({ options: { catchUpHours: 1, maxAttempts: 6, retryBaseSeconds: 30, retryMaxSeconds: 1800 } });
  f.set('2026-11-01T11:30:00+08:00');
  await f.scheduler.tick();
  assert.equal(f.jobs().length, 0);
});
test('模板渲染错误只记录，不阻断下一个时间点', async t => {
  const f = fixture(t); f.bots.setEnabled(f.id, true); await f.scheduler.tick();
  f.store.db.prepare('UPDATE bots SET config=? WHERE id=?').run(JSON.stringify({ plans: [{ ...f.plan, template: '{oops}' }] }), f.id);
  f.set('2026-11-01T10:00:00+08:00'); await f.scheduler.tick();
  assert.equal(f.jobs().length, 0);
  assert.equal(f.logs.find(l => l.event === 'schedule_failed').level, 'error');
  f.store.db.prepare('UPDATE bots SET config=? WHERE id=?').run(JSON.stringify({ plans: [f.plan] }), f.id);
  f.set('2026-11-02T10:00:00+08:00'); await f.scheduler.tick();
  assert.equal(f.jobs().length, 1);
});
test('删除计划和移除目标后，等待中的任务被跳过', async t => {
  const f = fixture(t); f.bots.setEnabled(f.id, true); await f.scheduler.tick();
  f.set('2026-11-01T10:00:00+08:00'); await f.scheduler.tick();
  f.update({ config: { plans: [{ ...f.plan, chats: [{ name: '新群', chatId: '-200' }] }] } });
  f.scheduler.maintain();
  assert.equal(f.jobs()[0].status, 'skipped');
  assert.equal(f.jobs()[0].last_error, 'target_removed');
});
test('多个机器人互相独立，同一群可在不同机器人下各发一次', async t => {
  const f = fixture(t);
  const other = f.bots.create({ name: '另一个', type: 'scheduled-message' });
  f.bots.save(other.id, { revision: other.revision, name: other.name, timeZone: 'UTC', token: token + 'x', options: other.options,
    config: { plans: [{ ...other.config.plans[0], cron: '0 2 * * *', chats: [{ name: '群', chatId: '-100' }] }] } });
  f.bots.setEnabled(f.id, true); f.bots.setEnabled(other.id, true);
  await f.scheduler.tick();
  f.set('2026-11-01T10:00:00+08:00'); await f.scheduler.tick(); // 两个 cron 指向同一瞬间：10:00+08 = 02:00Z
  assert.deepEqual(f.jobs().map(j => j.bot_id).sort(), [f.id, other.id].sort());
});
test('类型代码缺失的机器人不调度也不崩溃', async t => {
  const f = fixture(t); f.bots.setEnabled(f.id, true);
  f.store.db.prepare("UPDATE bots SET type='gone' WHERE id=?").run(f.id);
  await f.scheduler.tick();
  f.set('2026-11-01T10:00:00+08:00'); await f.scheduler.tick();
  assert.equal(f.jobs().length, 0);
  assert.equal(f.bots.public(f.bots.get(f.id)).typeName, '未知类型 gone');
});
