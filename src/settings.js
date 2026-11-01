import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateConfig, loadConfig } from './config.js';

const numeric = {
  pollSeconds: ['POLL_INTERVAL_SECONDS', 15], catchUpHours: ['CATCH_UP_HOURS', 72],
  maxAttempts: ['MAX_ATTEMPTS', 6], retryBaseSeconds: ['RETRY_BASE_SECONDS', 30],
  retryMaxSeconds: ['RETRY_MAX_SECONDS', 1800], timeoutSeconds: ['REQUEST_TIMEOUT_SECONDS', 15],
};

export function defaultSettings(env = process.env) {
  const classes = JSON.parse(readFileSync(new URL('../config/config.json', import.meta.url), 'utf8')).classes;
  for (const value of Object.values(classes)) value.groups = [];
  const settings = { enabled: false, token: '', classes,
    ...Object.fromEntries(Object.entries(numeric).map(([name, [, fallback]]) => [name, fallback])) };
  // 导入旧版文件时先暂停，待管理员在网页检查后启用。
  try {
    const old = loadConfig(env, { requireToken: true });
    const source = JSON.parse(readFileSync(resolve(env.CONFIG_PATH || './config/config.json'), 'utf8'));
    settings.token = old.token;
    for (const group of old.groups) settings.classes[group.category].groups.push({ name: group.name, chatId: group.chatId });
    for (const category of ['A', 'B']) {
      settings.classes[category].template = source.classes[category].template;
    }
    for (const [name, [key, fallback]] of Object.entries(numeric)) settings[name] = Number(env[key] ?? fallback);
  } catch { /* 首次运行无需配置文件或凭据。 */ }
  return settings;
}

export function runtimeConfig(settings, dataDir) {
  if (typeof settings.enabled !== 'boolean' || typeof settings.token !== 'string') throw new Error('运行开关或 Token 格式无效');
  const env = { BOT_TOKEN: settings.token, DATA_DIR: dataDir };
  for (const [name, [key]] of Object.entries(numeric)) {
    if (!Number.isInteger(settings[name])) throw new Error('重试和调度参数必须为整数');
    env[key] = String(settings[name]);
  }
  let config;
  try {
    config = validateConfig({ classes: settings.classes }, env, {
      requireToken: settings.enabled || Boolean(settings.token), allowEmpty: !settings.enabled,
    });
  } catch (error) {
    if (error.message.includes('BOT_TOKEN')) throw new Error('机器人 Token 格式无效，请检查后重新填写');
    if (error.message.includes('chatId')) throw new Error('群 ID 必须是有效的负整数，请检查是否填入了邀请链接或个人 ID');
    throw error;
  }
  if (settings.enabled && !config.groups.length) throw new Error('启用前请添加至少一个群');
  return config;
}

export class Settings {
  constructor(store, dataDir, env = process.env) {
    this.store = store;
    this.dataDir = resolve(dataDir);
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS app_events (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, value TEXT NOT NULL);
    `);
    const initial = defaultSettings(env);
    store.db.prepare('INSERT OR IGNORE INTO app_settings(id,revision,value) VALUES(1,1,?)').run(JSON.stringify(initial));
  }
  get() {
    const row = this.store.db.prepare('SELECT revision,value FROM app_settings WHERE id=1').get();
    return { revision: row.revision, ...JSON.parse(row.value) };
  }
  public() {
    const { token, ...rest } = this.get();
    return { ...rest, hasToken: Boolean(token) };
  }
  save(input) {
    const current = this.get();
    if (!Number.isSafeInteger(input.revision) || input.revision !== current.revision) {
      const error = new Error('设置已在其他窗口更新，请刷新后再保存'); error.status = 409; throw error;
    }
    const next = {
      enabled: input.enabled, token: input.clearToken ? '' : (input.token?.trim() || current.token),
      classes: input.classes,
      ...Object.fromEntries(Object.keys(numeric).map(key => [key, input[key]])),
    };
    const config = runtimeConfig(next, this.dataDir);
    // 保存规范化后的 ID，不保存环境变量引用或额外输入字段。
    next.classes = Object.fromEntries(['A', 'B'].map(category => [category, {
      template: next.classes[category].template,
      groups: config.groups.filter(g => g.category === category).map(g => ({ name: g.name, chatId: g.chatId })),
    }]));
    const result = this.store.db.prepare('UPDATE app_settings SET value=?,revision=revision+1 WHERE id=1 AND revision=?')
      .run(JSON.stringify(next), current.revision);
    if (result.changes !== 1) { const e = new Error('设置已更新，请刷新'); e.status = 409; throw e; }
    return this.public();
  }
  event(value) {
    this.store.db.prepare('INSERT INTO app_events(at,value) VALUES(?,?)').run(Date.now(), JSON.stringify(value));
    this.store.db.exec('DELETE FROM app_events WHERE id NOT IN (SELECT id FROM app_events ORDER BY id DESC LIMIT 1000)');
  }
  events() {
    return this.store.db.prepare('SELECT id,value FROM app_events ORDER BY id DESC LIMIT 100').all()
      .map(row => ({ id: row.id, ...JSON.parse(row.value) }));
  }
}
