export function renderTemplate(template, values) {
  const result = template.replace(/\{([^{}]+)\}/g, (_, key) => {
    if (!Object.hasOwn(values, key)) throw new Error(`未知模板变量：${key}`);
    return String(values[key]);
  });
  if (!result.trim() || result.length > 4096) throw new Error('模板渲染后必须为 1–4096 个 UTF-16 代码单元');
  return result;
}
