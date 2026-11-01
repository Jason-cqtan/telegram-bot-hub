import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS bots (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        token TEXT NOT NULL DEFAULT '',
        username TEXT,
        enabled INTEGER NOT NULL DEFAULT 0,
        time_zone TEXT NOT NULL,
        options TEXT NOT NULL,
        config TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        checked_key TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      -- 每个启用中的计划一行。anchor 之前的触发点一律不算，因此新建、启用或改 cron 不会补发旧时间点。
      CREATE TABLE IF NOT EXISTS schedules (
        bot_id INTEGER NOT NULL,
        key TEXT NOT NULL,
        label TEXT NOT NULL,
        spec TEXT NOT NULL,
        anchor INTEGER NOT NULL,
        next_at INTEGER,
        PRIMARY KEY (bot_id, key)
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY,
        bot_id INTEGER NOT NULL,
        schedule_key TEXT NOT NULL,
        occurrence TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        label TEXT NOT NULL,
        text TEXT NOT NULL,
        due_at INTEGER NOT NULL,
        deadline INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt INTEGER NOT NULL,
        lease_until INTEGER,
        owner TEXT,
        message_id INTEGER,
        last_error TEXT,
        updated_at INTEGER NOT NULL,
        UNIQUE (bot_id, schedule_key, occurrence, chat_id)
      );
      CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(status, next_attempt);
      CREATE TABLE IF NOT EXISTS resolutions (
        id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL, previous_status TEXT NOT NULL,
        decision TEXT NOT NULL, resolved_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_events (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, value TEXT NOT NULL);
    `);
  }
  close() { this.db.close(); }
  enqueue(job, now) {
    return this.db.prepare(`INSERT OR IGNORE INTO jobs
      (bot_id, schedule_key, occurrence, chat_id, label, text, due_at, deadline, max_attempts, next_attempt, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(job.botId, job.scheduleKey, job.occurrence, job.chatId, job.label,
      job.text, job.dueAt, job.deadline, job.maxAttempts, now, now).changes;
  }
  // isAllowed(job) 判断任务目标是否仍在机器人配置里。
  maintain(now, isAllowed = () => true) {
    // 只回收租约已过期的任务，避免另一进程仍在发送时抢占。
    this.db.prepare(`UPDATE jobs SET status='uncertain', last_error='sending_lease_expired',
      owner=NULL, lease_until=NULL, updated_at=? WHERE status='sending' AND lease_until<=?`).run(now, now);
    this.db.prepare(`UPDATE jobs SET status='pending', owner=NULL, lease_until=NULL, updated_at=?
      WHERE status='checking' AND lease_until<=?`).run(now, now);
    this.db.prepare(`UPDATE jobs SET status='skipped', last_error='catch_up_window_expired', updated_at=?
      WHERE status='pending' AND deadline<=?`).run(now, now);
    this.db.prepare(`UPDATE jobs SET status='failed', last_error='attempts_exhausted', updated_at=?
      WHERE status='pending' AND attempts>=max_attempts`).run(now);
    for (const row of this.db.prepare("SELECT id, bot_id, chat_id FROM jobs WHERE status='pending'").all()) {
      if (!isAllowed(row)) this.db.prepare(`UPDATE jobs SET status='skipped',
        last_error='target_removed', updated_at=? WHERE id=? AND status='pending'`).run(now, row.id);
    }
  }
  claim(now, leaseMs) {
    const owner = randomUUID();
    return this.db.prepare(`UPDATE jobs SET status='checking', owner=?, lease_until=?,
      attempts=attempts+1, updated_at=? WHERE id=(SELECT id FROM jobs
      WHERE status='pending' AND next_attempt<=? AND deadline>?
        AND bot_id IN (SELECT id FROM bots WHERE enabled=1) ORDER BY due_at,id LIMIT 1)
      AND status='pending' RETURNING *`).get(owner, now + leaseMs, now, now, now);
  }
  hasReady(now) {
    return Boolean(this.db.prepare(`SELECT id FROM jobs WHERE status='pending' AND next_attempt<=? AND deadline>?
      AND bot_id IN (SELECT id FROM bots WHERE enabled=1) LIMIT 1`).get(now, now));
  }
  beginSend(job, now, leaseMs) {
    const result = this.db.prepare(`UPDATE jobs SET status='sending', lease_until=?, updated_at=?
      WHERE id=? AND owner=? AND status='checking' AND lease_until>? AND deadline>?`)
      .run(now + leaseMs, now, job.id, job.owner, now, now);
    return result.changes === 1;
  }
  finish(job, status, now, { nextAttempt = now, messageId = null, error = null } = {}) {
    const result = this.db.prepare(`UPDATE jobs SET status=?, next_attempt=?, message_id=?, last_error=?,
      updated_at=?, owner=NULL, lease_until=NULL WHERE id=? AND owner=? AND status IN ('checking','sending')`)
      .run(status, nextAttempt, messageId, error, now, job.id, job.owner);
    if (result.changes !== 1) throw new Error(`任务 ${job.id} 的租约已变化，请核查状态`);
  }
  list(limit = 1000) {
    return this.db.prepare(`SELECT j.id,j.bot_id,COALESCE(b.name,'（已删除）') AS bot_name,j.schedule_key,j.occurrence,j.chat_id,j.label,
      j.status,j.attempts,j.max_attempts,j.message_id,j.last_error,j.due_at,j.deadline,j.next_attempt,j.lease_until,j.updated_at
      FROM jobs j LEFT JOIN bots b ON b.id=j.bot_id ORDER BY j.id DESC LIMIT ?`).all(limit);
  }
  needsAttention() {
    return this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('uncertain','failed')").get().count;
  }
  resolve(id, decision, now) {
    if (!['sent', 'retry', 'skipped'].includes(decision)) throw new Error('决策必须是 sent、retry 或 skipped');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const job = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
      if (!job || !['failed', 'uncertain'].includes(job.status)) throw new Error('只能处理 failed/uncertain 任务');
      if (decision === 'retry' && now >= job.deadline) throw new Error('补发窗口已过期，禁止发送过期通知');
      this.db.prepare(`UPDATE jobs SET status=?, attempts=CASE WHEN ?='retry' THEN 0 ELSE attempts END,
        next_attempt=?, last_error=?, updated_at=? WHERE id=?`)
        .run(decision === 'retry' ? 'pending' : decision, decision, now, `manual_${decision}`, now, id);
      this.db.prepare(`INSERT INTO resolutions (job_id,previous_status,decision,resolved_at)
        VALUES (?,?,?,?)`).run(id, job.status, decision, now);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  event(value) {
    this.db.prepare('INSERT INTO app_events(at,value) VALUES(?,?)').run(Date.now(), JSON.stringify(value));
    this.db.exec('DELETE FROM app_events WHERE id NOT IN (SELECT id FROM app_events ORDER BY id DESC LIMIT 1000)');
  }
  events() {
    return this.db.prepare('SELECT id,value FROM app_events ORDER BY id DESC LIMIT 100').all()
      .map(row => ({ id: row.id, ...JSON.parse(row.value) }));
  }
}
