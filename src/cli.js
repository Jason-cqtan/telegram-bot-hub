import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { TelegramClient } from './telegram.js';
import { Store } from './store.js';
import { Worker } from './worker.js';
import { nextDue, quarterAt, quarterInfo, renderTemplate } from './schedule.js';

process.umask(0o077);
const command = process.argv[2] || 'start';
const args = process.argv.slice(3);
let logger = createLogger('info', [process.env.BOT_TOKEN]);
function option(key) {
  const index = args.indexOf(key);
  return index === -1 ? undefined : args[index + 1];
}

async function main() {
  if (command === 'start') {
    const { startService } = await import('./service.js');
    await startService(); return;
  }
  if (command === 'setup-key') {
    const dir = process.env.DATA_DIR || './data';
    const store = new Store(join(dir, 'state.sqlite'));
    try {
      const { Auth } = await import('./auth.js'); const auth = new Auth(store, dir);
      if (auth.initialized()) throw new Error('管理员已创建，请在后台登录');
      console.log(readFileSync(auth.bootstrapPath, 'utf8').trim());
    } finally { store.close(); }
    return;
  }
  if (command === 'health') {
    const dir = process.env.DATA_DIR || './data';
    const heartbeat = JSON.parse(readFileSync(join(dir, 'heartbeat.json'), 'utf8'));
    if (Date.now() - heartbeat.at > 300_000 || heartbeat.attention > 0) throw new Error('服务停滞或有失败/待核查任务，请查看 status 与日志');
    console.log('healthy');
    return;
  }
  if (!['worker', 'check', 'discover', 'dry-run', 'status', 'resolve'].includes(command)) throw new Error('未知命令');
  // 查看和处理状态只需本地数据目录，不依赖 token 或已变更的群配置。
  if (['status', 'resolve'].includes(command)) {
    const store = new Store(join(process.env.DATA_DIR || './data', 'state.sqlite'));
    try {
      if (command === 'resolve') {
        const id = Number(option('--id'));
        const decision = option('--as');
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error('请提供 --id 正整数');
        if (decision === 'retry' && !args.includes('--ack-duplicate-risk')) throw new Error('重试前请核查群内消息，并加 --ack-duplicate-risk 确认可能重复');
        store.resolve(id, decision, Date.now());
        logger.warn('manual_resolution', { jobId: id, decision });
      }
      console.log(JSON.stringify(store.list(), null, 2));
    } finally { store.close(); }
    return;
  }
  let config;
  const database = join(process.env.DATA_DIR || './data', 'state.sqlite');
  if (existsSync(database) && command !== 'worker') {
    const store = new Store(database);
    try {
      const table = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_settings'").get();
      if (table) {
        const { runtimeConfig } = await import('./settings.js');
        const row = store.db.prepare('SELECT value FROM app_settings WHERE id=1').get();
        config = runtimeConfig(JSON.parse(row.value), process.env.DATA_DIR || './data');
      }
    } finally { store.close(); }
  }
  config ||= loadConfig(process.env, { requireToken: ['worker', 'check', 'discover'].includes(command) });
  if (['check', 'discover'].includes(command) && !config.token) throw new Error('请先在管理后台保存 Token');
  logger = createLogger(config.logLevel, [config.token]);
  if (command === 'dry-run') {
    const at = option('--at');
    if (at && !/(Z|[+-]\d{2}:\d{2})$/.test(at)) throw new Error('--at 必须是带时区的 ISO 日期，如 2026-12-31T10:00:00+08:00');
    const date = at ? new Date(at) : new Date();
    const { year, quarter } = quarterAt(date);
    const q = quarterInfo(year, quarter);
    console.log(JSON.stringify({ mode: 'preview_only', quarter: q.key, dueBeijing: `${q.date} 10:00:00 +08:00`,
      nextDue: nextDue(date.getTime()).date + ' 10:00:00 +08:00',
      messages: config.groups.map(g => ({ category: g.category, chatId: g.chatId, text: renderTemplate(g.template, g, q) })) }, null, 2));
    return;
  }
  const telegram = new TelegramClient(config.token, config.timeoutMs);
  if (command === 'check') {
    for (const group of config.groups) {
      const result = await telegram.assertCanSend(group.chatId);
      logger.info('permission_ok', { category: group.category, chatId: result.chatId, status: result.status });
    }
    logger.info('check_complete', { groups: config.groups.length, nextDueBeijing: nextDue().date + ' 10:00:00 +08:00' });
    return;
  }
  if (command === 'discover') {
    // 只输出群 ID，不输出成员 ID、消息正文或私人聊天。
    const updates = await telegram.call('getUpdates', { timeout: 0, limit: 100 });
    const chats = new Map();
    for (const update of updates) {
      const chat = update.message?.chat || update.my_chat_member?.chat;
      if (chat && ['group', 'supergroup'].includes(chat.type)) chats.set(String(chat.id), { chatId: String(chat.id), title: chat.title });
    }
    console.log(JSON.stringify([...chats.values()], null, 2));
    return;
  }
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const store = new Store(join(config.dataDir, 'state.sqlite'));
  const worker = new Worker({ config, store, telegram, logger });
  let stopping = false;
  const abort = new AbortController();
  const stop = () => { stopping = true; abort.abort(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const heartbeat = () => {
    const path = join(config.dataDir, 'heartbeat.json');
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ at: Date.now(), attention: store.needsAttention() }));
    renameSync(temp, path);
  };
  logger.info('service_started', { timeZone: 'Asia/Shanghai', groups: config.groups.length,
    nextDueBeijing: nextDue().date + ' 10:00:00 +08:00' });
  try {
    while (!stopping) {
      worker.prepare();
      heartbeat();
      while (!stopping && await worker.processOne()) {
        heartbeat();
        await sleep(1100, undefined, { signal: abort.signal }).catch(error => {
          if (error.name !== 'AbortError') throw error;
        });
      }
      heartbeat();
      if (!stopping) await sleep(config.pollMs, undefined, { signal: abort.signal }).catch(error => {
        if (error.name !== 'AbortError') throw error;
      });
    }
  } finally {
    store.close();
    logger.info('service_stopped');
  }
}

main().catch(error => {
  logger.error('fatal', { error: error.message });
  process.exitCode = 1;
});
