-- Author: Harsha Gundala
-- 003_studio.sql — golden onboarding: org settings, onboarding state, knowledge documents.

ALTER TABLE orgs ADD COLUMN IF NOT EXISTS favicon_url text;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS internet_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS allowed_domains text[] NOT NULL DEFAULT '{}';
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS onboarding jsonb NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  filename text NOT NULL,
  mime text NOT NULL,
  size_bytes int NOT NULL,
  xai_file_id text,
  status text NOT NULL DEFAULT 'ingesting',  -- ingesting | ready | failed
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_documents_org ON documents(org_id, created_at DESC);

-- Knowledge base vectors (OpenAI text-embedding-3-small, 1536 dims)
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS doc_chunks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES orgs(id),
  chunk_index int NOT NULL,
  content text NOT NULL,
  embedding vector(1536) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_doc_chunks_org ON doc_chunks(org_id);
