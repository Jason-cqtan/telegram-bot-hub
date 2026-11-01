import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertFields } from '../schema.js';

// 把类型文件放进本目录即完成注册（以 _ 开头和 index.js 除外）。约定见 docs/bot-types.md。
export function assertBotType(type, source = 'bot-type') {
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(type?.id ?? '')) throw new Error(`${source}: id 需为小写字母开头的 2–32 位 a-z0-9-`);
  if (!type.name || !type.description) throw new Error(`${source}: 缺少 name 或 description`);
  for (const method of ['defaults', 'schedules', 'targets', 'plan']) {
    if (typeof type[method] !== 'function') throw new Error(`${source}: 缺少方法 ${method}()`);
  }
  assertFields(type.fields, source);
  return type;
}

const directory = new URL('./', import.meta.url);
const files = readdirSync(fileURLToPath(directory)).filter(file => file.endsWith('.js') && file !== 'index.js' && !file.startsWith('_')).sort();
export const botTypes = new Map();
for (const file of files) {
  const type = assertBotType((await import(new URL(file, directory))).default, file);
  if (botTypes.has(type.id)) throw new Error(`${file}: 类型 id ${type.id} 重复`);
  botTypes.set(type.id, type);
}
