import { join } from 'node:path';
import { resolve } from 'node:path';
import { writeFileSync, renameSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store } from './store.js';
import { Settings, runtimeConfig } from './settings.js';
import { createAdminServer } from './admin-server.js';
import { createLogger } from './logger.js';
import { TelegramClient } from './telegram.js';
import { Worker } from './worker.js';

export async function startService(env = process.env) {
  const dataDir = resolve(env.DATA_DIR || './data');
  const store = new Store(join(dataDir, 'state.sqlite'));
  const settings = new Settings(store, dataDir, env);
  const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, (event, fields) => {
    const current = settings.get();
    createLogger(env.LOG_LEVEL || 'info', [current.token], line => {
      process.stdout.write(line);
      settings.event(JSON.parse(line));
    })[level](event, fields);
  }]));
  let stopping = false;
  let busy = false;
  const abort = new AbortController();
  const { server, auth } = createAdminServer({ store, settings, dataDir, logger,
    secureCookie: env.COOKIE_SECURE === 'true', isBusy: () => busy });
  const host = env.ADMIN_HOST || '127.0.0.1';
  const port = Number(env.ADMIN_PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ADMIN_PORT 无效');
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const stop = () => { stopping = true; abort.abort(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  const heartbeat = () => {
    const file = join(dataDir, 'heartbeat.json'); const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ at: Date.now(), attention: store.needsAttention() })); renameSync(temp, file);
  };
  const wait = ms => sleep(ms, undefined, { signal: abort.signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
  logger.info('admin_started', { address: `http://${host}:${port}`, setupRequired: !auth.initialized() });
  let nextPrepare = 0;
  let lastRevision = 0;
  try {
    while (!stopping) {
      const snapshot = settings.get();
      const config = runtimeConfig(snapshot, dataDir);
      const worker = new Worker({ config, store, logger, telegram: new TelegramClient(config.token, config.timeoutMs),
        beforeSend: job => {
          const latest = settings.get();
          if (!latest.enabled) return 'paused';
          if (!Object.values(latest.classes).some(c => c.groups.some(g => g.chatId === job.chat_id))) return 'target_removed';
          return true;
        } });
      // 暂停时仍回收过期租约和过期任务，但不创建新任务、不领取待发送任务。
      if (snapshot.enabled && (Date.now() >= nextPrepare || snapshot.revision !== lastRevision)) {
        worker.prepare(); nextPrepare = Date.now() + config.pollMs; lastRevision = snapshot.revision;
      } else store.maintain(Date.now(), config.groups.map(g => g.chatId), config.maxAttempts);
      heartbeat();
      if (snapshot.enabled) {
        busy = true;
        try { await worker.processOne(); } finally { busy = false; }
        heartbeat();
      }
      // 每秒重新读取网页设置；新季度任务生成遵守配置的调度间隔。
      const ready = settings.get().enabled && store.db.prepare("SELECT id FROM jobs WHERE status='pending' AND next_attempt<=? AND deadline>? LIMIT 1").get(Date.now(), Date.now());
      await wait(ready ? 1100 : 1000);
    }
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
    logger.info('service_stopped'); store.close();
  }
}
