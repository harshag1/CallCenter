-- Every future-call runtime extension catalog is admitted for the exact calls.id that can execute it.

-- Pre-020 rows were authorized before a call id was part of the immutable authority manifest.
-- They cannot be safely upgraded by assertion: their extension admission digest may be bound to
-- a proposal or campaign identity instead. Quarantine them before replacing the executable check.
UPDATE scheduled_calls
SET status = CASE
      WHEN dispatch_started_at IS NULL THEN 'canceled'
      ELSE 'indeterminate'
    END,
    claim_token = NULL,
    claim_lease_expires_at = NULL
WHERE status IN ('pending', 'dialing')
  AND authority_manifest IS NOT NULL
  AND authority_manifest->>'callId' IS DISTINCT FROM id::text;

ALTER TABLE scheduled_calls
  DROP CONSTRAINT IF EXISTS scheduled_calls_executable_authority_valid;

ALTER TABLE scheduled_calls
  ADD CONSTRAINT scheduled_calls_executable_authority_valid CHECK (
    status NOT IN ('pending', 'dialing')
    OR (
      operator_execution_id IS NOT NULL
      AND operator_arguments_sha256 IS NOT NULL
      AND runtime_snapshot IS NOT NULL
      AND jsonb_typeof(runtime_snapshot) = 'object'
      AND runtime_digest IS NOT NULL
      AND agent_version IS NOT NULL
      AND agent_version > 0
      AND authority_manifest IS NOT NULL
      AND authority_manifest = jsonb_build_object(
        'v', 1,
        'capability', authority_manifest->'capability',
        'callId', id::text,
        'orgId', org_id::text,
        'operatorExecutionId', operator_execution_id::text,
        'operatorArgumentsSha256', operator_arguments_sha256,
        'runtimeDigest', runtime_digest,
        'targetSetSha256', CASE
          WHEN target_set_sha256 IS NULL THEN 'null'::jsonb
          ELSE to_jsonb(target_set_sha256)
        END,
        'agentVersion', agent_version,
        'flowId', CASE
          WHEN flow_id IS NULL THEN 'null'::jsonb
          ELSE to_jsonb(flow_id::text)
        END,
        'campaignId', CASE
          WHEN campaign_id IS NULL THEN 'null'::jsonb
          ELSE to_jsonb(campaign_id::text)
        END
      )
      AND jsonb_typeof(authority_manifest->'capability') = 'string'
      AND length(authority_manifest->>'capability') BETWEEN 1 AND 64
    )
  ) NOT VALID;

ALTER TABLE scheduled_calls
  VALIDATE CONSTRAINT scheduled_calls_executable_authority_valid;

COMMENT ON COLUMN scheduled_calls.authority_manifest IS
  'Canonical non-secret authorization bound to this scheduled_calls.id/eventual calls.id; never a bearer credential.';
