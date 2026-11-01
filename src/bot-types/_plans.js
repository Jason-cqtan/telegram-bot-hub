import { randomBytes } from 'node:crypto';
import { occurrenceInfo } from '../cron.js';
import { renderTemplate } from '../template.js';

// “若干计划，每个计划一个 cron、一份模板、若干目标”是最常见的形态，供机器人类型复用。
// 文件名以 _ 开头，不会被注册成类型。
export function planField({ itemLabel, templateHelp, defaultCron, defaultTemplate }) {
  return {
    key: 'plans', label: `${itemLabel}列表`, type: 'list', keyed: true, itemLabel, minItems: 1, maxItems: 30,
    fields: [
      { key: 'name', label: `${itemLabel}名称`, type: 'text', required: true, maxLength: 64, placeholder: '例如：A 类合租' },
      { key: 'cron', label: '执行时间', type: 'cron', required: true, default: defaultCron },
      { key: 'template', label: '消息内容', type: 'textarea', required: true, maxLength: 4096, rows: 7, help: templateHelp, default: defaultTemplate },
      { key: 'chats', label: '发送到', type: 'chats', maxItems: 100 },
    ],
  };
}

export const newPlan = (name, cron, template) => ({ id: randomBytes(6).toString('base64url'), name, cron, template, chats: [] });

export const planSchedules = config => config.plans.map(plan => ({ key: plan.id, label: plan.name, cron: plan.cron }));
export const planTargets = config => config.plans.flatMap(plan => plan.chats);

export function planMessages({ schedule, occurrence, config }, variables) {
  const plan = config.plans.find(item => item.id === schedule.key);
  if (!plan) return [];
  return plan.chats.map(chat => ({
    chatId: chat.chatId, chatName: chat.name, label: plan.name,
    text: renderTemplate(plan.template, { ...variables(occurrence), plan_name: plan.name, group_name: chat.name }),
  }));
}

// 用接近长度上限的未来日期试渲染，让未知变量和超长模板在保存时就报错。
export function validatePlanTemplates(config, variables) {
  const sample = occurrenceInfo(Date.UTC(2099, 11, 31, 2), 'UTC');
  for (const plan of config.plans) {
    try { renderTemplate(plan.template, { ...variables(sample), plan_name: plan.name, group_name: plan.chats[0]?.name || '示例群' }); }
    catch (error) { throw new Error(`「${plan.name}」的消息内容：${error.message}`); }
  }
}
