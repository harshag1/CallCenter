-- Conversation-scoped action admission. A deterministic coordinator action identity
-- may be retried exactly, but it can never be rebound to another call/conversation,
-- policy, fact set, receipt set, confirmation, or invocation.

CREATE TABLE IF NOT EXISTS public.conversation_call_action_intents (
  id uuid PRIMARY KEY,
  call_id uuid NOT NULL REFERENCES public.calls(id) ON DELETE RESTRICT,
  conversation_id uuid NOT NULL,
  org_id uuid NOT NULL,
  invocation_id text NOT NULL CHECK (invocation_id ~ '^[A-Za-z0-9_-]{24}$'),
  runtime_digest text NOT NULL CHECK (runtime_digest ~ '^[a-f0-9]{64}$'),
  capability_epoch integer NOT NULL CHECK (capability_epoch >= 0),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.:-]{1,127}$'),
  policy_digest text NOT NULL CHECK (policy_digest ~ '^[a-f0-9]{64}$'),
  arguments_sha256 text NOT NULL CHECK (arguments_sha256 ~ '^[a-f0-9]{64}$'),
  facts_sha256 text NOT NULL CHECK (facts_sha256 ~ '^[a-f0-9]{64}$'),
  receipts_sha256 text NOT NULL CHECK (receipts_sha256 ~ '^[a-f0-9]{64}$'),
  confirmation_sha256 text
    CHECK (confirmation_sha256 IS NULL OR confirmation_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (call_id, invocation_id),
  CONSTRAINT conversation_call_action_intents_conversation_fk
    FOREIGN KEY (conversation_id, org_id)
    REFERENCES public.voice_conversations(id, org_id) ON DELETE RESTRICT,
  CONSTRAINT conversation_call_action_intents_call_fk
    FOREIGN KEY (conversation_id, call_id)
    REFERENCES public.voice_conversation_calls(conversation_id, call_id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION public.reject_conversation_call_action_intent_mutation()
RETURNS trigger LANGUAGE plpgsql AS $conversation_call_action_intent_immutable$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = 'conversation_call_action_intents_are_append_only';
END
$conversation_call_action_intent_immutable$;

DROP TRIGGER IF EXISTS trg_conversation_call_action_intents_append_only
  ON public.conversation_call_action_intents;
CREATE TRIGGER trg_conversation_call_action_intents_append_only
BEFORE UPDATE OR DELETE ON public.conversation_call_action_intents
FOR EACH ROW EXECUTE FUNCTION public.reject_conversation_call_action_intent_mutation();

ALTER TABLE public.conversation_call_action_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_call_action_intents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hacc_backend_deny_all ON public.conversation_call_action_intents;
DO $conversation_call_action_intent_backend_policy$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hacc_backend') THEN
    CREATE POLICY hacc_backend_deny_all ON public.conversation_call_action_intents
      FOR ALL TO hacc_backend USING (false) WITH CHECK (false);
  END IF;
END
$conversation_call_action_intent_backend_policy$;
DO $conversation_call_action_intent_owner_policy$
BEGIN
  DROP POLICY IF EXISTS hacc_migration_owner_all ON public.conversation_call_action_intents;
  EXECUTE format(
    'CREATE POLICY hacc_migration_owner_all ON public.conversation_call_action_intents FOR ALL TO %I USING (true) WITH CHECK (true)',
    current_user
  );
END
$conversation_call_action_intent_owner_policy$;

CREATE OR REPLACE FUNCTION public.reserve_conversation_call_action_intent(
  action_identity uuid,
  call_identity uuid,
  conversation_identity uuid,
  organization_identity uuid,
  downstream_invocation_identity text,
  call_runtime_digest text,
  flow_capability_epoch integer,
  action_name text,
  policy_sha256 text,
  arguments_digest text,
  facts_digest text,
  receipts_digest text,
  confirmation_digest text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $reserve_conversation_call_action_intent$
DECLARE
  binding public.voice_conversation_calls%ROWTYPE;
  intent public.conversation_call_action_intents%ROWTYPE;
  inserted_count integer;
BEGIN
  -- Lock the unique call attachment for the complete surrounding transaction.
  -- This makes the scope proof and the later Flow reservation one atomic unit.
  SELECT * INTO binding
  FROM public.voice_conversation_calls
  WHERE call_id = call_identity
  FOR KEY SHARE;
  IF NOT FOUND
     OR binding.conversation_id <> conversation_identity
     OR binding.org_id <> organization_identity THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'conversation_call_action_scope_mismatch';
  END IF;

  INSERT INTO public.conversation_call_action_intents (
    id, call_id, conversation_id, org_id, invocation_id, runtime_digest,
    capability_epoch, action, policy_digest, arguments_sha256, facts_sha256,
    receipts_sha256, confirmation_sha256
  ) VALUES (
    action_identity, call_identity, conversation_identity, organization_identity,
    downstream_invocation_identity, call_runtime_digest, flow_capability_epoch,
    action_name, policy_sha256, arguments_digest, facts_digest, receipts_digest,
    confirmation_digest
  )
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;

  SELECT * INTO intent
  FROM public.conversation_call_action_intents
  WHERE id = action_identity
  FOR SHARE;
  IF NOT FOUND THEN
    SELECT * INTO intent
    FROM public.conversation_call_action_intents
    WHERE call_id = call_identity
      AND invocation_id = downstream_invocation_identity
    FOR SHARE;
  END IF;
  IF NOT FOUND
     OR intent.id <> action_identity
     OR intent.call_id <> call_identity
     OR intent.conversation_id <> conversation_identity
     OR intent.org_id <> organization_identity
     OR intent.invocation_id <> downstream_invocation_identity
     OR intent.runtime_digest <> call_runtime_digest
     OR intent.capability_epoch <> flow_capability_epoch
     OR intent.action <> action_name
     OR intent.policy_digest <> policy_sha256
     OR intent.arguments_sha256 <> arguments_digest
     OR intent.facts_sha256 <> facts_digest
     OR intent.receipts_sha256 <> receipts_digest
     OR intent.confirmation_sha256 IS DISTINCT FROM confirmation_digest THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'conversation_call_action_replay_conflict';
  END IF;
  RETURN inserted_count = 1;
END
$reserve_conversation_call_action_intent$;

COMMENT ON TABLE public.conversation_call_action_intents IS
  'Append-only coordinator action identities bound to one conversation/call/org and the exact policy, arguments, facts, receipts, and confirmation admitted for replay.';
COMMENT ON FUNCTION public.reserve_conversation_call_action_intent(
  uuid,uuid,uuid,uuid,text,text,integer,text,text,text,text,text,text
) IS
  'Atomically proves call attachment and admits only an exact replay of the complete coordinator action authority.';

REVOKE ALL ON public.conversation_call_action_intents FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reserve_conversation_call_action_intent(
  uuid,uuid,uuid,uuid,text,text,integer,text,text,text,text,text,text
) FROM PUBLIC;
DO $conversation_call_action_intent_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hacc_backend') THEN
    REVOKE ALL ON public.conversation_call_action_intents FROM hacc_backend;
    GRANT EXECUTE ON FUNCTION public.reserve_conversation_call_action_intent(
      uuid,uuid,uuid,uuid,text,text,integer,text,text,text,text,text,text
    ) TO hacc_backend;
  END IF;
END
$conversation_call_action_intent_grants$;
