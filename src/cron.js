// 零依赖 cron：标准 5 段（分 时 日 月 周），支持 * , - / 、英文月份/星期、@daily 等宏，
// 以及日字段的 L（当月最后一天）。日与周同时受限时按 Vixie cron 规则取“或”。
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const FIELDS = [
  { name: '分钟', min: 0, max: 59 },
  { name: '小时', min: 0, max: 23 },
  { name: '日', min: 1, max: 31, last: true },
  { name: '月', min: 1, max: 12, names: MONTHS, base: 1 },
  { name: '星期', min: 0, max: 7, names: WEEKDAYS, base: 0 },
];
const MACROS = {
  '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *', '@quarterly': '0 0 1 1,4,7,10 *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *',
};
const cache = new Map();

function parseField(text, field) {
  const values = new Set();
  let last = false;
  const value = part => {
    const index = field.names?.indexOf(part.toLowerCase()) ?? -1;
    const number = index >= 0 ? index + field.base : /^\d+$/.test(part) ? Number(part) : NaN;
    if (!Number.isInteger(number) || number < field.min || number > field.max) {
      throw new Error(`cron 的「${field.name}」字段值 ${part} 无效（范围 ${field.min}–${field.max}）`);
    }
    return number;
  };
  for (const part of text.split(',')) {
    if (field.last && part.toUpperCase() === 'L') { last = true; continue; }
    const [range, stepText, extra] = part.split('/');
    if (extra !== undefined || !range) throw new Error(`cron 的「${field.name}」字段 ${part} 格式无效`);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`cron 的「${field.name}」字段步长 ${stepText} 无效`);
    let start; let end;
    if (range === '*') { start = field.min; end = field.max; }
    else if (range.includes('-')) {
      const pieces = range.split('-');
      if (pieces.length !== 2) throw new Error(`cron 的「${field.name}」字段 ${part} 格式无效`);
      start = value(pieces[0]); end = value(pieces[1]);
      if (start > end) throw new Error(`cron 的「${field.name}」字段范围 ${range} 起点大于终点`);
    } else { start = value(range); end = stepText === undefined ? start : field.max; }
    for (let n = start; n <= end; n += step) values.add(n);
  }
  return { values, last };
}

export function parseCron(expression) {
  if (typeof expression !== 'string') throw new Error('cron 表达式必须是文本');
  const source = expression.trim().replace(/\s+/g, ' ');
  if (cache.has(source)) return cache.get(source);
  const expanded = MACROS[source.toLowerCase()] || source;
  if (expanded.startsWith('@')) throw new Error(`不支持的 cron 宏 ${source}`);
  const parts = expanded.split(' ');
  if (parts.length !== 5) throw new Error('cron 表达式需要 5 段：分 时 日 月 周');
  const [minute, hour, day, month, weekday] = parts.map((part, index) => parseField(part, FIELDS[index]));
  // 周字段的 7 与 0 都表示周日。
  if (weekday.values.delete(7)) weekday.values.add(0);
  const parsed = {
    source, expanded, minutes: [...minute.values].sort((a, b) => a - b), hours: [...hour.values].sort((a, b) => a - b),
    days: day.values, lastDay: day.last, months: month.values, weekdays: weekday.values,
    dayRestricted: !parts[2].startsWith('*'), weekdayRestricted: !parts[4].startsWith('*'),
  };
  if (cache.size > 500) cache.clear();
  cache.set(source, parsed);
  return parsed;
}

export function assertTimeZone(timeZone) {
  try { new Intl.DateTimeFormat('en-CA', { timeZone }); return timeZone; }
  catch { throw new Error(`时区 ${timeZone} 无效，请使用 IANA 名称，例如 Asia/Shanghai`); }
}

const formatters = new Map();
function formatter(timeZone) {
  if (!formatters.has(timeZone)) formatters.set(timeZone, new Intl.DateTimeFormat('en-CA', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }));
  return formatters.get(timeZone);
}

export function wallClock(ms, timeZone) {
  const parts = {};
  for (const { type, value } of formatter(timeZone).formatToParts(new Date(ms))) if (type !== 'literal') parts[type] = Number(value);
  return parts;
}

const offsets = new Map();
function offsetAt(ms, timeZone) {
  const key = `${timeZone}|${ms}`;
  if (offsets.has(key)) return offsets.get(key);
  const w = wallClock(ms, timeZone);
  const offset = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000;
  if (offsets.size > 2000) offsets.clear();
  offsets.set(key, offset);
  return offset;
}

function dayMatches(cron, year, month, day, weekday) {
  if (!cron.months.has(month)) return false;
  const lastOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const domHit = cron.days.has(day) || (cron.lastDay && day === lastOfMonth);
  const dowHit = cron.weekdays.has(weekday);
  return cron.dayRestricted && cron.weekdayRestricted ? domHit || dowHit : domHit && dowHit;
}

