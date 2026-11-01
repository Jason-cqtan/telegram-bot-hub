import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
const scrypt = promisify(scryptCallback);
const digest = value => createHash('sha256').update(value).digest();
export const equalSecret = (a, b) => timingSafeEqual(digest(String(a)), digest(String(b)));
const random = () => randomBytes(32).toString('base64url');

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export class Auth {
  constructor(store, dataDir, now = Date.now) {
    this.db = store.db;
    this.now = now;
    this.active = 0;
    this.bootstrapPath = join(dataDir, 'bootstrap-key');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_attempts (ip TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS auth_attempts_time ON auth_attempts(at);
    `);
    if (!this.initialized() && !existsSync(this.bootstrapPath)) writeFileSync(this.bootstrapPath, random(), { mode: 0o600, flag: 'wx' });
  }
  initialized() { return Boolean(this.db.prepare('SELECT id FROM admins WHERE id=1').get()); }
  async derive(password, salt) {
    return (await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })).toString('hex');
  }
  validateCredentials(username, password) {
    if (typeof username !== 'string' || !/^[A-Za-z0-9_.-]{3,32}$/.test(username)) throw new HttpError(400, '用户名需为 3–32 位字母、数字或 _.-');
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw new HttpError(400, '密码需为 12–128 个字符');
  }
  async limited(ip, fn) {
    this.db.prepare('DELETE FROM auth_attempts WHERE at<?').run(this.now() - 900000);
    const local = this.db.prepare('SELECT COUNT(*) AS n FROM auth_attempts WHERE ip=?').get(ip).n;
    const global = this.db.prepare('SELECT COUNT(*) AS n FROM auth_attempts WHERE at>?').get(this.now() - 60000).n;
    if (local >= 5 || global >= 30 || this.active >= 2) throw new HttpError(429, '尝试过于频繁，请稍后再试（失败限制 15 分钟）');
    this.db.prepare('INSERT INTO auth_attempts(ip,at) VALUES(?,?)').run(ip, this.now());
    this.active++;
    try {
      const result = await fn();
      this.db.prepare('DELETE FROM auth_attempts WHERE ip=?').run(ip);
      return result;
    } finally { this.active--; }
  }
  async setup(key, username, password, ip) {
    return this.limited(ip, async () => {
      if (this.initialized()) throw new HttpError(409, '管理员已创建，请登录');
      if (typeof key !== 'string' || !equalSecret(key, readFileSync(this.bootstrapPath, 'utf8').trim())) throw new HttpError(403, '初始化口令不正确');
      this.validateCredentials(username, password);
      const salt = random();
      const hash = await this.derive(password, salt);
      if (this.initialized()) throw new HttpError(409, '管理员已创建，请登录');
      this.db.prepare('INSERT INTO admins(id,username,salt,hash) VALUES(1,?,?,?)').run(username, salt, hash);
      try { unlinkSync(this.bootstrapPath); } catch { /* 已创建管理员时口令无效。 */ }
      return this.session();
    });
  }
  async login(username, password, ip) {
    return this.limited(ip, async () => {
      const row = this.db.prepare('SELECT * FROM admins WHERE id=1').get();
      if (!row) throw new HttpError(409, '请先创建管理员');
      if (typeof username !== 'string' || typeof password !== 'string' || password.length > 128) throw new HttpError(401, '用户名或密码不正确');
      const hash = await this.derive(password, row.salt);
      if (!equalSecret(username, row.username) || !equalSecret(hash, row.hash)) throw new HttpError(401, '用户名或密码不正确');
      return this.session();
    });
  }
  session() {
    this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(this.now());
    const token = random();
    const csrf = random();
    const expires = this.now() + 12 * 3600000;
    this.db.prepare('INSERT INTO sessions(token_hash,csrf,expires) VALUES(?,?,?)').run(digest(token).toString('hex'), csrf, expires);
    return { token, csrf, expires };
  }
  lookup(cookie = '') {
    const token = /(?:^|;\s*)renewal_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(cookie)?.[1];
    if (!token) return null;
    return this.db.prepare('SELECT token_hash,csrf,expires FROM sessions WHERE token_hash=? AND expires>?')
      .get(digest(token).toString('hex'), this.now()) || null;
  }
  logout(session) { this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(session.token_hash); }
  async changePassword(currentPassword, newPassword, ip) {
    return this.limited(ip, async () => {
      const row = this.db.prepare('SELECT * FROM admins WHERE id=1').get();
      if (typeof currentPassword !== 'string' || currentPassword.length > 128 ||
          !equalSecret(await this.derive(currentPassword, row.salt), row.hash)) throw new HttpError(403, '当前密码不正确');
      this.validateCredentials(row.username, newPassword);
      const salt = random();
      const hash = await this.derive(newPassword, salt);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('UPDATE admins SET salt=?,hash=? WHERE id=1').run(salt, hash);
        this.db.exec('DELETE FROM sessions');
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    });
  }
}
