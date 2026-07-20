-- Author: Harsha Gundala
-- 030_anonymous_auth_abuse_boundary.sql
-- Durable, privacy-preserving per-source caps for anonymous email OTP issuance.

ALTER TABLE auth_codes
  ADD COLUMN IF NOT EXISTS request_source_hmac text;

ALTER TABLE auth_codes
  DROP CONSTRAINT IF EXISTS auth_codes_request_source_hmac_shape;
ALTER TABLE auth_codes
  ADD CONSTRAINT auth_codes_request_source_hmac_shape
  CHECK (
    request_source_hmac IS NULL
    OR request_source_hmac ~ '^[0-9a-f]{64}$'
  );

CREATE INDEX IF NOT EXISTS idx_auth_codes_request_source_created_at
  ON auth_codes(request_source_hmac, created_at DESC)
  WHERE request_source_hmac IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_auth_codes_email_source_created_at
  ON auth_codes(email, request_source_hmac, created_at DESC)
  WHERE request_source_hmac IS NOT NULL;

COMMENT ON COLUMN auth_codes.request_source_hmac IS
  'Domain-separated HMAC of the client IP asserted by the explicitly trusted edge; raw IP addresses are never persisted.';
