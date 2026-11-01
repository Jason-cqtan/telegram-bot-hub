import { newPlan, planField, planMessages, planSchedules, planTargets, validatePlanTemplates } from './_plans.js';

const QUARTER_END = '0 10 L 3,6,9,12 *';

function variables(occurrence) {
  const quarter = Math.ceil(occurrence.month / 3);
  return {
    year: occurrence.year, quarter, quarter_key: `${occurrence.year}-Q${quarter}`,
    next_year: quarter === 4 ? occurrence.year + 1 : occurrence.year, next_quarter: quarter === 4 ? 1 : quarter + 1,
    due_date: occurrence.date, time: occurrence.time,
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
    templateHelp: '可用变量：{group_name} {plan_name} {year} {quarter} {quarter_key} {next_year} {next_quarter} {due_date} {time}。纯文本发送，回车即换行。',
  })],
  defaults: () => ({ plans: [
    newPlan('A 类合租', QUARTER_END, '【A类合租续费通知】\n各位好，{year} 年第 {quarter} 季度即将结束。请准备续费第 {next_quarter} 季度（{next_year} 年）的合租订阅。\n请按群内约定联系管理员办理，谢谢！\n通知日期：{due_date}'),
    newPlan('B 类合租', QUARTER_END, '【B类合租续费通知】\n{group_name} 的朋友们，{year} 年第 {quarter} 季度即将结束，请及时续费下季度订阅。\n续费方式及金额请查看群公告或联系管理员。\n通知日期：{due_date}'),
  ] }),
  guide: {
    title: '设置续费计划',
    body: '在「参数设置」里为每类合租建一个通知计划：写好消息模板，选执行时间（默认每季度最后一天 10:00），把对应的群加进来。金额、截止日期、付款方式都可以直接写进模板。',
  },
  validate(config) { validatePlanTemplates(config, variables); },
  schedules: planSchedules,
  targets: planTargets,
  plan: context => planMessages(context, variables),
};
