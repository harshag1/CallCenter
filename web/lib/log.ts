// Author: Harsha Gundala
// log.ts — scoped structured logging: console always, best-effort mirror to the logs table.

import { pool } from "./db";

type Level = "info" | "warn" | "error";

function emit(level: Level, scope: string, message: string, data?: Record<string, unknown>) {
  const line = `[${scope}] ${message}`;
  console[level === "info" ? "log" : level](line, data ?? "");
  void pool
    .query(
      "INSERT INTO logs (level, scope, org_id, call_id, message, data) VALUES ($1,$2,$3,$4,$5,$6)",
      [level, scope, data?.orgId ?? null, data?.callId ?? null, message, data ? JSON.stringify(data) : null]
    )
    .catch(() => {});
}

export function log(scope: string) {
  return {
    info: (msg: string, data?: Record<string, unknown>) => emit("info", scope, msg, data),
    warn: (msg: string, data?: Record<string, unknown>) => emit("warn", scope, msg, data),
    error: (msg: string, data?: Record<string, unknown>) => emit("error", scope, msg, data),
  };
}
