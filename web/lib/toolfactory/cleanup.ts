// Crash-safe cleanup worker for revision-isolated generated-tool projects.

import { q } from "../db";
import { cleanupToolProject } from "./deploy";

const MAX_CLEANUP_BATCH = 25;
const MAX_CLEANUP_ATTEMPTS = 8;

type CleanupJob = Readonly<{
  key_id: string;
  org_id: string;
  deployment_project: string;
  claim_token: string;
  attempts: number;
}>;

export type GeneratedToolCleanupDependencies = Readonly<{
  query: <T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[]
  ) => Promise<T[]>;
  cleanupProject: (project: string) => Promise<void>;
}>;

const defaultDependencies: GeneratedToolCleanupDependencies = {
  query: q as GeneratedToolCleanupDependencies["query"],
  cleanupProject: cleanupToolProject,
};

export type GeneratedToolCleanupSweep = Readonly<{
  claimed: number;
  cleaned: number;
  cleanupRequired: number;
}>;

/**
 * Claims due jobs with SKIP LOCKED, including abandoned leases. Provider deletion is idempotent:
 * a lost success is retried and its 404 is committed as cleaned. Only bounded error codes persist.
 */
export async function sweepGeneratedToolCleanup(
  limit = 5,
  dependencies: GeneratedToolCleanupDependencies = defaultDependencies
): Promise<GeneratedToolCleanupSweep> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CLEANUP_BATCH) {
    throw new Error(`generated tool cleanup limit must be between 1 and ${MAX_CLEANUP_BATCH}`);
  }
  const jobs = await dependencies.query<CleanupJob>(
    `WITH terminalized AS (
       UPDATE hacc_private.generated_tool_cleanup_jobs AS exhausted
       SET status = 'cleanup_required',
           claim_token = NULL,
           claimed_at = NULL,
           claim_expires_at = NULL,
           last_error_code = 'provider_cleanup_failed',
           next_attempt_at = now(),
           updated_at = now()
       WHERE exhausted.status = 'cleaning'
         AND exhausted.attempts >= $2
         AND exhausted.claim_expires_at <= now()
       RETURNING exhausted.key_id
     ), due AS MATERIALIZED (
       SELECT cleanup.key_id
       FROM hacc_private.generated_tool_cleanup_jobs AS cleanup
       WHERE cleanup.attempts < $2
         AND (
           (cleanup.status = 'cleanup_required' AND cleanup.next_attempt_at <= now())
           OR
           (cleanup.status = 'cleaning' AND cleanup.claim_expires_at <= now())
         )
       ORDER BY cleanup.next_attempt_at, cleanup.created_at
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE hacc_private.generated_tool_cleanup_jobs AS cleanup
     SET status = 'cleaning',
         attempts = cleanup.attempts + 1,
         claim_token = gen_random_uuid(),
         claimed_at = now(),
         claim_expires_at = now() + interval '5 minutes',
         updated_at = now()
     FROM due
     WHERE cleanup.key_id = due.key_id
     RETURNING cleanup.key_id, cleanup.org_id, cleanup.deployment_project,
               cleanup.claim_token, cleanup.attempts`,
    [limit, MAX_CLEANUP_ATTEMPTS]
  );

  let cleaned = 0;
  let cleanupRequired = 0;
  for (const job of jobs) {
    try {
      await dependencies.cleanupProject(job.deployment_project);
      const settled = await dependencies.query<{ key_id: string }>(
        `UPDATE hacc_private.generated_tool_cleanup_jobs
         SET status = 'cleaned',
             claim_token = NULL,
             claimed_at = NULL,
             claim_expires_at = NULL,
             last_error_code = NULL,
             cleaned_at = now(),
             updated_at = now()
         WHERE key_id = $1 AND org_id = $2
           AND status = 'cleaning' AND claim_token = $3
         RETURNING key_id`,
        [job.key_id, job.org_id, job.claim_token]
      );
      if (settled.length === 1) cleaned += 1;
      else cleanupRequired += 1; // A lost lease is never reported as successful authority.
    } catch {
      const retried = await dependencies.query<{ key_id: string }>(
        `UPDATE hacc_private.generated_tool_cleanup_jobs
         SET status = 'cleanup_required',
             claim_token = NULL,
             claimed_at = NULL,
             claim_expires_at = NULL,
             last_error_code = 'provider_cleanup_failed',
             next_attempt_at = now() + LEAST(
               interval '1 hour',
               interval '30 seconds' * power(2, LEAST(attempts, 7))
             ),
             updated_at = now()
         WHERE key_id = $1 AND org_id = $2
           AND status = 'cleaning' AND claim_token = $3
         RETURNING key_id`,
        [job.key_id, job.org_id, job.claim_token]
      );
      if (retried.length === 1) cleanupRequired += 1;
    }
  }
  return Object.freeze({ claimed: jobs.length, cleaned, cleanupRequired });
}

export const GENERATED_TOOL_CLEANUP_MAX_ATTEMPTS = MAX_CLEANUP_ATTEMPTS;
