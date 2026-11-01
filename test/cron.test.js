import test from 'node:test';
import assert from 'node:assert/strict';
import { describeCron, nextAfter, nextRuns, occurrenceInfo, parseCron } from '../src/cron.js';

const SH = 'Asia/Shanghai';
const at = text => Date.parse(text);
const wall = (ms, tz = SH) => occurrenceInfo(ms, tz).key;

test('季度末 10:00：L 取当月最后一天，覆盖 30/31 日并跨年', () => {
  const runs = nextRuns('0 10 L 3,6,9,12 *', at('2026-11-01T00:00:00+08:00'), SH, 5).map(ms => wall(ms));
  assert.deepEqual(runs, ['2026-12-31T10:00', '2027-03-31T10:00', '2027-06-30T10:00', '2027-09-30T10:00', '2027-12-31T10:00']);
});
test('L 处理闰年 2 月', () => {
  assert.equal(wall(nextAfter('0 0 L 2 *', at('2028-01-01T00:00:00+08:00'), SH)), '2028-02-29T00:00');
  assert.equal(wall(nextAfter('0 0 L 2 *', at('2027-01-01T00:00:00+08:00'), SH)), '2027-02-28T00:00');
});
test('严格大于 after，且时区不受宿主影响', () => {
  const ten = at('2026-12-31T10:00:00+08:00');
  assert.equal(wall(nextAfter('0 10 * * *', ten, SH)), '2027-01-01T10:00');
  assert.equal(nextAfter('0 10 * * *', ten - 1, SH), ten);
  assert.equal(nextAfter('0 10 * * *', ten, 'UTC'), at('2026-12-31T10:00:00Z'));
});
test('步长、范围、列表、英文名与宏', () => {
  assert.deepEqual(parseCron('*/15 * * * *').minutes, [0, 15, 30, 45]);
  assert.deepEqual(parseCron('5-10/2 * * * *').minutes, [5, 7, 9]);
  assert.deepEqual([...parseCron('0 0 * * mon-wed').weekdays].sort(), [1, 2, 3]);
  assert.deepEqual([...parseCron('0 0 1 JAN,mar *').months].sort(), [1, 3]);
  assert.equal(parseCron('0 0 * * 7').weekdays.has(0), true);
  assert.equal(parseCron('@quarterly').expanded, '0 0 1 1,4,7,10 *');
});
test('工作日与周一', () => {
  const runs = nextRuns('30 8 * * 1-5', at('2026-11-06T09:00:00+08:00'), SH, 2).map(ms => wall(ms));
  assert.deepEqual(runs, ['2026-11-09T08:30', '2026-11-10T08:30']); // 11/6 是周五，跳过周末
});
test('日和周同时受限时取“或”，*/n 视为不受限', () => {
  const runs = nextRuns('0 0 13 * 5', at('2026-11-01T00:00:00+08:00'), SH, 3).map(ms => wall(ms));
  assert.deepEqual(runs, ['2026-11-06T00:00', '2026-11-13T00:00', '2026-11-20T00:00']);
  const both = nextRuns('0 0 */2 * 1', at('2026-11-01T00:00:00+08:00'), SH, 1).map(ms => wall(ms));
  assert.deepEqual(both, ['2026-11-09T00:00']); // 第一个既是奇数日又是周一的日子
});
test('无效表达式给出中文错误', () => {
  for (const bad of ['', '* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', '5-1 * * * *', '*/0 * * * *', '@nope', 'a b c d e', '* * L/2 * *']) {
    assert.throws(() => parseCron(bad), /cron|5 段/, bad);
  }
});
test('永不触发的日期返回 null，2 月 29 日最长可跨 8 年', () => {
  assert.equal(nextAfter('0 0 31 2 *', at('2026-01-01T00:00:00Z'), SH), null);
  assert.equal(wall(nextAfter('0 0 29 2 *', at('2096-03-01T00:00:00Z'), SH)), '2104-02-29T00:00');
});
test('DST：跳过不存在的时刻，回拨的时刻墙上时间相同', () => {
  const ny = 'America/New_York';
  // 2027-03-14 02:30 不存在，当天不触发。
  const spring = nextRuns('30 2 * * *', at('2027-03-13T12:00:00Z'), ny, 2).map(ms => wall(ms, ny));
  assert.deepEqual(spring, ['2027-03-15T02:30', '2027-03-16T02:30']);
  // 2027-11-07 01:30 出现两次，occurrence key 相同，任务唯一键会去重。
  const fall = nextRuns('30 1 7 11 *', at('2027-11-01T00:00:00Z'), ny, 2);
  assert.equal(wall(fall[0], ny), '2027-11-07T01:30');
  assert.equal(wall(fall[1], ny), '2027-11-07T01:30');
  assert.equal(fall[1] - fall[0], 3_600_000);
});
test('频繁表达式的计算足够快', () => {
  const start = performance.now();
  let cursor = at('2026-12-01T00:00:00Z');
  for (let i = 0; i < 10080; i++) cursor = nextAfter('* * * * *', cursor, 'America/New_York');
  assert.ok(performance.now() - start < 3000);
});
test('中文描述', () => {
  assert.equal(describeCron('0 10 L 3,6,9,12 *'), '每年 3、6、9、12 月的最后一天 10:00');
  assert.equal(describeCron('0 9 * * *'), '每天 09:00');
  assert.equal(describeCron('0 9 * * 1-5'), '每周一、周二、周三、周四、周五 09:00');
  assert.equal(describeCron('0 12 1 * *'), '每月 1 日 12:00');
  assert.equal(describeCron('*/30 * * * *'), '每 30 分钟');
});
