import test from 'node:test';
import assert from 'node:assert/strict';
import { quarterInfo, quarterAt, eligibleQuarters, renderTemplate, nextDue } from '../src/schedule.js';

test('四个自然季度均在末月最后一天北京时间 10:00', () => {
  for (const [quarter, date] of [[1, '2028-03-31'], [2, '2028-06-30'], [3, '2028-09-30'], [4, '2028-12-31']]) {
    const q = quarterInfo(2028, quarter);
    assert.equal(q.date, date);
    assert.equal(new Date(q.due).toISOString(), date + 'T02:00:00.000Z');
  }
});
test('未到时间不发，10:00 到点开始，补发窗口右边界不包含', () => {
  const due = quarterInfo(2026, 1).due;
  assert.deepEqual(eligibleQuarters(due - 1, 72), []);
  assert.equal(eligibleQuarters(due, 72)[0].key, '2026-Q1');
  assert.equal(eligibleQuarters(due + 72 * 3600000 - 1, 72)[0].key, '2026-Q1');
  assert.deepEqual(eligibleQuarters(due + 72 * 3600000, 72), []);
});
test('补发窗口跨季度、跨年且时区不依赖服务器', () => {
  assert.equal(eligibleQuarters(Date.parse('2027-01-01T01:00:00+08:00'), 72)[0].key, '2026-Q4');
  assert.equal(eligibleQuarters(Date.parse('2026-04-01T01:00:00+08:00'), 72)[0].key, '2026-Q1');
  assert.deepEqual(quarterAt(new Date('2026-03-31T16:00:00Z')), { year: 2026, quarter: 2 });
  assert.equal(nextDue(quarterInfo(2026, 4).due).key, '2027-Q1');
});
test('模板变量、下季度跨年、未知变量和长度限制', () => {
  const group = { category: 'A', name: '测试群' };
  assert.equal(renderTemplate('{year}/{quarter}/{next_year}/{next_quarter}/{due_date}/{class}/{group_name}/{quarter_key}', group, quarterInfo(2026, 4)),
    '2026/4/2027/1/2026-12-31/A/测试群/2026-Q4');
  assert.throws(() => renderTemplate('{unknown}', group, quarterInfo(2026, 4)), /未知/);
  assert.throws(() => renderTemplate('{toString}', group, quarterInfo(2026, 4)), /未知/);
  assert.throws(() => renderTemplate('x'.repeat(4097), group, quarterInfo(2026, 4)), /4096/);
  assert.throws(() => renderTemplate(' ', group, quarterInfo(2026, 4)), /4096/);
});
