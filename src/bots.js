import { createHash } from 'node:crypto';
import { assertTimeZone } from './cron.js';
import { validateFields } from './schema.js';

export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';
export const OPTION_FIELDS = [
  { key: 'catchUpHours', label: '停机补发窗口（小时）', type: 'number', required: true, min: 1, max: 168, default: 72, help: '服务停机后恢复，错过时间在此窗口内才补发最近一次。' },
  { key: 'maxAttempts', label: '最多尝试次数', type: 'number', required: true, min: 1, max: 20, default: 6 },
  { key: 'retryBaseSeconds', label: '初次重试等待（秒）', type: 'number', required: true, min: 1, max: 3600, default: 30 },
  { key: 'retryMaxSeconds', label: '重试等待上限（秒）', type: 'number', required: true, min: 1, max: 86400, default: 1800 },
];
const TOKEN = /^\d+:[A-Za-z0-9_-]{20,}$/;
const defaultOptions = () => Object.fromEntries(OPTION_FIELDS.map(field => [field.key, field.default]));
const failure = (message, status = 400) => Object.assign(new Error(message), { status });

export class Bots {
  constructor(store, types, now = Date.now) { Object.assign(this, { store, types, now, db: store.db }); }
  hydrate(row) {
    return row && { id: row.id, name: row.name, type: row.type, token: row.token, username: row.username, enabled: row.enabled === 1,
      timeZone: row.time_zone, options: JSON.parse(row.options), config: JSON.parse(row.config), revision: row.revision,
      checkedKey: row.checked_key, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  list() { return this.db.prepare('SELECT * FROM bots ORDER BY id').all().map(row => this.hydrate(row)); }
  get(id) { return this.hydrate(this.db.prepare('SELECT * FROM bots WHERE id=?').get(id)); }
  require(id) { const bot = this.get(id); if (!bot) throw failure('机器人不存在', 404); return bot; }
  typeOf(bot) { return this.types.get(bot.type); }
  targets(bot) { return this.typeOf(bot)?.targets(bot.config) ?? []; }
  schedules(bot) { return this.typeOf(bot)?.schedules(bot.config) ?? []; }
  public(bot) {
    const { token, checkedKey, ...rest } = bot;
    return { ...rest, hasToken: Boolean(token), checked: Boolean(checkedKey) && checkedKey === this.checkKey(bot), typeName: this.typeOf(bot)?.name ?? `未知类型 ${bot.type}` };
  }
  create({ name, type }) {
    const definition = this.types.get(type);
    if (!definition) throw failure('请选择机器人类型');
    const label = typeof name === 'string' ? name.trim() : '';
    if (!label || label.length > 64) throw failure('机器人名称需为 1–64 个字符');
    const config = validateFields(definition.fields, definition.defaults());
    const now = this.now();
    const { lastInsertRowid } = this.db.prepare(`INSERT INTO bots (name,type,time_zone,options,config,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)`).run(label, type, DEFAULT_TIME_ZONE, JSON.stringify(defaultOptions()), JSON.stringify(config), now, now);
    return this.get(Number(lastInsertRowid));
  }
  // 校验一份表单输入，不写库；预览和保存共用。
  normalize(bot, input) {
    const definition = this.typeOf(bot);
    if (!definition) throw failure(`类型 ${bot.type} 的代码不存在，无法修改配置`, 409);
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 64) throw failure('机器人名称需为 1–64 个字符');
    const timeZone = assertTimeZone(typeof input.timeZone === 'string' && input.timeZone.trim() ? input.timeZone.trim() : DEFAULT_TIME_ZONE);
    const options = validateFields(OPTION_FIELDS, input.options);
    const config = validateFields(definition.fields, input.config);
    definition.validate?.(config);
    return { name, timeZone, options, config };
  }
  save(id, input) {
    const bot = this.require(id);
    if (!Number.isSafeInteger(input.revision) || input.revision !== bot.revision) throw failure('配置已在其他窗口更新，请刷新后再保存', 409);
    const { name, timeZone, options, config } = this.normalize(bot, input);
    let token = bot.token;
    if (input.clearToken) token = '';
    else if (typeof input.token === 'string' && input.token.trim()) {
      token = input.token.trim();
      if (!TOKEN.test(token)) throw failure('机器人 Token 格式无效，应形如 123456789:AAxx…，请从 @BotFather 重新复制');
    }
    if (token && this.db.prepare('SELECT id FROM bots WHERE token=? AND id<>?').get(token, id)) throw failure('这个 Token 已被另一个机器人使用');
    const next = { ...bot, token, config };
    if (bot.enabled) this.assertRunnable(next);
    const username = token === bot.token ? (input.username ?? bot.username) : (input.username ?? null);
    const result = this.db.prepare(`UPDATE bots SET name=?,token=?,username=?,time_zone=?,options=?,config=?,revision=revision+1,updated_at=?
      WHERE id=? AND revision=?`).run(name, token, username, timeZone, JSON.stringify(options), JSON.stringify(config), this.now(), id, bot.revision);
    if (result.changes !== 1) throw failure('配置已更新，请刷新', 409);
    return this.get(id);
  }
  assertRunnable(bot) {
    if (!this.typeOf(bot)) throw failure(`类型 ${bot.type} 的代码不存在，不能启用`, 409);
    if (!bot.token) throw failure('启用前请先保存机器人 Token');
    if (!this.targets(bot).length) throw failure('启用前请至少添加一个发送目标');
  }
  setEnabled(id, enabled) {
    const bot = this.require(id);
    if (typeof enabled !== 'boolean') throw failure('启用状态无效');
    if (enabled) this.assertRunnable(bot);
    this.db.prepare('UPDATE bots SET enabled=?,updated_at=? WHERE id=?').run(enabled ? 1 : 0, this.now(), id);
    return this.get(id);
  }
  // 权限检查结果绑定到 Token 与目标列表，二者变化后向导要求重新检查。
  checkKey(bot) {
    const targets = this.targets(bot).map(target => target.chatId).sort().join(',');
    return createHash('sha256').update(`${bot.token}|${targets}`).digest('hex');
  }
  recordCheck(id, username, passed) {
    const bot = this.require(id);
    this.db.prepare('UPDATE bots SET username=?,checked_key=? WHERE id=?').run(username, passed ? this.checkKey(bot) : null, id);
  }
  remove(id) {
    this.require(id);
    const now = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE jobs SET status='skipped',last_error='bot_deleted',updated_at=? WHERE bot_id=? AND status='pending'").run(now, id);
      this.db.prepare('DELETE FROM schedules WHERE bot_id=?').run(id);
      this.db.prepare('DELETE FROM bots WHERE id=?').run(id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
