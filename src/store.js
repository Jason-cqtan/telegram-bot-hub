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
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY,
        quarter TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        category TEXT NOT NULL,
        text TEXT NOT NULL,
        due_at INTEGER NOT NULL,
        deadline INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt INTEGER NOT NULL,
        lease_until INTEGER,
        owner TEXT,
        message_id INTEGER,
        last_error TEXT,
        updated_at INTEGER NOT NULL,
        UNIQUE (quarter, chat_id)
      );
      CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(status, next_attempt);
      CREATE TABLE IF NOT EXISTS resolutions (
        id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL, previous_status TEXT NOT NULL,
        decision TEXT NOT NULL, resolved_at INTEGER NOT NULL
      );
    `);
  }
  close() { this.db.close(); }
  enqueue(q, group, text, hours, now) {
    return this.db.prepare(`INSERT OR IGNORE INTO jobs
      (quarter, chat_id, category, text, due_at, deadline, next_attempt, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(q.key, group.chatId, group.category, text,
      q.due, q.due + hours * 3_600_000, now, now).changes;
  }
  maintain(now, allowedIds, maxAttempts = 20) {
    // 只回收租约已过期的任务，避免另一进程仍在发送时抢占。
    this.db.prepare(`UPDATE jobs SET status='uncertain', last_error='sending_lease_expired',
      owner=NULL, lease_until=NULL, updated_at=? WHERE status='sending' AND lease_until<=?`).run(now, now);
    this.db.prepare(`UPDATE jobs SET status='pending', owner=NULL, lease_until=NULL, updated_at=?
      WHERE status='checking' AND lease_until<=?`).run(now, now);
    this.db.prepare(`UPDATE jobs SET status='skipped', last_error='catch_up_window_expired', updated_at=?
      WHERE status='pending' AND deadline<=?`).run(now, now);
    this.db.prepare(`UPDATE jobs SET status='failed', last_error='attempts_exhausted', updated_at=?
      WHERE status='pending' AND attempts>=?`).run(now, maxAttempts);
    const allowed = new Set(allowedIds);
    for (const row of this.db.prepare("SELECT id, chat_id FROM jobs WHERE status='pending'").all()) {
      if (!allowed.has(row.chat_id)) this.db.prepare(`UPDATE jobs SET status='skipped',
        last_error='target_removed', updated_at=? WHERE id=? AND status='pending'`).run(now, row.id);
    }
  }
  claim(now, leaseMs) {
    const owner = randomUUID();
    return this.db.prepare(`UPDATE jobs SET status='checking', owner=?, lease_until=?,
      attempts=attempts+1, updated_at=? WHERE id=(SELECT id FROM jobs
      WHERE status='pending' AND next_attempt<=? AND deadline>? ORDER BY due_at,id LIMIT 1)
      AND status='pending' RETURNING *`).get(owner, now + leaseMs, now, now, now);
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
  list() {
    return this.db.prepare(`SELECT id,quarter,chat_id,category,status,attempts,message_id,last_error,
      due_at,deadline,next_attempt,lease_until,updated_at FROM jobs ORDER BY id DESC`).all();
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
      if (decision === 'retry' && now >= job.deadline) throw new Error('补发窗口已过期，禁止发送过期续费通知');
      this.db.prepare(`UPDATE jobs SET status=?, attempts=CASE WHEN ?='retry' THEN 0 ELSE attempts END,
        next_attempt=?, last_error=?, updated_at=? WHERE id=?`)
        .run(decision === 'retry' ? 'pending' : decision, decision, now, `manual_${decision}`, now, id);
      this.db.prepare(`INSERT INTO resolutions (job_id,previous_status,decision,resolved_at)
        VALUES (?,?,?,?)`).run(id, job.status, decision, now);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
