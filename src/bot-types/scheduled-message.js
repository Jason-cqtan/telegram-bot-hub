import { newPlan, planField, planMessages, planSchedules, planTargets, validatePlanTemplates } from './_plans.js';

const variables = occurrence => ({
  year: occurrence.year, month: occurrence.month, day: occurrence.day,
  date: occurrence.date, time: occurrence.time, weekday: occurrence.weekday,
});

export default {
  id: 'scheduled-message',
  name: '定时消息',
  description: '按 cron 向群、频道或个人发送固定内容，适合日报提醒、打卡、周会通知。',
  fields: [planField({
    itemLabel: '定时任务',
    defaultCron: '0 9 * * 1-5',
    defaultTemplate: '早上好，今天是 {date} {weekday}。',
    templateHelp: '可用变量：{group_name} {plan_name} {year} {month} {day} {date} {time} {weekday}。纯文本发送，回车即换行。',
  })],
  defaults: () => ({ plans: [newPlan('工作日早安', '0 9 * * 1-5', '早上好，今天是 {date} {weekday}。')] }),
  guide: {
    title: '设置定时任务',
    body: '在「参数设置」里写好消息内容，选执行时间，再把目标加进来。频道需要把机器人设为管理员；发给个人时，对方要先在 Telegram 里点过一次机器人的「开始」。',
  },
  validate(config) { validatePlanTemplates(config, variables); },
  schedules: planSchedules,
  targets: planTargets,
  plan: context => planMessages(context, variables),
};
