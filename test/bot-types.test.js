import test from 'node:test';
import assert from 'node:assert/strict';
import { assertBotType, botTypes } from '../src/bot-types/index.js';
import { nextAfter, occurrenceInfo } from '../src/cron.js';
import { validateFields } from '../src/schema.js';

// 新增类型文件后自动进入这组测试：默认配置必须能通过校验并能渲染。
for (const type of botTypes.values()) {
  test(`类型 ${type.id}：默认配置可校验、可生成计划`, async () => {
    const config = validateFields(type.fields, type.defaults());
    type.validate?.(config);
    assert.ok(type.schedules(config).length > 0);
    for (const schedule of type.schedules(config)) {
      assert.ok(schedule.key && schedule.label);
      assert.notEqual(nextAfter(schedule.cron, Date.now(), 'Asia/Shanghai'), null);
      const messages = await type.plan({ bot: { id: 1, name: 'x' }, config, schedule, occurrence: occurrenceInfo(Date.now(), 'Asia/Shanghai'), telegram: null, logger: null, preview: true });
      assert.ok(Array.isArray(messages));
    }
    assert.ok(Array.isArray(type.targets(config)));
  });
}
test('类型声明写错时启动就报错', () => {
  const good = { id: 'demo', name: 'x', description: 'y', fields: [], defaults() {}, schedules() {}, targets() {}, plan() {} };
  assert.equal(assertBotType(good), good);
  assert.throws(() => assertBotType({ ...good, id: 'Bad Id' }), /id/);
  assert.throws(() => assertBotType({ ...good, plan: undefined }), /plan/);
  assert.throws(() => assertBotType({ ...good, fields: [{ key: 'a', label: 'A', type: 'nope' }] }), /type/);
  assert.throws(() => assertBotType({ ...good, fields: [{ key: 'a', label: 'A', type: 'text' }, { key: 'a', label: 'B', type: 'text' }] }), /重复/);
});
test('续费类型的季度变量跨年正确', async () => {
  const type = botTypes.get('renewal');
  const config = validateFields(type.fields, { plans: [{ id: 'plan-1', name: 'A', cron: '0 10 L 3,6,9,12 *', template: '{year}Q{quarter}→{next_year}Q{next_quarter} {due_date} {group_name} {plan_name} {quarter_key}', chats: [{ name: '群', chatId: '-100' }] }] });
  const messages = await type.plan({ config, schedule: { key: 'plan-1' }, occurrence: occurrenceInfo(Date.parse('2026-12-31T10:00:00+08:00'), 'Asia/Shanghai') });
  assert.deepEqual(messages, [{ chatId: '-100', chatName: '群', label: 'A', text: '2026Q4→2027Q1 2026-12-31 群 A 2026-Q4' }]);
});
test('续费类型的服务周期变量', async () => {
  const type = botTypes.get('renewal');
  const render = async (periodStart, at, periodMonths = 3) => {
    const config = validateFields(type.fields, { plans: [{ id: 'plan-1', name: 'A', cron: '0 10 1 2,5,8,11 *', period_start: periodStart, period_months: periodMonths, template: '{period}|{next_period}', chats: [{ name: '群', chatId: '-100' }] }] });
    type.validate(config);
    const [message] = await type.plan({ config, schedule: { key: 'plan-1' }, occurrence: occurrenceInfo(Date.parse(at), 'Asia/Shanghai') });
    return message.text;
  };
  assert.equal(await render('2026-11-09', '2027-02-01T10:00:00+08:00'), '2026-11-09 至 2027-02-09|2027-02-09 至 2027-05-09');
  // 起始日之后的通知同样往回推算到所在的一期
  assert.equal(await render('2026-11-09', '2026-11-01T10:00:00+08:00'), '2026-08-09 至 2026-11-09|2026-11-09 至 2027-02-09');
  // 跨多年、从任意一期起算结果相同
  assert.equal(await render('2028-02-09', '2027-02-01T10:00:00+08:00'), '2026-11-09 至 2027-02-09|2027-02-09 至 2027-05-09');
  // 结束日当天按机器人时区算，已属于下一期（UTC 还是 02-08）
  assert.equal(await render('2026-11-09', '2027-02-08T16:30:00Z'), '2027-02-09 至 2027-05-09|2027-05-09 至 2027-08-09');
  // 月末起算不漂移：2 月取最后一天，5 月回到 30 日
  assert.equal(await render('2026-11-30', '2027-02-01T10:00:00+08:00'), '2026-11-30 至 2027-02-28|2027-02-28 至 2027-05-30');
  assert.equal(await render('2026-01-15', '2026-07-20T10:00:00+08:00', 6), '2026-07-15 至 2027-01-15|2027-01-15 至 2027-07-15');
});
test('服务周期：没填起始日不能用周期变量，日期和月数要有效', () => {
  const type = botTypes.get('renewal');
  const check = plan => type.validate(validateFields(type.fields, { plans: [{ id: 'plan-1', name: 'A', cron: '0 10 * * *', template: 'x', chats: [], ...plan }] }));
  check({});
  for (const template of ['{period}', '{next_period}', '{period_start}', '{next_period_end}']) assert.throws(() => check({ template }), /服务周期起始日/);
  assert.throws(() => check({ period_start: '2026-02-30' }), /有效日期/);
  assert.throws(() => check({ period_start: '11/09' }), /有效日期/);
  assert.throws(() => check({ period_start: '2026-11-09', period_months: 0 }), /每期月数/);
  // 老配置没有这两个字段时，月数取默认值
  assert.equal(validateFields(type.fields, { plans: [{ name: 'A', cron: '0 10 * * *', template: 'x' }] }).plans[0].period_months, 3);
});
test('发送后置顶按计划生效，默认关闭', async () => {
  const type = botTypes.get('scheduled-message');
  const chats = [{ name: '群', chatId: '-100' }];
  const config = validateFields(type.fields, { plans: [{ id: 'plan-1', name: 'A', cron: '0 10 * * *', template: 'x', pin: true, chats }, { id: 'plan-2', name: 'B', cron: '0 10 * * *', template: 'y', chats: [{ name: '群2', chatId: '-200' }] }] });
  const plan = key => type.plan({ config, schedule: { key }, occurrence: occurrenceInfo(Date.now(), 'Asia/Shanghai') });
  assert.equal((await plan('plan-1'))[0].pin, true);
  assert.equal((await plan('plan-2'))[0].pin, undefined);
  assert.deepEqual(type.targets(config).map(target => target.pin), [true, undefined]);
});
test('字段校验：未知变量、错误 cron、错误群 ID、永不触发都被拒绝', () => {
  const type = botTypes.get('renewal');
  const base = { id: 'plan-1', name: 'A', cron: '0 10 * * *', template: 'x', chats: [] };
  const check = plan => type.validate(validateFields(type.fields, { plans: [{ ...base, ...plan }] }));
  check({});
  assert.throws(() => check({ template: '{unknown}' }), /未知模板变量/);
  assert.throws(() => check({ cron: '99 * * * *' }), /cron/);
  assert.throws(() => check({ cron: '0 0 31 2 *' }), /永远不会触发/);
  assert.throws(() => check({ chats: [{ name: 'x', chatId: 'https://t.me/abc' }] }), /ID/);
  assert.throws(() => check({ chats: [{ name: 'x', chatId: '-1' }, { name: 'y', chatId: '-1' }] }), /重复/);
  assert.throws(() => validateFields(type.fields, { plans: [] }), /至少/);
});
test('列表项 id 保持稳定，缺失或重复时重新生成，未知字段被丢弃', () => {
  const type = botTypes.get('renewal');
  const item = { id: 'stable-id', name: 'A', cron: '0 10 * * *', template: 'x', chats: [], hack: 1 };
  const [first, second] = validateFields(type.fields, { plans: [item, item] }).plans;
  assert.equal(first.id, 'stable-id');
  assert.notEqual(second.id, 'stable-id');
  assert.equal(first.hack, undefined);
});
