import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Auth, HttpError, equalSecret } from './auth.js';
import { runtimeConfig } from './settings.js';
import { TelegramClient } from './telegram.js';
import { nextDue, quarterAt, quarterInfo, renderTemplate } from './schedule.js';

const assets = Object.fromEntries([
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
  ['/style.css', 'style.css', 'text/css; charset=utf-8'],
].map(([url, file, type]) => [url, { body: readFileSync(new URL(`../public/${file}`, import.meta.url)), type }]));

function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new HttpError(415, '请求需使用 JSON 格式');
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size <= 65536) chunks.push(chunk); });
    req.on('end', () => {
      if (size > 65536) return reject(new HttpError(413, '设置内容过大'));
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        resolve(parsed);
      } catch { reject(new HttpError(400, '请求内容无效')); }
    });
    req.on('error', reject);
  });
}

export function createAdminServer({ store, settings, dataDir, logger,
  clientFactory = config => new TelegramClient(config.token, config.timeoutMs), secureCookie = false,
  isBusy = () => false }) {
  const auth = new Auth(store, dataDir);
  let apiBusy = false;
  const cookie = (token = '', maxAge = 43200) => `renewal_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`;
  const server = createServer({ requestTimeout: 15000, headersTimeout: 10000, maxHeaderSize: 16384 }, async (req, res) => {
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
      if (!['GET', 'POST', 'PUT'].includes(req.method)) throw new HttpError(405, '不支持此请求方式');
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
        const ip = req.socket.remoteAddress || 'unknown';
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
        await auth.changePassword(data.currentPassword, data.newPassword, req.socket.remoteAddress || 'unknown');
        res.setHeader('Set-Cookie', cookie('', 0)); logger.info('admin_password_changed'); json({ ok: true }); return;
      }
      if (path === '/api/settings' && req.method === 'GET') { json(settings.public()); return; }
      if (path === '/api/settings' && req.method === 'PUT') {
        const data = await body(req);
        if (isBusy() && (data.clearToken || (data.token?.trim() && data.token.trim() !== settings.get().token))) throw new HttpError(409, '当前任务正在发送，请暂停并等待完成后更换 Token');
        const saved = settings.save(data);
        logger.info('settings_saved', { revision: saved.revision, enabled: saved.enabled });
        json(saved); return;
      }
      if (path === '/api/dashboard' && req.method === 'GET') {
        const value = settings.get();
        const counts = Object.fromEntries(store.db.prepare('SELECT status,COUNT(*) AS n FROM jobs GROUP BY status').all().map(row => [row.status, row.n]));
        json({ enabled: value.enabled, initialized: Boolean(value.token),
          groupCount: Object.values(value.classes).reduce((n, c) => n + c.groups.length, 0),
          nextDue: nextDue().date + ' 10:00:00', timeZone: 'Asia/Shanghai', counts,
          jobs: store.list().slice(0, 200), events: settings.events(), busy: isBusy() }); return;
      }
      if (path === '/api/preview' && req.method === 'POST') {
        const data = await body(req);
        const value = { ...settings.get(), ...data, token: settings.get().token, enabled: false };
        const config = runtimeConfig(value, dataDir);
        const current = quarterAt(); const q = quarterInfo(current.year, current.quarter);
        json({ quarter: q.key, due: q.date + ' 10:00:00', messages: config.groups.map(g => ({
          category: g.category, name: g.name, chatId: g.chatId, text: renderTemplate(g.template, g, q),
        })) }); return;
      }
      if (['/api/check', '/api/discover'].includes(path) && req.method === 'POST') {
        await body(req);
        if (apiBusy) throw new HttpError(429, '正在检查，请稍候');
        apiBusy = true;
        try {
          const config = runtimeConfig(settings.get(), dataDir);
          if (!config.token) throw new HttpError(400, '请先填写并保存机器人 Token');
          const telegram = clientFactory(config);
          if (path === '/api/discover') {
            const updates = await telegram.call('getUpdates', { timeout: 0, limit: 100 });
            const chats = new Map();
            for (const update of updates) {
              const chat = update.message?.chat || update.my_chat_member?.chat;
              if (chat && ['group', 'supergroup'].includes(chat.type)) chats.set(String(chat.id), { name: chat.title, chatId: String(chat.id) });
            }
            json({ groups: [...chats.values()] });
          } else {
            const me = await telegram.call('getMe');
            const results = [];
            for (const g of config.groups) {
              try { await telegram.assertCanSend(g.chatId); results.push({ name: g.name, chatId: g.chatId, ok: true }); }
              catch (error) { results.push({ name: g.name, chatId: g.chatId, ok: false, error: friendlyTelegram(error) }); }
            }
            json({ bot: me.username || String(me.id), results });
          }
        } finally { apiBusy = false; }
        return;
      }
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
  if (error.kind === 'permission_denied' || error.code === 403) return '机器人不在群内，或没有发送权限';
  if (error.kind === 'wrong_chat' || error.code === 400) return '群 ID、群类型或请求参数不正确';
  return '暂时无法连接 Telegram，请检查 VPS 网络并稍后重试';
}
