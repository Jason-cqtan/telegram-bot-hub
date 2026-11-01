import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Auth, HttpError, equalSecret } from './auth.js';
import { TelegramClient } from './telegram.js';
import { OPTION_FIELDS } from './bots.js';
import { assertTimeZone, describeCron, nextAfter, nextRuns, occurrenceInfo } from './cron.js';
import { botGuide, HELP } from './guide.js';

const assets = Object.fromEntries([
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
  ['/style.css', 'style.css', 'text/css; charset=utf-8'],
].map(([url, file, type]) => [url, { body: readFileSync(new URL(`../public/${file}`, import.meta.url)), type }]));

function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new HttpError(415, '请求需使用 JSON 格式');
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size <= 524288) chunks.push(chunk); });
    req.on('end', () => {
      if (size > 524288) return reject(new HttpError(413, '设置内容过大'));
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        resolve(parsed);
      } catch { reject(new HttpError(400, '请求内容无效')); }
    });
    req.on('error', reject);
  });
}

export function createAdminServer({ store, bots, scheduler, types, dataDir, logger,
  clientFactory = bot => new TelegramClient(bot.token), secureCookie = false, trustProxy = false,
  isBusy = () => false }) {
  const auth = new Auth(store, dataDir);
  let apiBusy = false;
  const cookie = (token = '', maxAge = 43200) => `hub_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`;
  // 经 Caddy 转发时 socket 地址都是本机；XFF 最后一段由 Caddy 写入，客户端伪造不了。
  const clientIp = req => (trustProxy && req.headers['x-forwarded-for']?.split(',').at(-1).trim()) || req.socket.remoteAddress || 'unknown';
  const describeBot = bot => {
    const value = bots.public(bot);
    return { ...value, targetCount: bots.targets(bot).length, upcoming: scheduler.upcoming(bot) };
  };
  async function exclusive(fn) {
    if (apiBusy) throw new HttpError(429, '正在检查，请稍候');
    apiBusy = true;
    try { return await fn(); } finally { apiBusy = false; }
  }
  function previewMessages(bot, config, timeZone) {
    const type = bots.typeOf(bot);
    const now = Date.now();
    return Promise.all(type.schedules(config).map(async schedule => {
      const at = nextAfter(schedule.cron, now, timeZone) ?? now;
      const messages = await type.plan({ bot: { id: bot.id, name: bot.name, username: bot.username, timeZone }, config, schedule,
        occurrence: occurrenceInfo(at, timeZone), telegram: null, logger, preview: true });
      return { schedule: schedule.label, cron: schedule.cron, at, messages };
    }));
  }
  async function botRoute(req, res, json, id, action) {
    const bot = bots.require(id);
    if (!action && req.method === 'GET') {
      json({ ...describeBot(bot), guide: botGuide(bots.public(bot), bots.typeOf(bot), bots.targets(bot)) }); return;
    }
    if (!action && req.method === 'PUT') {
      const data = await body(req);
      const token = typeof data.token === 'string' ? data.token.trim() : '';
      const tokenChanges = data.clearToken || (token && token !== bot.token);
      if (tokenChanges && isBusy(id)) throw new HttpError(409, '这个机器人正在发送，请稍后再更换 Token');
      let username;
      if (token && token !== bot.token) {
        // Token 明确无效时拒绝保存；网络问题不阻塞，留给「检查连接」。
        try { username = (await clientFactory({ ...bot, token }).call('getMe')).username ?? null; }
        catch (error) { if (error.code === 401 || error.code === 404) throw new HttpError(400, 'Telegram 拒绝了这个 Token，请从 @BotFather 重新复制'); }
      }
      const saved = bots.save(id, { ...data, ...(username === undefined ? {} : { username }) });
      logger.info('bot_saved', { botId: id, revision: saved.revision });
      json(describeBot(saved)); return;
    }
    if (!action && req.method === 'DELETE') {
      if (isBusy(id)) throw new HttpError(409, '这个机器人正在发送，请稍后再删除');
      bots.remove(id);
      logger.warn('bot_deleted', { botId: id, name: bot.name });
      json({ ok: true }); return;
    }
    if (req.method !== 'POST') throw new HttpError(405, '不支持此请求方式');
    const data = await body(req);
    if (action === 'enabled') {
      const saved = bots.setEnabled(id, data.enabled);
      logger.info(saved.enabled ? 'bot_enabled' : 'bot_paused', { botId: id });
      json(describeBot(saved)); return;
    }
    if (action === 'preview') {
      const value = bots.normalize(bot, data);
      json({ timeZone: value.timeZone, groups: await previewMessages(bot, value.config, value.timeZone) }); return;
    }
    if (!['check', 'discover', 'test-send'].includes(action)) throw new HttpError(404, '接口不存在');
    if (!bot.token) throw new HttpError(400, '请先填写并保存机器人 Token');
    await exclusive(async () => {
      const telegram = clientFactory(bot);
      if (action === 'discover') {
        const updates = await telegram.call('getUpdates', { timeout: 0, limit: 100, allowed_updates: ['message', 'channel_post', 'my_chat_member'] });
        const chats = new Map();
        for (const update of updates) {
          const chat = update.message?.chat || update.channel_post?.chat || update.my_chat_member?.chat;
          if (chat && ['group', 'supergroup', 'channel'].includes(chat.type)) chats.set(String(chat.id), { name: chat.title, chatId: String(chat.id), type: chat.type });
        }
        json({ groups: [...chats.values()] }); return;
      }
      if (action === 'check') {
        const me = await telegram.call('getMe');
        const results = [];
        for (const target of bots.targets(bot)) {
          // 缺置顶权限只提示，不算检查失败：消息照样能发出去。
          try {
            const access = await telegram.assertCanSend(target.chatId);
            results.push({ name: target.name, chatId: target.chatId, ok: true, ...(target.pin && !access?.canPin ? { warning: '可以发送，但不能置顶。请把机器人设为管理员并打开「置顶消息」权限（频道是「编辑消息」）' } : {}) });
          }
          catch (error) { results.push({ name: target.name, chatId: target.chatId, ok: false, error: friendlyTelegram(error) }); }
        }
        bots.recordCheck(id, me.username ?? null, results.length > 0 && results.every(row => row.ok));
        logger.info('bot_checked', { botId: id, targets: results.length, failed: results.filter(row => !row.ok).length });
        json({ bot: me.username || String(me.id), results }); return;
      }
      const target = bots.targets(bot).find(item => item.chatId === String(data.chatId));
      if (!target) throw new HttpError(400, '请选择一个已保存的发送目标');
      const groups = await previewMessages(bot, bot.config, bot.timeZone);
      const message = groups.flatMap(group => group.messages).find(item => item.chatId === target.chatId);
      const text = `【测试】\n${message?.text ?? `来自 ${bot.name} 的测试消息`}`.slice(0, 4096);
      const sent = await telegram.send(target.chatId, text);
      logger.info('test_sent', { botId: id, chatId: target.chatId });
      json({ ok: true, messageId: sent.message_id, name: target.name });
    });
  }
  const server = createServer({ requestTimeout: 30000, headersTimeout: 10000, maxHeaderSize: 16384 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (secureCookie) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    function json(value, status = 200) {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    }
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && assets[path]) {
        res.writeHead(200, { 'Content-Type': assets[path].type }); res.end(assets[path].body); return;
      }
      if (!path.startsWith('/api/')) throw new HttpError(404, '页面不存在');
      const mutation = req.method !== 'GET';
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) throw new HttpError(405, '不支持此请求方式');
      if (mutation) {
        const expectedOrigin = `${secureCookie ? 'https' : 'http'}://${req.headers.host}`;
        if (!req.headers.origin || req.headers.origin !== expectedOrigin) throw new HttpError(403, '请求来源不匹配，请从当前后台页面操作');
      }
      const session = auth.lookup(req.headers.cookie);
      if (path === '/api/session' && req.method === 'GET') {
        json({ initialized: auth.initialized(), authenticated: Boolean(session), csrf: session?.csrf,
          username: session ? store.db.prepare('SELECT username FROM admins WHERE id=1').get().username : undefined }); return;
      }
      if (['/api/setup', '/api/login'].includes(path) && req.method === 'POST') {
        const data = await body(req);
        const ip = clientIp(req);
        const result = path === '/api/setup'
          ? await auth.setup(data.key, data.username, data.password, ip)
          : await auth.login(data.username, data.password, ip);
        res.setHeader('Set-Cookie', cookie(result.token));
        logger.info(path === '/api/setup' ? 'admin_created' : 'admin_login');
        json({ csrf: result.csrf }); return;
      }
      if (!session) throw new HttpError(401, '请先登录管理后台');
      if (mutation && !equalSecret(req.headers['x-csrf-token'] || '', session.csrf)) throw new HttpError(403, '页面校验已失效，请刷新后重试');
      if (path === '/api/logout' && req.method === 'POST') {
        auth.logout(session); res.setHeader('Set-Cookie', cookie('', 0)); json({ ok: true }); return;
      }
      if (path === '/api/password' && req.method === 'POST') {
        const data = await body(req);
        await auth.changePassword(data.currentPassword, data.newPassword, clientIp(req));
        res.setHeader('Set-Cookie', cookie('', 0)); logger.info('admin_password_changed'); json({ ok: true }); return;
      }
      if (path === '/api/meta' && req.method === 'GET') {
        json({ help: HELP, optionFields: OPTION_FIELDS,
          types: [...types.values()].map(type => ({ id: type.id, name: type.name, description: type.description, fields: type.fields })) }); return;
      }
      if (path === '/api/dashboard' && req.method === 'GET') {
        const counts = Object.fromEntries(store.db.prepare('SELECT status,COUNT(*) AS n FROM jobs GROUP BY status').all().map(row => [row.status, row.n]));
        json({ bots: bots.list().map(describeBot), counts, jobs: store.list(200), events: store.events() }); return;
      }
      if (path === '/api/cron' && req.method === 'POST') {
        const data = await body(req);
        const timeZone = assertTimeZone(data.timeZone || 'Asia/Shanghai');
        const runs = nextRuns(data.cron, Date.now(), timeZone, 5);
        if (!runs.length) throw new HttpError(400, '这个表达式永远不会触发，请检查日期（例如 2 月 31 日）');
        json({ description: describeCron(data.cron), timeZone, runs: runs.map(at => occurrenceInfo(at, timeZone)).map(o => `${o.date} ${o.weekday} ${o.time}`) }); return;
      }
      if (path === '/api/bots' && req.method === 'POST') {
        const created = bots.create(await body(req));
        logger.info('bot_created', { botId: created.id, type: created.type, name: created.name });
        json(describeBot(created)); return;
      }
      const match = /^\/api\/bots\/(\d+)(?:\/([a-z-]+))?$/.exec(path);
      if (match) { await botRoute(req, res, json, Number(match[1]), match[2]); return; }
      if (path === '/api/resolve' && req.method === 'POST') {
        const data = await body(req);
        if (!Number.isSafeInteger(data.id) || data.id <= 0) throw new HttpError(400, '任务编号无效');
        if (data.decision === 'retry' && data.ackDuplicateRisk !== true) throw new HttpError(400, '请先核查群内记录，并确认重发风险');
        store.resolve(data.id, data.decision, Date.now());
        logger.warn('manual_resolution', { jobId: data.id, decision: data.decision }); json({ ok: true }); return;
      }
      throw new HttpError(404, '接口不存在');
    } catch (error) {
      const status = error.status || (error.kind ? 502 : 400);
      const message = error.kind ? friendlyTelegram(error) : (status >= 500 ? '服务暂时异常，请查看运行日志' : error.message);
      json({ error: message }, status);
    }
  });
  server.keepAliveTimeout = 5000;
  return { server, auth };
}

function friendlyTelegram(error) {
  if (error.code === 401) return 'Token 无效，请重新填写';
  if (error.code === 409) return '机器人被其他服务占用（可能已设置 webhook），请使用独立机器人';
  if (error.code === 429) return 'Telegram 请求过于频繁，请稍后重试';
  if (error.kind === 'permission_denied' || error.code === 403) return '机器人不在目标里，或没有发送权限';
  if (error.kind === 'wrong_chat' || error.code === 400) return '目标 ID 不正确，或机器人没有加入（普通群升级后 ID 会变）';
  return '暂时无法连接 Telegram，请检查 VPS 网络并稍后重试';
}
