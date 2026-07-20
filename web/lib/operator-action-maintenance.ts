import { q } from "./db";

const DEFAULT_PRIVATE_DISPLAY_SWEEP_LIMIT = 500;
const MAX_PRIVATE_DISPLAY_SWEEP_LIMIT = 1_000;

/**
 * Deletes expired, display-only approval material without ever selecting the
 * private value. This is deliberately global: the minute scheduler invokes it
 * even when no tenant has chat or operator activity.
 */
export async function sweepExpiredOperatorPrivateDisplays(
  requestedLimit = DEFAULT_PRIVATE_DISPLAY_SWEEP_LIMIT,
): Promise<number> {
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), MAX_PRIVATE_DISPLAY_SWEEP_LIMIT)
    : DEFAULT_PRIVATE_DISPLAY_SWEEP_LIMIT;

  const rows = await q<{ id: string }>(
    `WITH expired AS (
       SELECT id FROM operator_action_approvals
       WHERE expires_at <= clock_timestamp() AND private_display IS NOT NULL
       ORDER BY expires_at, id
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE operator_action_approvals oa
     SET private_display = NULL
     FROM expired
     WHERE oa.id = expired.id
     RETURNING oa.id`,
    [limit],
  );
  return rows.length;
}
