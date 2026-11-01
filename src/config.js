import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { quarterInfo, renderTemplate } from './schedule.js';

function integer(env, key, fallback, min, max) {
  const value = env[key] === undefined ? fallback : Number(env[key]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} 必须为 ${min}–${max} 的整数`);
  return value;
}

export function validateConfig(raw, env = process.env, { requireToken = false, allowEmpty = false } = {}) {
  const token = env.BOT_TOKEN || '';
  if (requireToken && (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token) || token.includes('REPLACE_'))) {
    throw new Error('请在 .env 中配置有效的 BOT_TOKEN');
  }
  if (!raw.classes || Object.keys(raw.classes).sort().join(',') !== 'A,B') throw new Error('classes 必须包含且只包含 A、B');
  const groups = [];
  const seen = new Set();
  for (const category of ['A', 'B']) {
    const item = raw.classes[category];
    if (!item || typeof item.template !== 'string' || !Array.isArray(item.groups)) throw new Error(`${category} 类配置无效`);
    for (const group of item.groups) {
      if (!group || typeof group.chatId !== 'string') throw new Error('chatId 必须为字符串');
      const chatId = group.chatId.replace(/^\$\{([A-Z][A-Z0-9_]*)\}$/, (_, key) => env[key] || '');
      if (!/^-[1-9]\d*$/.test(chatId) || !Number.isSafeInteger(Number(chatId)) || Number(chatId) >= 0) {
        throw new Error('chatId 必须为有效的负整数群 ID（检查环境变量）');
      }
      if (seen.has(chatId)) throw new Error('同一群不能重复配置或同时属于 A/B 两类');
      if (typeof group.name !== 'string' || !group.name.trim() || group.name.length > 128) throw new Error('群名称需为 1–128 个字符');
      seen.add(chatId);
      const target = { chatId, category, name: group.name, template: item.template };
      // 启动前校验最接近长度上限的模板变量，运行时仍二次校验。
      renderTemplate(item.template, target, quarterInfo(2099, 4));
      groups.push(target);
    }
  }
  if ((!allowEmpty && !groups.length) || groups.length > 100) throw new Error('请配置 1–100 个群；暂不用的类别 groups 可填 []');
  const logLevel = env.LOG_LEVEL || 'info';
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) throw new Error('LOG_LEVEL 无效');
  return {
    token, groups, dataDir: resolve(env.DATA_DIR || './data'), logLevel,
    pollMs: integer(env, 'POLL_INTERVAL_SECONDS', 15, 1, 60) * 1000,
    catchUpHours: integer(env, 'CATCH_UP_HOURS', 72, 1, 168),
    maxAttempts: integer(env, 'MAX_ATTEMPTS', 6, 1, 20),
    retryBaseMs: integer(env, 'RETRY_BASE_SECONDS', 30, 1, 3600) * 1000,
    retryMaxMs: integer(env, 'RETRY_MAX_SECONDS', 1800, 1, 86400) * 1000,
    timeoutMs: integer(env, 'REQUEST_TIMEOUT_SECONDS', 15, 1, 60) * 1000,
  };
}

export function loadConfig(env = process.env, options = {}) {
  const raw = JSON.parse(readFileSync(resolve(env.CONFIG_PATH || './config/config.json'), 'utf8'));
  return validateConfig(raw, env, options);
}
