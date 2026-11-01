import { eligibleQuarters, renderTemplate } from './schedule.js';
import { failurePolicy } from './telegram.js';

export class Worker {
  constructor({ config, store, telegram, logger, now = Date.now, random = Math.random, beforeSend = () => true }) {
    Object.assign(this, { config, store, telegram, logger, now, random, beforeSend });
    this.leaseMs = config.timeoutMs * 5 + 30_000;
  }
  prepare() {
    const now = this.now();
    for (const q of eligibleQuarters(now, this.config.catchUpHours)) {
      for (const group of this.config.groups) {
        const inserted = this.store.enqueue(q, group, renderTemplate(group.template, group, q), this.config.catchUpHours, now);
        if (inserted) this.logger.info('job_created', { quarter: q.key, chatId: group.chatId });
      }
    }
    this.store.maintain(now, this.config.groups.map(g => g.chatId), this.config.maxAttempts);
  }
  onFailure(job, error, sending) {
    const now = this.now();
    let status = failurePolicy(error, sending);
    if (status === 'retry' && job.attempts >= this.config.maxAttempts) status = 'failed';
    const exponential = Math.min(this.config.retryMaxMs, this.config.retryBaseMs * 2 ** (job.attempts - 1));
    const delay = Math.max(exponential * (1 + this.random() * 0.2), (error.retryAfter || 0) * 1000);
    const nextAttempt = now + Math.ceil(delay);
    const summary = `${error.kind || 'internal'}${error.code == null ? '' : `:${error.code}`}`;
    this.store.finish(job, status === 'retry' ? 'pending' : status, now, { nextAttempt, error: summary });
    this.logger[status === 'retry' ? 'warn' : 'error']('job_' + status, {
      jobId: job.id, quarter: job.quarter, chatId: job.chat_id, attempts: job.attempts,
      error: summary, ...(status === 'retry' ? { nextAttempt: new Date(nextAttempt).toISOString() } : {}),
    });
  }
  async processOne() {
    const job = this.store.claim(this.now(), this.leaseMs);
    if (!job) return false;
    try {
      await this.telegram.assertCanSend(job.chat_id);
    } catch (error) {
      this.onFailure(job, error, false);
      return true;
    }
    const now = this.now();
    const permission = this.beforeSend(job);
    if (permission === 'paused') {
      this.store.finish(job, 'pending', now, { nextAttempt: now + (this.config.pollMs || 1000), error: 'paused_before_send' });
      return true;
    }
    if (permission === 'target_removed') {
      this.store.finish(job, 'skipped', now, { error: 'target_removed' });
      return true;
    }
    if (now >= job.deadline) {
      this.store.finish(job, 'skipped', now, { error: 'catch_up_window_expired' });
      return true;
    }
    if (!this.store.beginSend(job, now, this.leaseMs)) return true;
    let result;
    try {
      result = await this.telegram.send(job.chat_id, job.text);
      if (!Number.isSafeInteger(result?.message_id) || result.message_id <= 0 || String(result?.chat?.id) !== job.chat_id) {
        throw new Error('无效发送回执');
      }
    } catch (error) {
      this.onFailure(job, error, true);
      return true;
    }
    // 成功回执后的数据库错误不能进入发送重试分支；保留 sending 供人工核查。
    this.store.finish(job, 'sent', this.now(), { messageId: result.message_id });
    this.logger.info('job_sent', { jobId: job.id, quarter: job.quarter, chatId: job.chat_id, messageId: result.message_id });
    return true;
  }
}
