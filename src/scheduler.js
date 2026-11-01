import { nextAfter, occurrenceInfo } from './cron.js';

const specOf = (cron, timeZone) => `${cron}|${timeZone}`;

export class Scheduler {
  constructor({ store, bots, logger, clientFor = () => null, now = Date.now }) { Object.assign(this, { store, bots, logger, clientFor, now, db: store.db }); }
  // 让 schedules 表与当前配置一致。新出现或变更的计划从“现在”起算，不追溯已过去的时间点；
  // 暂停的机器人删除计划行，所以恢复时同样不补发暂停期间的时间点。
  sync(now) {
    const live = new Set();
    for (const bot of this.bots.list()) {
      if (!bot.enabled || !bot.token || !this.bots.typeOf(bot)) continue;
      for (const schedule of this.bots.schedules(bot)) {
        live.add(`${bot.id}/${schedule.key}`);
        const spec = specOf(schedule.cron, bot.timeZone);
        const row = this.db.prepare('SELECT spec,label FROM schedules WHERE bot_id=? AND key=?').get(bot.id, schedule.key);
        if (row?.spec === spec) {
          if (row.label !== schedule.label) this.db.prepare('UPDATE schedules SET label=? WHERE bot_id=? AND key=?').run(schedule.label, bot.id, schedule.key);
          continue;
        }
        this.db.prepare(`INSERT INTO schedules (bot_id,key,label,spec,anchor,next_at) VALUES (?,?,?,?,?,?)
          ON CONFLICT(bot_id,key) DO UPDATE SET label=excluded.label,spec=excluded.spec,anchor=excluded.anchor,next_at=excluded.next_at`)
          .run(bot.id, schedule.key, schedule.label, spec, now, nextAfter(schedule.cron, now, bot.timeZone));
      }
    }
    for (const row of this.db.prepare('SELECT bot_id,key FROM schedules').all()) {
      if (!live.has(`${row.bot_id}/${row.key}`)) this.db.prepare('DELETE FROM schedules WHERE bot_id=? AND key=?').run(row.bot_id, row.key);
    }
  }
  async tick() {
    const now = this.now();
    this.sync(now);
    for (const row of this.db.prepare('SELECT * FROM schedules WHERE next_at IS NOT NULL AND next_at<=? ORDER BY next_at').all(now)) await this.fire(row, now);
  }
  async fire(row, now) {
    const bot = this.bots.get(row.bot_id);
    const type = bot && this.bots.typeOf(bot);
    const schedule = type?.schedules(bot.config).find(item => item.key === row.key);
    if (!schedule) return;
    // 只发窗口内最近一次：停机三天恢复后，不把三天的每日消息一口气补完。
    const windowMs = bot.options.catchUpHours * 3_600_000;
    let latest = null; let skipped = 0;
    let next = nextAfter(schedule.cron, Math.max(row.anchor, now - windowMs), bot.timeZone);
    while (next !== null && next <= now) {
      if (latest !== null) skipped++;
      latest = next;
      next = nextAfter(schedule.cron, next, bot.timeZone);
    }
    if (latest !== null) {
      try {
        const occurrence = occurrenceInfo(latest, bot.timeZone);
        const messages = await type.plan({ bot: { id: bot.id, name: bot.name, username: bot.username, timeZone: bot.timeZone },
          config: bot.config, schedule, occurrence, telegram: this.clientFor(bot), logger: this.logger, preview: false });
        for (const message of messages) {
          const inserted = this.store.enqueue({ botId: bot.id, scheduleKey: schedule.key, occurrence: occurrence.key, chatId: String(message.chatId),
            label: message.label ?? schedule.label, text: message.text, dueAt: latest, deadline: latest + windowMs, maxAttempts: bot.options.maxAttempts }, now);
          if (inserted) this.logger.info('job_created', { botId: bot.id, occurrence: occurrence.key, chatId: String(message.chatId) });
        }
        if (skipped) this.logger.warn('occurrences_skipped', { botId: bot.id, schedule: schedule.label, skipped });
      } catch (error) {
        // 不重试这个时间点，错误进活动记录；下一个时间点照常触发。
        this.logger.error('schedule_failed', { botId: bot.id, schedule: schedule.label, error: error.message });
      }
    }
    this.db.prepare('UPDATE schedules SET anchor=?,next_at=? WHERE bot_id=? AND key=?').run(now, next, row.bot_id, row.key);
  }
  // 启用中的机器人读计划行；未启用时按配置算，方便在开启前核对。
  upcoming(bot, from = this.now()) {
    return this.bots.schedules(bot).map(schedule => ({ key: schedule.key, label: schedule.label, cron: schedule.cron, nextAt: nextAfter(schedule.cron, from, bot.timeZone) }))
      .sort((a, b) => (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity));
  }
  maintain(now = this.now()) {
    const cache = new Map();
    this.store.maintain(now, job => {
      if (!cache.has(job.bot_id)) {
        const bot = this.bots.get(job.bot_id);
        cache.set(job.bot_id, bot && this.bots.typeOf(bot) ? new Set(this.bots.targets(bot).map(target => target.chatId)) : null);
      }
      return cache.get(job.bot_id)?.has(job.chat_id) ?? false;
    });
  }
}
