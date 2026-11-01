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
