import { join, resolve } from 'node:path';
import { writeFileSync, renameSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store } from './store.js';
import { Bots } from './bots.js';
import { botTypes } from './bot-types/index.js';
import { Scheduler } from './scheduler.js';
import { createAdminServer } from './admin-server.js';
import { createLogger } from './logger.js';
import { TelegramClient } from './telegram.js';
import { Worker } from './worker.js';

const databaseName = 'hub.sqlite';
export const databasePath = dataDir => join(dataDir, databaseName);

export async function startService(env = process.env) {
  const dataDir = resolve(env.DATA_DIR || './data');
  const store = new Store(databasePath(dataDir));
  const bots = new Bots(store, botTypes);
  const logger = createLogger(env.LOG_LEVEL || 'info', [], line => {
    process.stdout.write(line);
    store.event(JSON.parse(line));
  });
  const clients = new Map();
  const clientFor = bot => {
    if (clients.get(bot.id)?.token !== bot.token) clients.set(bot.id, new TelegramClient(bot.token));
    return clients.get(bot.id);
  };
  const scheduler = new Scheduler({ store, bots, logger, clientFor });
  let stopping = false;
  let busyBot = null;
  const abort = new AbortController();
  const worker = new Worker({ store, logger,
    runtime: job => {
      const bot = bots.get(job.bot_id);
      if (!bot?.token) return null;
      busyBot = bot.id;
      return { telegram: clientFor(bot), retryBaseMs: bot.options.retryBaseSeconds * 1000, retryMaxMs: bot.options.retryMaxSeconds * 1000 };
    },
    beforeSend: job => {
      const latest = bots.get(job.bot_id);
      if (!latest?.enabled) return 'paused';
      return bots.targets(latest).some(target => target.chatId === job.chat_id) ? true : 'target_removed';
    } });
  const { server, auth } = createAdminServer({ store, bots, scheduler, types: botTypes, dataDir, logger,
    secureCookie: env.COOKIE_SECURE === 'true', trustProxy: env.TRUST_PROXY === 'true', isBusy: id => busyBot === id });
  const host = env.ADMIN_HOST || '127.0.0.1';
  const port = Number(env.ADMIN_PORT || 8090);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ADMIN_PORT 无效');
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const stop = () => { stopping = true; abort.abort(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  const heartbeat = () => {
    const file = join(dataDir, 'heartbeat.json'); const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ at: Date.now(), attention: store.needsAttention() })); renameSync(temp, file);
  };
  const wait = ms => sleep(ms, undefined, { signal: abort.signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
  logger.info('admin_started', { address: `http://${host}:${port}`, setupRequired: !auth.initialized(), types: [...botTypes.keys()] });
  try {
    while (!stopping) {
      try {
        await scheduler.tick();
        scheduler.maintain();
        heartbeat();
        try { await worker.processOne(); } finally { busyBot = null; }
        heartbeat();
      } catch (error) {
        // 单次循环出错（如磁盘写满）不拖垮后台，错误进日志；进行中的任务由租约回收。
        logger.error('loop_error', { error: error.message });
      }
      // 多个目标之间至少间隔 1.1 秒，遵守 Telegram 群发频率。
      await wait(store.hasReady(Date.now()) ? 1100 : 1000);
    }
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
    logger.info('service_stopped'); store.close();
  }
}
