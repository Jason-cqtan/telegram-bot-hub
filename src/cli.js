import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './logger.js';
import { Store } from './store.js';

process.umask(0o077);
const command = process.argv[2] || 'start';
const logger = createLogger('info');
const dataDir = () => process.env.DATA_DIR || './data';

async function main() {
  if (command === 'start') {
    const { startService } = await import('./service.js');
    await startService(); return;
  }
  if (command === 'health') {
    const heartbeat = JSON.parse(readFileSync(join(dataDir(), 'heartbeat.json'), 'utf8'));
    if (Date.now() - heartbeat.at > 300_000 || heartbeat.attention > 0) throw new Error('服务停滞或有失败/待核查任务，请查看后台发送记录与日志');
    console.log('healthy');
    return;
  }
  if (!['setup-key', 'status'].includes(command)) throw new Error('未知命令，可用：start、setup-key、status、health');
  const { databasePath } = await import('./service.js');
  const store = new Store(databasePath(dataDir()));
  try {
    if (command === 'setup-key') {
      const { Auth } = await import('./auth.js');
      const auth = new Auth(store, dataDir());
      if (auth.initialized()) throw new Error('管理员已创建，请在后台登录');
      console.log(readFileSync(auth.bootstrapPath, 'utf8').trim());
    } else console.log(JSON.stringify(store.list(), null, 2));
  } finally { store.close(); }
}

main().catch(error => {
  logger.error('fatal', { error: error.message });
  process.exitCode = 1;
});
