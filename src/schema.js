import { randomBytes } from 'node:crypto';
import { nextAfter, parseCron } from './cron.js';

// 机器人类型用字段声明配置，后台表单和服务端校验都由这份声明生成，新增类型不用写前端。
// 字段类型：text | textarea | number | boolean | select | date | cron | chats | list
export const FIELD_TYPES = ['text', 'textarea', 'number', 'boolean', 'select', 'date', 'cron', 'chats', 'list'];
const CHAT_ID = /^-?[1-9]\d*$/;

export function validateFields(fields, input, where = '') {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const result = {};
  for (const field of fields) result[field.key] = validateField(field, source[field.key], `${where}「${field.label}」`);
  return result;
}

function validateField(field, value, name) {
  const missing = value === undefined || value === null || value === '';
  switch (field.type) {
    case 'text': case 'textarea': {
      if (missing) { if (field.required) throw new Error(`${name}不能为空`); return ''; }
      if (typeof value !== 'string') throw new Error(`${name}必须是文本`);
      const text = field.type === 'text' ? value.trim() : value;
      if (field.required && !text.trim()) throw new Error(`${name}不能为空`);
      if (text.length > (field.maxLength ?? 4096)) throw new Error(`${name}不能超过 ${field.maxLength ?? 4096} 个字符`);
      return text;
    }
    case 'number': {
      if (missing && !field.required) return field.default ?? null;
      if (!Number.isFinite(value) || (field.integer !== false && !Number.isInteger(value))) throw new Error(`${name}必须是数字`);
      if (value < (field.min ?? -Infinity) || value > (field.max ?? Infinity)) throw new Error(`${name}需在 ${field.min}–${field.max} 之间`);
      return value;
    }
    case 'boolean': return value === true;
    case 'select': {
      if (missing && !field.required) return field.default ?? '';
      if (!field.options.some(option => option.value === value)) throw new Error(`${name}的选项无效`);
      return value;
    }
    case 'date': {
      if (missing) { if (field.required) throw new Error(`${name}不能为空`); return ''; }
      const date = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : null;
      if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error(`${name}必须是有效日期，例如 2026-11-09`);
      return value;
    }
    case 'cron': {
      if (missing) { if (field.required) throw new Error(`${name}不能为空`); return ''; }
      let cron;
      try { cron = parseCron(value); } catch (error) { throw new Error(`${name}：${error.message}`); }
      if (nextAfter(cron, Date.now(), 'UTC') === null) throw new Error(`${name}永远不会触发，请检查日期（例如 2 月 31 日）`);
      return cron.source;
    }
    case 'chats': {
      const list = value ?? [];
      if (!Array.isArray(list)) throw new Error(`${name}格式无效`);
      if (list.length > (field.maxItems ?? 100)) throw new Error(`${name}最多 ${field.maxItems ?? 100} 个`);
      const seen = new Set();
      return list.map(chat => {
        const chatId = String(chat?.chatId ?? '').trim();
        if (!CHAT_ID.test(chatId) || !Number.isSafeInteger(Number(chatId))) throw new Error(`${name}的 ID「${chatId}」无效：群和频道是负整数（如 -1001234567890），不要填邀请链接`);
        if (seen.has(chatId)) throw new Error(`${name}里 ${chatId} 重复了`);
        seen.add(chatId);
        const label = String(chat?.name ?? '').trim();
        if (!label || label.length > 128) throw new Error(`${name}里 ${chatId} 的名称需为 1–128 个字符`);
        return { name: label, chatId };
      });
    }
    case 'list': {
      const list = value ?? [];
      if (!Array.isArray(list)) throw new Error(`${name}格式无效`);
      if (list.length < (field.minItems ?? 0)) throw new Error(`${name}至少需要 ${field.minItems} 项`);
      if (list.length > (field.maxItems ?? 50)) throw new Error(`${name}最多 ${field.maxItems ?? 50} 项`);
      const seen = new Set();
      return list.map((item, index) => {
        const normalized = validateFields(field.fields, item, `${name}第 ${index + 1} 项的`);
        if (field.keyed) {
          // id 让调度与防重在改名、调整顺序后保持不变。
          const id = /^[A-Za-z0-9_-]{4,32}$/.test(item?.id ?? '') && !seen.has(item.id) ? item.id : randomBytes(6).toString('base64url');
          seen.add(id);
          return { id, ...normalized };
        }
        return normalized;
      });
    }
    default: throw new Error(`未知字段类型 ${field.type}`);
  }
}

// 启动时校验类型声明，写错的类型在测试和启动阶段就能暴露。
export function assertFields(fields, owner) {
  if (!Array.isArray(fields)) throw new Error(`${owner} 的 fields 必须是数组`);
  const keys = new Set();
  for (const field of fields) {
    if (!field?.key || !field.label || !FIELD_TYPES.includes(field.type)) throw new Error(`${owner} 的字段 ${field?.key} 缺少 key/label 或 type 不支持`);
    if (keys.has(field.key)) throw new Error(`${owner} 的字段 ${field.key} 重复`);
    keys.add(field.key);
    if (field.type === 'select' && !Array.isArray(field.options)) throw new Error(`${owner} 的字段 ${field.key} 需要 options`);
    if (field.type === 'list') assertFields(field.fields, `${owner}.${field.key}`);
  }
}
