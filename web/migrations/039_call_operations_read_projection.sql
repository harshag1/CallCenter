-- Authenticated call management reads need a bounded, content-minimized
-- redaction input across several ledgers. Keep the tenant predicate inside
-- this SECURITY DEFINER boundary. This projection adds no direct table grants
-- and returns no transcript, arguments, results, checkpoints, or payloads.

DO $call_operations_projection_indexes$
DECLARE
  index_definition text;
  index_ready boolean;
BEGIN
  IF to_regclass('public.idx_voice_worker_jobs_org_source_call_created') IS NULL THEN
    CREATE INDEX idx_voice_worker_jobs_org_source_call_created
      ON public.voice_worker_jobs(
        org_id,
        source_call_id,
        created_at DESC,
        id
      )
      WHERE source_call_id IS NOT NULL;
  ELSE
    SELECT
      pg_get_indexdef(relation.oid),
      COALESCE(
        index_catalog.indisvalid
        AND index_catalog.indisready
        AND index_catalog.indrelid = 'public.voice_worker_jobs'::regclass,
        false
      )
    INTO index_definition, index_ready
    FROM pg_class relation
    LEFT JOIN pg_index index_catalog
      ON index_catalog.indexrelid = relation.oid
    WHERE relation.oid =
      'public.idx_voice_worker_jobs_org_source_call_created'::regclass;
    IF index_definition IS NULL
       OR index_ready IS DISTINCT FROM true
       OR index_definition NOT IN (
      'CREATE INDEX idx_voice_worker_jobs_org_source_call_created ON public.voice_worker_jobs USING btree (org_id, source_call_id, created_at DESC, id) WHERE (source_call_id IS NOT NULL)',
      'CREATE INDEX idx_voice_worker_jobs_org_source_call_created ON public.voice_worker_jobs USING btree (org_id, source_call_id, created_at DESC, id) WHERE source_call_id IS NOT NULL'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'call_operations_source_call_index_definition_mismatch';
    END IF;
  END IF;

  IF to_regclass(
    'public.idx_voice_worker_jobs_org_conversation_created'
  ) IS NULL THEN
    CREATE INDEX idx_voice_worker_jobs_org_conversation_created
      ON public.voice_worker_jobs(
        org_id,
        conversation_id,
        created_at DESC,
        id
      );
  ELSE
    SELECT
      pg_get_indexdef(relation.oid),
      COALESCE(
        index_catalog.indisvalid
        AND index_catalog.indisready
        AND index_catalog.indrelid = 'public.voice_worker_jobs'::regclass,
        false
      )
    INTO index_definition, index_ready
    FROM pg_class relation
    LEFT JOIN pg_index index_catalog
      ON index_catalog.indexrelid = relation.oid
    WHERE relation.oid =
      'public.idx_voice_worker_jobs_org_conversation_created'::regclass;
    IF index_definition IS NULL
       OR index_ready IS DISTINCT FROM true
       OR index_definition NOT IN (
      'CREATE INDEX idx_voice_worker_jobs_org_conversation_created ON public.voice_worker_jobs USING btree (org_id, conversation_id, created_at DESC, id)'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'call_operations_conversation_index_definition_mismatch';
    END IF;
  END IF;

  IF to_regclass('public.idx_voice_worker_events_recovery') IS NULL THEN
    CREATE INDEX idx_voice_worker_events_recovery
      ON public.voice_worker_events(
        conversation_id,
        worker_id,
        created_at DESC,
        id
      )
      INCLUDE (event_type)
      WHERE event_type IN ('checkpointed', 'reclaimed', 'indeterminate');
  ELSE
    SELECT
      pg_get_indexdef(relation.oid),
      COALESCE(
        index_catalog.indisvalid
        AND index_catalog.indisready
        AND index_catalog.indrelid = 'public.voice_worker_events'::regclass,
        false
      )
    INTO index_definition, index_ready
    FROM pg_class relation
    LEFT JOIN pg_index index_catalog
      ON index_catalog.indexrelid = relation.oid
    WHERE relation.oid =
      'public.idx_voice_worker_events_recovery'::regclass;
    IF index_definition IS NULL
       OR index_ready IS DISTINCT FROM true
       OR index_definition NOT IN (
      'CREATE INDEX idx_voice_worker_events_recovery ON public.voice_worker_events USING btree (conversation_id, worker_id, created_at DESC, id) INCLUDE (event_type) WHERE (event_type = ANY (ARRAY[''checkpointed''::text, ''reclaimed''::text, ''indeterminate''::text]))',
      'CREATE INDEX idx_voice_worker_events_recovery ON public.voice_worker_events USING btree (conversation_id, worker_id, created_at DESC, id) INCLUDE (event_type) WHERE (event_type IN (''checkpointed'', ''reclaimed'', ''indeterminate''))'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'call_operations_recovery_index_definition_mismatch';
    END IF;
  END IF;

  IF to_regclass('public.idx_voice_conversation_inbox_delivered_worker') IS NULL THEN
    CREATE INDEX idx_voice_conversation_inbox_delivered_worker
      ON public.voice_conversation_inbox(conversation_id, worker_id)
      WHERE applied_at IS NOT NULL AND acknowledged_at IS NOT NULL;
  ELSE
    SELECT
      pg_get_indexdef(relation.oid),
      COALESCE(
        index_catalog.indisvalid
        AND index_catalog.indisready
        AND index_catalog.indrelid =
          'public.voice_conversation_inbox'::regclass,
        false
      )
    INTO index_definition, index_ready
    FROM pg_class relation
    LEFT JOIN pg_index index_catalog
      ON index_catalog.indexrelid = relation.oid
    WHERE relation.oid =
      'public.idx_voice_conversation_inbox_delivered_worker'::regclass;
    IF index_definition IS NULL
       OR index_ready IS DISTINCT FROM true
       OR index_definition NOT IN (
      'CREATE INDEX idx_voice_conversation_inbox_delivered_worker ON public.voice_conversation_inbox USING btree (conversation_id, worker_id) WHERE ((applied_at IS NOT NULL) AND (acknowledged_at IS NOT NULL))',
      'CREATE INDEX idx_voice_conversation_inbox_delivered_worker ON public.voice_conversation_inbox USING btree (conversation_id, worker_id) WHERE (applied_at IS NOT NULL AND acknowledged_at IS NOT NULL)',
      'CREATE INDEX idx_voice_conversation_inbox_delivered_worker ON public.voice_conversation_inbox USING btree (conversation_id, worker_id) WHERE applied_at IS NOT NULL AND acknowledged_at IS NOT NULL'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'call_operations_delivery_index_definition_mismatch';
    END IF;
  END IF;
END
$call_operations_projection_indexes$;

CREATE OR REPLACE FUNCTION public.read_call_operations_snapshot(
  call_identity uuid,
  organization_identity uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET enable_seqscan = off
SET enable_bitmapscan = off
SET enable_indexscan = on
SET enable_indexonlyscan = on
SET enable_nestloop = on
SET max_parallel_workers_per_gather = 0
SET plan_cache_mode = force_custom_plan
AS $read_call_operations_snapshot$
DECLARE
  captured_at timestamptz := statement_timestamp();
  operational_time_floor constant timestamptz :=
    timestamptz '1970-01-01 00:00:00+00';
  operational_time_ceiling constant timestamptz :=
    timestamptz '10000-01-01 00:00:00+00';
  call_status text;
  conversation_identity uuid;
  conversation_head_sequence bigint;
  conversation_head_sha256 text;
  conversation_updated_at timestamptz;
  conversation_authority jsonb;
  action_receipt_count integer;
  action_summary jsonb;
  flow_projection jsonb;
  flow_updated_at timestamptz;
  worker_projection jsonb;
  worker_identity_array uuid[];
  worker_identity_count integer;
  worker_summary jsonb;
  worker_updated_at timestamptz;
  policy_projection jsonb;
  policy_observation_count integer;
  policy_summary jsonb;
  policy_updated_at timestamptz;
  recovery_projection jsonb;
  recovery_observation_count integer;
  recovery_summary jsonb;
BEGIN
  SELECT CASE call.status
    WHEN 'active' THEN 'active'
    WHEN 'dialing' THEN 'dialing'
    WHEN 'completed' THEN 'completed'
    WHEN 'failed' THEN 'failed'
    ELSE 'redacted_unknown'
  END
  INTO call_status
  FROM public.calls call
  JOIN public.agents agent
    ON agent.id = call.agent_id
  WHERE call.id = call_identity
    AND agent.org_id = organization_identity;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT
    binding.conversation_id,
    conversation.event_head_sequence,
    conversation.event_head_sha256,
    conversation.updated_at
  INTO
    conversation_identity,
    conversation_head_sequence,
    conversation_head_sha256,
    conversation_updated_at
  FROM public.voice_conversation_calls binding
  JOIN public.voice_conversations conversation
    ON conversation.id = binding.conversation_id
   AND conversation.org_id = binding.org_id
  WHERE binding.call_id = call_identity
    AND binding.org_id = organization_identity;

  IF conversation_identity IS NOT NULL
     AND conversation_head_sequence BETWEEN 0 AND 9007199254740991 THEN
    conversation_authority := jsonb_build_object(
      'kind', 'materialized_head',
      'revision', conversation_head_sequence,
      'headSha256', conversation_head_sha256,
      'snapshotCapturedAtMs',
        floor(extract(epoch FROM captured_at) * 1000)::bigint,
      'eventRowsRead', 0
    );
  END IF;

  SELECT count(*)::integer
  INTO action_receipt_count
  FROM (
    SELECT 1
    FROM public.flow_action_receipts receipt
    WHERE receipt.call_id = call_identity
    LIMIT 10001
  ) bounded_action_receipts;

  IF action_receipt_count > 10000 THEN
    RAISE EXCEPTION USING
      ERRCODE = '54000',
      MESSAGE = 'call_operations_action_receipt_limit_exceeded';
  END IF;

  SELECT jsonb_build_object(
    'total', count(*)::integer,
    'byStatus', COALESCE((
      SELECT jsonb_object_agg(counts.status, counts.item_count ORDER BY counts.status)
      FROM (
        SELECT normalized.status, count(*)::integer AS item_count
        FROM (
          SELECT CASE
            WHEN receipt.status IN (
              'reserved',
              'succeeded',
              'failed',
              'indeterminate'
            ) THEN receipt.status
            ELSE 'redacted_unknown'
          END AS status
          FROM public.flow_action_receipts receipt
          WHERE receipt.call_id = call_identity
        ) normalized
        GROUP BY normalized.status
      ) counts
    ), '{}'::jsonb),
    'maxCapabilityEpoch', max(receipt.capability_epoch)
  )
  INTO action_summary
  FROM public.flow_action_receipts receipt
  WHERE receipt.call_id = call_identity;

  SELECT
    jsonb_build_object(
      'capabilityEpoch', CASE
        WHEN jsonb_typeof(run.state->'capabilityEpoch') = 'number'
          THEN CASE
            WHEN run.state->>'capabilityEpoch'
                ~ '^(0|[1-9][0-9]{0,9})$'
              THEN CASE
                WHEN (run.state->>'capabilityEpoch')::numeric <= 2147483647
                  THEN (run.state->>'capabilityEpoch')::integer
                ELSE NULL
              END
            ELSE NULL
          END
        ELSE NULL
      END,
      'revision', run.revision,
      'actionReceipts', COALESCE((
        SELECT jsonb_agg(
          projected.item
          ORDER BY projected.reserved_at DESC, projected.id
        )
        FROM (
          SELECT
            receipt.id,
            receipt.reserved_at,
            jsonb_strip_nulls(jsonb_build_object(
            'id', receipt.id,
            'tool', CASE
              WHEN octet_length(receipt.tool) BETWEEN 1 AND 256
                THEN receipt.tool
              ELSE 'redacted_tool'
            END,
            'capabilityEpoch', receipt.capability_epoch,
            'dispatchAttempt', receipt.dispatch_attempt,
            'status', CASE
              WHEN receipt.status IN (
                'reserved',
                'succeeded',
                'failed',
                'indeterminate'
              ) THEN receipt.status
              ELSE 'redacted_unknown'
            END,
            'dispatchStartedAt', CASE
              WHEN receipt.dispatch_started_at >= operational_time_floor
                AND receipt.dispatch_started_at < operational_time_ceiling
                THEN receipt.dispatch_started_at
              ELSE NULL
            END,
            'reservedAt', receipt.reserved_at,
            'settledAt', CASE
              WHEN receipt.settled_at >= operational_time_floor
                AND receipt.settled_at < operational_time_ceiling
                THEN receipt.settled_at
              ELSE NULL
            END,
            'reconciliationProofId', receipt.reconciliation_proof_id,
            'error', CASE
              WHEN receipt.error IS NULL THEN NULL
              WHEN jsonb_typeof(receipt.error) = 'object'
                AND receipt.error->>'code' ~ '^[a-z][a-z0-9_]{0,127}$'
                THEN receipt.error->>'code'
              ELSE 'redacted_error'
            END
            )) AS item
          FROM public.flow_action_receipts receipt
          WHERE receipt.call_id = call_identity
            AND receipt.reserved_at >= operational_time_floor
            AND receipt.reserved_at < operational_time_ceiling
          ORDER BY receipt.reserved_at DESC, receipt.id
          LIMIT 256
        ) projected
      ), '[]'::jsonb)
    ),
    GREATEST(
      CASE
        WHEN run.updated_at >= operational_time_floor
          AND run.updated_at < operational_time_ceiling
          THEN run.updated_at
        ELSE NULL
      END,
      (
        SELECT max(
          CASE
            WHEN COALESCE(
              receipt.settled_at,
              receipt.dispatch_started_at,
              receipt.reserved_at
            ) >= operational_time_floor
              AND COALESCE(
                receipt.settled_at,
                receipt.dispatch_started_at,
                receipt.reserved_at
              ) < operational_time_ceiling
              THEN COALESCE(
              receipt.settled_at,
              receipt.dispatch_started_at,
              receipt.reserved_at
            )
            ELSE NULL
          END
        )
        FROM public.flow_action_receipts receipt
        WHERE receipt.call_id = call_identity
      ),
      (
        SELECT max(
          CASE
            WHEN proof.completed_at >= operational_time_floor
              AND proof.completed_at < operational_time_ceiling
              THEN proof.completed_at
          ELSE NULL END
        )
        FROM public.flow_action_reconciliation_proofs proof
        JOIN public.flow_action_receipts receipt
          ON receipt.id = proof.action_receipt_id
         AND receipt.call_id = proof.call_id
        WHERE receipt.call_id = call_identity
          AND receipt.reconciliation_proof_id = proof.id
      )
    )
  INTO flow_projection, flow_updated_at
  FROM public.flow_runs run
  WHERE run.call_id = call_identity
    AND run.revision >= 0;

  -- Probe the population without sorting so a hostile cardinality cannot make
  -- PostgreSQL sort more than the one sentinel row beyond the hard ceiling.
  -- This STABLE function sees one statement snapshot, so the ordered identity
  -- read below observes exactly the population that passed this cap.
  IF conversation_identity IS NOT NULL THEN
    SELECT count(*)::integer
    INTO worker_identity_count
    FROM (
      SELECT 1
      FROM public.voice_worker_jobs job
      WHERE job.org_id = organization_identity
        AND job.conversation_id = conversation_identity
      LIMIT 10001
    ) bounded_workers;
  ELSE
    SELECT count(*)::integer
    INTO worker_identity_count
    FROM (
      SELECT 1
      FROM public.voice_worker_jobs job
      WHERE job.org_id = organization_identity
        AND job.source_call_id = call_identity
      LIMIT 10001
    ) bounded_workers;
  END IF;

  IF worker_identity_count > 10000 THEN
    RAISE EXCEPTION USING
      ERRCODE = '54000',
      MESSAGE = 'call_operations_worker_identity_limit_exceeded';
  END IF;

  -- Materialize a private, bounded identity scope so the detail window and
  -- complete summaries are derived from the same worker population. The IDs
  -- never leave this function.
  IF conversation_identity IS NOT NULL THEN
    SELECT COALESCE(
      array_agg(indexed.id ORDER BY indexed.created_at DESC, indexed.id),
      '{}'::uuid[]
    )
    INTO worker_identity_array
    FROM (
      SELECT job.id, job.created_at
      FROM public.voice_worker_jobs job
      WHERE job.org_id = organization_identity
        AND job.conversation_id = conversation_identity
      ORDER BY job.created_at DESC, job.id
      LIMIT 10000
    ) indexed;
  ELSE
    SELECT COALESCE(
      array_agg(indexed.id ORDER BY indexed.created_at DESC, indexed.id),
      '{}'::uuid[]
    )
    INTO worker_identity_array
    FROM (
      SELECT job.id, job.created_at
      FROM public.voice_worker_jobs job
      WHERE job.org_id = organization_identity
        AND job.source_call_id = call_identity
      ORDER BY job.created_at DESC, job.id
      LIMIT 10000
    ) indexed;
  END IF;

  SELECT COALESCE(jsonb_agg(projected.item ORDER BY projected.created_at DESC, projected.id), '[]'::jsonb)
  INTO worker_projection
  FROM (
    SELECT
      job.id,
      job.created_at,
      jsonb_build_object(
        'id', job.id,
        'parentWorkerId', job.parent_worker_id,
        'status', CASE
          WHEN job.status IN (
            'pending',
            'running',
            'cancel_requested',
            'succeeded',
            'failed',
            'cancelled',
            'indeterminate'
          ) THEN job.status
          ELSE 'redacted_unknown'
        END,
        'authority', jsonb_build_object(
          'policyEpoch', CASE
            WHEN jsonb_typeof(job.spawn_authority->'policyEpoch') = 'number'
              THEN CASE
                WHEN job.spawn_authority->>'policyEpoch'
                    ~ '^(0|[1-9][0-9]{0,9})$'
                  THEN CASE
                    WHEN (job.spawn_authority->>'policyEpoch')::numeric
                        <= 2147483647
                      THEN (job.spawn_authority->>'policyEpoch')::integer
                    ELSE NULL
                  END
                ELSE NULL
              END
            ELSE NULL
          END
        ),
        'deliveryState', CASE
          WHEN job.status = 'succeeded'
            AND EXISTS (
              SELECT 1
              FROM public.voice_conversation_inbox inbox
              WHERE inbox.worker_id = job.id
                AND inbox.conversation_id = job.conversation_id
                AND inbox.applied_at IS NOT NULL
                AND inbox.acknowledged_at IS NOT NULL
            ) THEN 'delivered'
          WHEN job.status = 'succeeded' THEN 'awaiting_delivery'
          WHEN job.status IN ('failed', 'cancelled', 'indeterminate')
            THEN 'terminal'
          ELSE 'not_settled'
        END,
        'leaseExpiresAt', CASE
          WHEN job.lease_expires_at >= operational_time_floor
            AND job.lease_expires_at < operational_time_ceiling
            THEN job.lease_expires_at
          ELSE NULL
        END,
        'cancellationEpoch', job.cancellation_epoch,
        'checkpointPresent', job.checkpoint IS NOT NULL,
        'resultPresent', job.result IS NOT NULL,
        'errorPresent', job.error IS NOT NULL,
        'settledAt', CASE
          WHEN job.settled_at >= operational_time_floor
            AND job.settled_at < operational_time_ceiling
            THEN job.settled_at
          ELSE NULL
        END
      ) AS item
    FROM public.voice_worker_jobs job
    WHERE job.org_id = organization_identity
      AND job.id = ANY(worker_identity_array)
    ORDER BY job.created_at DESC, job.id
    LIMIT 256
  ) projected;

  SELECT
    jsonb_build_object(
      'total', count(*)::integer,
      'byStatus', COALESCE((
        SELECT jsonb_object_agg(counts.status, counts.item_count ORDER BY counts.status)
        FROM (
          SELECT scoped.status, count(*)::integer AS item_count
          FROM (
            SELECT CASE
              WHEN job.status IN (
                'pending',
                'running',
                'cancel_requested',
                'succeeded',
                'failed',
                'cancelled',
                'indeterminate'
              ) THEN job.status
              ELSE 'redacted_unknown'
            END AS status
            FROM public.voice_worker_jobs job
            WHERE job.org_id = organization_identity
              AND job.id = ANY(worker_identity_array)
          ) scoped
          GROUP BY scoped.status
        ) counts
      ), '{}'::jsonb),
      'byDeliveryState', COALESCE((
        SELECT jsonb_object_agg(
          counts.delivery_state,
          counts.item_count
          ORDER BY counts.delivery_state
        )
        FROM (
          SELECT scoped.delivery_state, count(*)::integer AS item_count
          FROM (
            SELECT CASE
              WHEN job.status = 'succeeded'
                AND EXISTS (
                  SELECT 1
                  FROM public.voice_conversation_inbox inbox
                  WHERE inbox.worker_id = job.id
                    AND inbox.conversation_id = job.conversation_id
                    AND inbox.applied_at IS NOT NULL
                    AND inbox.acknowledged_at IS NOT NULL
                ) THEN 'delivered'
              WHEN job.status = 'succeeded' THEN 'awaiting_delivery'
              WHEN job.status IN ('failed', 'cancelled', 'indeterminate')
                THEN 'terminal'
              ELSE 'not_settled'
            END AS delivery_state
            FROM public.voice_worker_jobs job
            WHERE job.org_id = organization_identity
              AND job.id = ANY(worker_identity_array)
          ) scoped
          GROUP BY scoped.delivery_state
        ) counts
      ), '{}'::jsonb)
    ),
    GREATEST(
      max(GREATEST(
        CASE
          WHEN job.created_at >= operational_time_floor
            AND job.created_at < operational_time_ceiling
            THEN job.created_at
          ELSE NULL
        END,
        CASE
          WHEN job.claimed_at >= operational_time_floor
            AND job.claimed_at < operational_time_ceiling
            THEN job.claimed_at
          ELSE NULL
        END,
        CASE
          WHEN job.heartbeat_at >= operational_time_floor
            AND job.heartbeat_at < operational_time_ceiling
            THEN job.heartbeat_at
          ELSE NULL
        END,
        CASE
          WHEN job.dispatch_started_at >= operational_time_floor
            AND job.dispatch_started_at < operational_time_ceiling
            THEN job.dispatch_started_at
          ELSE NULL
        END,
        CASE
          WHEN job.settled_at >= operational_time_floor
            AND job.settled_at < operational_time_ceiling
            THEN job.settled_at
          ELSE NULL
        END
      )),
      (
        SELECT max(latest_event.created_at)
        FROM unnest(worker_identity_array) scoped_worker(worker_id)
        JOIN public.voice_worker_jobs event_job
          ON event_job.id = scoped_worker.worker_id
         AND event_job.org_id = organization_identity
        CROSS JOIN LATERAL (
          SELECT CASE
            WHEN event.created_at >= operational_time_floor
              AND event.created_at < operational_time_ceiling
              THEN event.created_at
            ELSE NULL
          END AS created_at
          FROM public.voice_worker_events event
          WHERE event.worker_id = event_job.id
            AND event.conversation_id = event_job.conversation_id
          ORDER BY event.sequence DESC
          LIMIT 1
        ) latest_event
      )
    )
  INTO worker_summary, worker_updated_at
  FROM public.voice_worker_jobs job
  WHERE job.org_id = organization_identity
    AND job.id = ANY(worker_identity_array);

  SELECT count(*)::integer
  INTO policy_observation_count
  FROM (
    SELECT 1
    FROM public.flow_action_policy_decisions decision
    WHERE decision.call_id = call_identity
    LIMIT 10001
  ) bounded_policy_observations;

  IF policy_observation_count > 10000 THEN
    RAISE EXCEPTION USING
      ERRCODE = '54000',
      MESSAGE = 'call_operations_policy_observation_limit_exceeded';
  END IF;

  SELECT COALESCE(jsonb_agg(projected.item ORDER BY projected.created_at DESC, projected.id), '[]'::jsonb)
  INTO policy_projection
  FROM (
    SELECT
      decision.id,
      decision.created_at,
      jsonb_build_object(
        'stage', 'pre_dispatch',
        'observedAtMs', floor(extract(epoch FROM decision.evaluated_at) * 1000)::bigint,
        'decision', jsonb_build_object(
          'decision', decision.decision,
          'reason', decision.reason,
          'action', decision.action
        )
    ) AS item
    FROM public.flow_action_policy_decisions decision
    WHERE decision.call_id = call_identity
      AND decision.decision <> 'allow'
      AND decision.evaluated_at >= operational_time_floor
      AND decision.evaluated_at < operational_time_ceiling
    ORDER BY decision.created_at DESC, decision.id
    LIMIT 256
  ) projected;

  SELECT
    jsonb_build_object(
      'observations', count(*)::integer,
      'denials', count(*) FILTER (WHERE decision.decision <> 'allow')::integer,
      'byDecision', COALESCE((
        SELECT jsonb_object_agg(counts.decision, counts.item_count ORDER BY counts.decision)
        FROM (
          SELECT scoped.decision, count(*)::integer AS item_count
          FROM public.flow_action_policy_decisions scoped
          WHERE scoped.call_id = call_identity
          GROUP BY scoped.decision
        ) counts
      ), '{}'::jsonb)
    ),
    max(
      CASE
        WHEN decision.created_at >= operational_time_floor
          AND decision.created_at < operational_time_ceiling
          THEN decision.created_at
      ELSE NULL END
    )
  INTO policy_summary, policy_updated_at
  FROM public.flow_action_policy_decisions decision
  WHERE decision.call_id = call_identity;

  SELECT count(*)::integer
  INTO recovery_observation_count
  FROM (
    SELECT 1
    FROM public.flow_action_receipts receipt
    JOIN public.flow_action_reconciliation_proofs proof
      ON proof.id = receipt.reconciliation_proof_id
     AND proof.call_id = receipt.call_id
    WHERE receipt.call_id = call_identity
      AND proof.completed_at IS NOT NULL
    UNION ALL
    SELECT 1
    FROM unnest(worker_identity_array) scoped_worker(worker_id)
    JOIN public.voice_worker_jobs scoped_job
      ON scoped_job.id = scoped_worker.worker_id
     AND scoped_job.org_id = organization_identity
    CROSS JOIN LATERAL (
      SELECT event.id
      FROM public.voice_worker_events event
      WHERE event.conversation_id = scoped_job.conversation_id
        AND event.worker_id = scoped_worker.worker_id
        AND event.event_type IN (
          'checkpointed',
          'reclaimed',
          'indeterminate'
        )
      LIMIT 10001
    ) recovery_event
    LIMIT 10001
  ) bounded_recovery_observations;

  IF recovery_observation_count > 10000 THEN
    RAISE EXCEPTION USING
      ERRCODE = '54000',
      MESSAGE = 'call_operations_recovery_observation_limit_exceeded';
  END IF;

  WITH recovery AS MATERIALIZED (
    SELECT
      'action_reconciled'::text AS kind,
      receipt.id::text AS subject_id,
      CASE
        WHEN proof.completed_at >= operational_time_floor
          AND proof.completed_at < operational_time_ceiling
          THEN proof.completed_at
      ELSE NULL END AS observed_at,
      0 AS source_order,
      receipt.id::text AS source_identity
    FROM public.flow_action_receipts receipt
    JOIN public.flow_action_reconciliation_proofs proof
      ON proof.id = receipt.reconciliation_proof_id
     AND proof.call_id = receipt.call_id
    WHERE receipt.call_id = call_identity
      AND proof.completed_at >= operational_time_floor
      AND proof.completed_at < operational_time_ceiling
    UNION ALL
    SELECT
      CASE event.event_type
        WHEN 'checkpointed' THEN 'worker_checkpointed'
        WHEN 'reclaimed' THEN 'worker_reclaimed'
        WHEN 'indeterminate' THEN 'worker_indeterminate'
      END AS kind,
      event.worker_id::text AS subject_id,
      CASE
        WHEN event.created_at >= operational_time_floor
          AND event.created_at < operational_time_ceiling
          THEN event.created_at
      ELSE NULL END AS observed_at,
      1 AS source_order,
      event.id::text AS source_identity
    FROM unnest(worker_identity_array) scoped_worker(worker_id)
    JOIN public.voice_worker_jobs scoped_job
      ON scoped_job.id = scoped_worker.worker_id
     AND scoped_job.org_id = organization_identity
    CROSS JOIN LATERAL (
      SELECT
        event.id,
        event.event_type,
        event.worker_id,
        event.created_at
      FROM public.voice_worker_events event
      WHERE event.conversation_id = scoped_job.conversation_id
        AND event.worker_id = scoped_worker.worker_id
        AND event.event_type IN (
          'checkpointed',
          'reclaimed',
          'indeterminate'
        )
        AND event.created_at >= operational_time_floor
        AND event.created_at < operational_time_ceiling
      ORDER BY event.created_at DESC, event.id
      LIMIT 10001
    ) event
  ),
  recent AS (
    SELECT *
    FROM recovery
    WHERE observed_at IS NOT NULL
    ORDER BY
      observed_at DESC,
      source_order,
      source_identity,
      kind,
      subject_id
    LIMIT 256
  )
  SELECT
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'kind', recent.kind,
        'subjectId', recent.subject_id,
        'observedAtMs', floor(extract(epoch FROM recent.observed_at) * 1000)::bigint
      ) ORDER BY
        recent.observed_at DESC,
        recent.source_order,
        recent.source_identity,
        recent.kind,
        recent.subject_id)
      FROM recent
    ), '[]'::jsonb),
    jsonb_build_object(
      'observations', (SELECT count(*)::integer FROM recovery),
      'byKind', COALESCE((
        SELECT jsonb_object_agg(counts.kind, counts.item_count ORDER BY counts.kind)
        FROM (
          SELECT recovery.kind, count(*)::integer AS item_count
          FROM recovery
          GROUP BY recovery.kind
        ) counts
      ), '{}'::jsonb),
      'lastObservedAtMs', (
        SELECT floor(extract(epoch FROM max(recovery.observed_at)) * 1000)::bigint
        FROM recovery
      )
    )
  INTO recovery_projection, recovery_summary;

  RETURN jsonb_build_object(
    'schemaVersion', 2,
    'callId', call_identity,
    'organizationId', organization_identity,
    'capturedAtMs', floor(extract(epoch FROM captured_at) * 1000)::bigint,
    'callStatus', call_status,
    'conversationAuthority', conversation_authority,
    'flowState', flow_projection,
    'actionSummary', action_summary,
    'durableWorkers', worker_projection,
    'durableWorkerSummary', worker_summary,
    'policyDecisions', policy_projection,
    'policySummary', policy_summary,
    'sourceObservations', jsonb_build_array(
      jsonb_build_object(
        'source', 'flow',
        'observedAtMs', CASE
          WHEN flow_updated_at >= operational_time_floor
            AND flow_updated_at < operational_time_ceiling
            THEN floor(extract(epoch FROM flow_updated_at) * 1000)::bigint
          ELSE NULL
        END
      ),
      jsonb_build_object(
        'source', 'conversation',
        'observedAtMs', CASE
          WHEN conversation_updated_at >= operational_time_floor
            AND conversation_updated_at < operational_time_ceiling
            THEN floor(extract(epoch FROM conversation_updated_at) * 1000)::bigint
          ELSE NULL
        END
      ),
      jsonb_build_object(
        'source', 'workers',
        'observedAtMs', CASE
          WHEN worker_updated_at >= operational_time_floor
            AND worker_updated_at < operational_time_ceiling
            THEN floor(extract(epoch FROM worker_updated_at) * 1000)::bigint
          ELSE NULL
        END
      ),
      jsonb_build_object(
        'source', 'policy',
        'observedAtMs', CASE
          WHEN policy_updated_at >= operational_time_floor
            AND policy_updated_at < operational_time_ceiling
            THEN floor(extract(epoch FROM policy_updated_at) * 1000)::bigint
          ELSE NULL
        END
      )
    ),
    'recoveryObservations', recovery_projection,
    'recoverySummary', recovery_summary
  );
END
$read_call_operations_snapshot$;

DO $call_operations_projection_owner$
DECLARE
  function_owner oid;
  function_owner_name text;
  runtime_member boolean;
BEGIN
  SELECT owner.oid, owner.rolname
  INTO function_owner, function_owner_name
  FROM pg_proc projection
  JOIN pg_roles owner
    ON owner.oid = projection.proowner
  WHERE projection.oid =
    'public.read_call_operations_snapshot(uuid,uuid)'::regprocedure;

  WITH RECURSIVE inherited_roles(roleid) AS (
    SELECT membership.roleid
    FROM pg_auth_members membership
    WHERE membership.member = function_owner
    UNION
    SELECT membership.roleid
    FROM pg_auth_members membership
    JOIN inherited_roles inherited
      ON inherited.roleid = membership.member
  ),
  inheriting_roles(roleid) AS (
    SELECT membership.member
    FROM pg_auth_members membership
    WHERE membership.roleid = function_owner
    UNION
    SELECT membership.member
    FROM pg_auth_members membership
    JOIN inheriting_roles inheriting
      ON inheriting.roleid = membership.roleid
  )
  SELECT EXISTS (
    SELECT 1
    FROM (
      SELECT roleid FROM inherited_roles
      UNION
      SELECT roleid FROM inheriting_roles
    ) runtime_reachable
    JOIN pg_roles role
      ON role.oid = runtime_reachable.roleid
    WHERE role.rolname IN (
      'anon',
      'authenticated',
      'service_role',
      'hacc_backend',
      'hacc_worker',
      'hacc_runtime',
      'hacc_worker_runtime'
    )
  )
  INTO runtime_member;

  IF function_owner_name IN (
       'anon',
       'authenticated',
       'service_role',
       'hacc_backend',
       'hacc_worker',
       'hacc_runtime',
       'hacc_worker_runtime'
     )
     OR runtime_member THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'call_operations_function_owner_is_runtime_role';
  END IF;
END
$call_operations_projection_owner$;

REVOKE EXECUTE ON FUNCTION public.read_call_operations_snapshot(uuid,uuid) FROM PUBLIC;

DO $call_operations_read_grant$
DECLARE
  runtime_role text;
BEGIN
  -- CREATE OR REPLACE FUNCTION preserves an existing ACL. Normalize every
  -- non-owner grantee before restoring the one intended grant. This includes
  -- the backend role itself so a stale WITH GRANT OPTION cannot survive, as
  -- well as hosted API, concrete runtime, and unexpected custom roles.
  FOR runtime_role IN
    SELECT grantee.rolname
    FROM pg_proc projection
    CROSS JOIN LATERAL aclexplode(
      COALESCE(
        projection.proacl,
        acldefault('f', projection.proowner)
      )
    ) privilege
    JOIN pg_roles grantee
      ON grantee.oid = privilege.grantee
    WHERE projection.oid =
      'public.read_call_operations_snapshot(uuid,uuid)'::regprocedure
      AND privilege.privilege_type = 'EXECUTE'
      AND privilege.grantee <> projection.proowner
  LOOP
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION public.read_call_operations_snapshot(uuid,uuid) FROM %I CASCADE',
      runtime_role
    );
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hacc_backend') THEN
    GRANT EXECUTE ON FUNCTION public.read_call_operations_snapshot(uuid,uuid)
      TO hacc_backend;
  END IF;
END
$call_operations_read_grant$;

COMMENT ON FUNCTION public.read_call_operations_snapshot(uuid,uuid) IS
  'Returns bounded content-minimized call-management redaction input only when the call belongs to the supplied organization. Raw transcripts, provider payloads, action arguments/results, worker inputs/results/checkpoints, owner tokens, and idempotency material are excluded.';
