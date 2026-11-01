import { failurePolicy } from './telegram.js';

export class Worker {
  // runtime(job) 返回 { telegram, retryBaseMs, retryMaxMs }，机器人已不存在时返回 null。
  constructor({ store, runtime, logger, now = Date.now, random = Math.random, beforeSend = () => true, leaseMs = 105_000 }) {
    Object.assign(this, { store, runtime, logger, now, random, beforeSend, leaseMs });
  }
  onFailure(job, context, error, sending) {
    const now = this.now();
    let status = failurePolicy(error, sending);
    if (status === 'retry' && job.attempts >= job.max_attempts) status = 'failed';
    const exponential = Math.min(context.retryMaxMs, context.retryBaseMs * 2 ** (job.attempts - 1));
    const delay = Math.max(exponential * (1 + this.random() * 0.2), (error.retryAfter || 0) * 1000);
    const nextAttempt = now + Math.ceil(delay);
    const summary = `${error.kind || 'internal'}${error.code == null ? '' : `:${error.code}`}`;
    this.store.finish(job, status === 'retry' ? 'pending' : status, now, { nextAttempt, error: summary });
    this.logger[status === 'retry' ? 'warn' : 'error']('job_' + status, {
      jobId: job.id, botId: job.bot_id, occurrence: job.occurrence, chatId: job.chat_id, attempts: job.attempts,
      error: summary, ...(status === 'retry' ? { nextAttempt: new Date(nextAttempt).toISOString() } : {}),
    });
  }
  async processOne() {
    const job = this.store.claim(this.now(), this.leaseMs);
    if (!job) return false;
    const context = this.runtime(job);
    if (!context) {
      this.store.finish(job, 'skipped', this.now(), { error: 'bot_deleted' });
      return true;
    }
    try {
      await context.telegram.assertCanSend(job.chat_id);
    } catch (error) {
      this.onFailure(job, context, error, false);
      return true;
    }
    const now = this.now();
    const permission = this.beforeSend(job);
    if (permission === 'paused') {
      this.store.finish(job, 'pending', now, { nextAttempt: now + 1000, error: 'paused_before_send' });
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
      result = await context.telegram.send(job.chat_id, job.text);
      if (!Number.isSafeInteger(result?.message_id) || result.message_id <= 0 || String(result?.chat?.id) !== job.chat_id) {
        throw new Error('无效发送回执');
      }
    } catch (error) {
      this.onFailure(job, context, error, true);
      return true;
    }
    // 成功回执后的数据库错误不能进入发送重试分支；保留 sending 供人工核查。
    this.store.finish(job, 'sent', this.now(), { messageId: result.message_id });
    this.logger.info('job_sent', { jobId: job.id, botId: job.bot_id, occurrence: job.occurrence, chatId: job.chat_id, messageId: result.message_id });
    if (job.pin) await this.pin(job, context, result.message_id);
    return true;
  }
  // 消息已经送达并记为成功，置顶失败不能影响任务状态，也不能触发重发。
  async pin(job, context, messageId) {
    try {
      await context.telegram.pin(job.chat_id, messageId);
      this.logger.info('job_pinned', { jobId: job.id, botId: job.bot_id, chatId: job.chat_id, messageId });
    } catch (error) {
      this.logger.error('job_pin_failed', { jobId: job.id, botId: job.bot_id, chatId: job.chat_id, messageId, error: `${error.kind || 'internal'}${error.code == null ? '' : `:${error.code}`}` });
    }
  }
}
