import { newPlan, planField, planMessages, planSchedules, planTargets, validatePlanTemplates } from './_plans.js';

const QUARTER_END = '0 10 L 3,6,9,12 *';

const PERIOD_VARIABLE = /\{(next_)?period(_start|_end)?\}/;

// 总是从起始日推算，不在上一期的结果上累加：11-30 起算时 2 月取 02-28，5 月仍回到 05-30。
function addMonths(start, months) {
  const [year, month, day] = start.split('-').map(Number);
  const total = year * 12 + month - 1 + months;
  const targetYear = Math.floor(total / 12);
  const targetMonth = total - targetYear * 12 + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  return `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

// 周期含开始日、不含结束日：结束日当天已属于下一期。日期都是 YYYY-MM-DD，可以直接比较字符串。
function periodVariables(date, start, months) {
  const [year, month] = start.split('-').map(Number);
  const [dateYear, dateMonth] = date.split('-').map(Number);
  let index = Math.floor(((dateYear - year) * 12 + dateMonth - month) / months);
  while (addMonths(start, index * months) > date) index -= 1;
  while (addMonths(start, (index + 1) * months) <= date) index += 1;
  const [from, to, after] = [index, index + 1, index + 2].map(step => addMonths(start, step * months));
  return {
    period_start: from, period_end: to, period: `${from} 至 ${to}`,
    next_period_start: to, next_period_end: after, next_period: `${to} 至 ${after}`,
  };
}

function variables(occurrence, plan) {
  const quarter = Math.ceil(occurrence.month / 3);
  return {
    year: occurrence.year, quarter, quarter_key: `${occurrence.year}-Q${quarter}`,
    next_year: quarter === 4 ? occurrence.year + 1 : occurrence.year, next_quarter: quarter === 4 ? 1 : quarter + 1,
    due_date: occurrence.date, time: occurrence.time,
    ...(plan?.period_start ? periodVariables(occurrence.date, plan.period_start, plan.period_months) : {}),
  };
}

export default {
  id: 'renewal',
  name: '续费提醒',
  description: '按计划向合租群发送续费通知，内置季度变量（当前季度、下季度等）。',
  fields: [planField({
    itemLabel: '通知计划',
    defaultCron: QUARTER_END,
    defaultTemplate: '{plan_name} 的朋友们，{year} 年第 {quarter} 季度即将结束，请及时续费第 {next_quarter} 季度（{next_year} 年）。\n通知日期：{due_date}',
    templateHelp: '可用变量：{group_name} {plan_name} {year} {quarter} {quarter_key} {next_year} {next_quarter} {due_date} {time}。填了服务周期起始日后还可以用：{period} 是通知当天所在的周期，{next_period} 是它的下一期，显示为「2026-11-09 至 2027-02-09」；只要单个日期时用 {period_start} {period_end} {next_period_start} {next_period_end}。纯文本发送，回车即换行。',
    extraFields: [
      { key: 'period_start', label: '服务周期起始日（选填）', type: 'date', help: '任意一期的开始日期，例如 2026-11-09。以后每一期都由它推算。' },
      { key: 'period_months', label: '每期月数', type: 'number', min: 1, max: 24, default: 3, help: '一个季度填 3。' },
    ],
  })],
  defaults: () => ({ plans: [
    newPlan('A 类合租', QUARTER_END, '【A类合租续费通知】\n各位好，{year} 年第 {quarter} 季度即将结束。请准备续费第 {next_quarter} 季度（{next_year} 年）的合租订阅。\n请按群内约定联系管理员办理，谢谢！\n通知日期：{due_date}'),
    newPlan('B 类合租', QUARTER_END, '【B类合租续费通知】\n{group_name} 的朋友们，{year} 年第 {quarter} 季度即将结束，请及时续费下季度订阅。\n续费方式及金额请查看群公告或联系管理员。\n通知日期：{due_date}'),
  ] }),
  guide: {
    title: '设置续费计划',
    body: '在「参数设置」里为每类合租建一个通知计划：写好消息模板，选执行时间（默认每季度最后一天 10:00），把对应的群加进来。金额、截止日期、付款方式都可以直接写进模板。如果服务周期不是自然季度，填上服务周期起始日，就能在消息里用 {period} 和 {next_period} 显示这一期和下一期的日期。',
  },
  validate(config) {
    for (const plan of config.plans) {
      if (!plan.period_start && PERIOD_VARIABLE.test(plan.template)) throw new Error(`「${plan.name}」的消息内容用了服务周期变量，请先填写「服务周期起始日」`);
    }
    validatePlanTemplates(config, variables);
  },
  schedules: planSchedules,
  targets: planTargets,
  plan: context => planMessages(context, variables),
};
