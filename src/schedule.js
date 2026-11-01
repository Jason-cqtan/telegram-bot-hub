export const TIME_ZONE = 'Asia/Shanghai';
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});

export function quarterAt(date = new Date()) {
  if (!Number.isFinite(date.getTime())) throw new Error('无效日期');
  const parts = Object.fromEntries(formatter.formatToParts(date).map(p => [p.type, p.value]));
  return { year: Number(parts.year), quarter: Math.ceil(Number(parts.month) / 3) };
}

export function quarterInfo(year, quarter) {
  const lastDay = new Date(Date.UTC(year, quarter * 3, 0)).getUTCDate();
  const month = quarter * 3;
  const date = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;
  return {
    year, quarter, key: `${year}-Q${quarter}`, date,
    due: Date.parse(`${date}T10:00:00+08:00`),
    nextYear: quarter === 4 ? year + 1 : year,
    nextQuarter: quarter === 4 ? 1 : quarter + 1,
  };
}

// 同时考虑上一季度，使 12/31 和 3/31 的补发窗口能跨年、跨季度。
export function eligibleQuarters(now, catchUpHours) {
  const { year, quarter } = quarterAt(new Date(now));
  const previous = quarter === 1 ? quarterInfo(year - 1, 4) : quarterInfo(year, quarter - 1);
  return [previous, quarterInfo(year, quarter)]
    .filter(q => now >= q.due && now < q.due + catchUpHours * 3_600_000);
}

export function nextDue(now = Date.now()) {
  let { year, quarter } = quarterAt(new Date(now));
  let q = quarterInfo(year, quarter);
  if (now >= q.due) {
    if (++quarter === 5) { quarter = 1; year++; }
    q = quarterInfo(year, quarter);
  }
  return q;
}

export function renderTemplate(template, group, q) {
  const values = {
    year: q.year, quarter: q.quarter, quarter_key: q.key,
    next_year: q.nextYear, next_quarter: q.nextQuarter,
    due_date: q.date, class: group.category, group_name: group.name,
  };
  const result = template.replace(/\{([^{}]+)\}/g, (_, key) => {
    if (!Object.hasOwn(values, key)) throw new Error(`未知模板变量：${key}`);
    return String(values[key]);
  });
  if (!result.trim() || result.length > 4096) throw new Error('模板渲染后必须为 1–4096 个 UTF-16 代码单元');
  return result;
}