// 返回 after 之后（严格大于）第一次触发的 UTC 毫秒；永不触发（如 2 月 31 日）返回 null。
// DST 跳过的时刻不触发；回拨重复的时刻两次都返回，由任务唯一键按墙上时间去重。
export function nextAfter(cronOrExpression, after, timeZone = 'Asia/Shanghai') {
  const cron = typeof cronOrExpression === 'string' ? parseCron(cronOrExpression) : cronOrExpression;
  // Intl 较慢，按 15 分钟桶复用偏移（现行时区的切换都落在整刻）。
  const base = Math.floor((after + offsetAt(after - after % 900_000, timeZone)) / 86_400_000) * 86_400_000;
  // 2 月 29 日最长相隔 8 年。
  for (let i = -1; i < 366 * 9; i++) {
    const dayMs = base + i * 86_400_000;
    const date = new Date(dayMs);
    const [year, month, day] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    if (!dayMatches(cron, year, month, day, date.getUTCDay())) continue;
    const before = offsetAt(dayMs - 86_400_000, timeZone);
    const later = offsetAt(dayMs + 2 * 86_400_000, timeZone);
    const candidates = before === later ? [before] : [Math.max(before, later), Math.min(before, later)];
    let best = null;
    for (const offset of candidates) {
      for (const hour of cron.hours) {
        for (const minute of cron.minutes) {
          const candidate = dayMs + hour * 3_600_000 + minute * 60_000 - offset;
          if (candidate <= after || (best !== null && candidate >= best)) continue;
          if (candidates.length > 1) {
            const w = wallClock(candidate, timeZone);
            if (w.day !== day || w.hour !== hour || w.minute !== minute) continue;
          }
          best = candidate;
        }
      }
    }
    if (best !== null) return best;
  }
  return null;
}

export function nextRuns(expression, after, timeZone, count = 5) {
  const cron = parseCron(expression);
  const runs = [];
  let cursor = after;
  while (runs.length < count) {
    const next = nextAfter(cron, cursor, timeZone);
    if (next === null) break;
    runs.push(next); cursor = next;
  }
  return runs;
}

const pad = n => String(n).padStart(2, '0');
const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// 调度与模板共用的“本次触发”信息，日期均按机器人时区。
export function occurrenceInfo(at, timeZone) {
  const w = wallClock(at, timeZone);
  const date = `${w.year}-${pad(w.month)}-${pad(w.day)}`;
  const time = `${pad(w.hour)}:${pad(w.minute)}`;
  const weekday = new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
  return { at, timeZone, ...w, date, time, key: `${date}T${time}`, weekday: WEEKDAY_NAMES[weekday] };
}

function stepOf(sorted, min, max) {
  if (sorted.length < 2 || sorted[0] !== min) return 0;
  const step = sorted[1] - sorted[0];
  const full = sorted.every((value, index) => value === min + index * step) && sorted.at(-1) + step > max;
  return full ? step : 0;
}

export function describeCron(expression) {
  const c = parseCron(expression);
  const months = [...c.months].sort((a, b) => a - b);
  const allMonths = months.length === 12;
  const dates = [...c.days].sort((a, b) => a - b);
  const weekdays = [...c.weekdays].sort((a, b) => a - b);
  const dom = c.dayRestricted ? [dates.length ? `${dates.join('、')} 日` : '', c.lastDay ? '最后一天' : ''].filter(Boolean).join('和') : '';
  const dow = c.weekdayRestricted ? weekdays.map(d => WEEKDAY_NAMES[d]).join('、') : '';
  let day = '每天';
  if (dom && dow) day = `${allMonths ? '每月 ' : ''}${dom}或${dow}`;
  else if (dom) day = `${allMonths ? '每月 ' : ''}${dom}`;
  else if (dow) day = allMonths ? `每${dow}` : dow;
  const prefix = allMonths ? '' : `每年 ${months.join('、')} 月的`;

  const everyHour = c.hours.length === 24;
  const minuteStep = stepOf(c.minutes, 0, 59);
  const hourStep = stepOf(c.hours, 0, 23);
  let time;
  if (everyHour && c.minutes.length === 60) time = '每分钟';
  else if (everyHour && minuteStep) time = `每 ${minuteStep} 分钟`;
  else if (everyHour && c.minutes.length === 1) time = `每小时第 ${c.minutes[0]} 分`;
  else if (c.minutes.length === 1 && hourStep > 1) time = `每 ${hourStep} 小时的第 ${c.minutes[0]} 分`;
  else if (c.hours.length * c.minutes.length <= 6) time = c.hours.flatMap(h => c.minutes.map(m => `${pad(h)}:${pad(m)}`)).join('、');
  else time = `${c.hours.join('、')} 时的第 ${c.minutes.join('、')} 分`;
  // “每天 每 30 分钟”读着别扭，高频计划省掉“每天”。
  return `${prefix}${day === '每天' && time.startsWith('每') ? time : `${day} ${time}`}`;
}
