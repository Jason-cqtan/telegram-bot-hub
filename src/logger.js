const levels = { debug: 10, info: 20, warn: 30, error: 40 };
export function createLogger(level = 'info', secrets = [], write = line => process.stdout.write(line)) {
  function redact(value) {
    let text = JSON.stringify(value);
    for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[REDACTED]');
    return text.replace(/\d{5,}:[A-Za-z0-9_-]{20,}/g, '[REDACTED]');
  }
  return Object.fromEntries(Object.keys(levels).map(name => [name, (event, fields = {}) => {
    if (levels[name] >= levels[level]) write(redact({ ...fields, time: new Date().toISOString(), level: name, event }) + '\n');
  }]));
}
