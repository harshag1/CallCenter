const REDACTED_KEY = /(?:authorization|token|secret|signature|api[_-]?key|scope)/i;

function safeField(value, key = "") {
  if (REDACTED_KEY.test(key)) return "[redacted]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.length > 512 ? `${value.slice(0, 509)}...` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => safeField(entry));
  if (value && typeof value === "object") {
    const output = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 40)) {
      output[childKey] = safeField(childValue, childKey);
    }
    return output;
  }
  return String(value);
}

export function createLogger({ sink = console, base = {}, now = () => new Date().toISOString() } = {}) {
  const write = (level, event, fields = {}) => {
    const record = safeField({ at: now(), level, event, ...base, ...fields });
    const line = JSON.stringify(record);
    const method = level === "error" ? "error" : level === "warn" ? "warn" : "log";
    sink[method]?.(line);
  };
  return Object.freeze({
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    child: (fields) => createLogger({ sink, base: { ...base, ...fields }, now }),
  });
}
