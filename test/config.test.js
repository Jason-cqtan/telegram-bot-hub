import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'renewal-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  const raw = { classes: {
    A: { template: 'A {year}', groups: [{ name: 'A群', chatId: '${A_CHAT_ID}' }] },
    B: { template: 'B {quarter}', groups: [{ name: 'B群', chatId: '${B_CHAT_ID}' }] },
  } };
  const env = { CONFIG_PATH: path, DATA_DIR: join(dir, 'data'), A_CHAT_ID: '-100', B_CHAT_ID: '-200' };
  const save = () => writeFileSync(path, JSON.stringify(raw));
  save();
  return { raw, env, save };
}
test('环境变量解析、默认参数和空类别', t => {
  const f = fixture(t);
  const config = loadConfig(f.env);
  assert.equal(config.groups.length, 2);
  assert.equal(config.groups[0].chatId, '-100');
  assert.equal(config.catchUpHours, 72);
  f.raw.classes.B.groups = []; f.save();
  assert.equal(loadConfig(f.env).groups.length, 1);
});
test('拒绝重复群、非群 ID、缺失变量、无效模板和无效数值', t => {
  const f = fixture(t);
  for (const value of ['-100', '100', '-0100', '-0', '-9007199254740992', '']) {
    assert.throws(() => loadConfig({ ...f.env, B_CHAT_ID: value }));
  }
  assert.throws(() => loadConfig({ ...f.env, MAX_ATTEMPTS: '0' }));
  assert.throws(() => loadConfig({ ...f.env, CATCH_UP_HOURS: '9999' }));
  f.raw.classes.A.template = '{unknown}'; f.save();
  assert.throws(() => loadConfig(f.env), /未知/);
});
test('线上命令必须有有效 token，预览不需要', t => {
  const f = fixture(t);
  assert.throws(() => loadConfig(f.env, { requireToken: true }), /BOT_TOKEN/);
  assert.ok(loadConfig({ ...f.env, BOT_TOKEN: '123456789:abcdefghijklmnopqrstuvwxyz_12345' }, { requireToken: true }));
});
test('CLI 预览可在无 token 时运行且不创建数据库，拒绝无时区日期', t => {
  const f = fixture(t);
  const env = { ...process.env, ...f.env, BOT_TOKEN: '' };
  const result = spawnSync(process.execPath, ['src/cli.js', 'dry-run', '--at', '2026-12-31T10:00:00+08:00'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.quarter, '2026-Q4');
  assert.equal(parsed.messages.length, 2);
  assert.equal(existsSync(f.env.DATA_DIR), false);
  const bad = spawnSync(process.execPath, ['src/cli.js', 'dry-run', '--at', '2026-12-31T10:00:00'], { env, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /ISO/);
});
