# Infra Stack Contracts — Modal CLIP · S3 · TurboPuffer · Three.js

Target architecture (primary path), with a resilient fallback stack when env is absent — the platform keeps working in both modes.

## Env vars

```
MODAL_EMBED_URL=            # deployed Modal CLIP endpoint (https://...modal.run)
MODAL_EMBED_SECRET=         # shared bearer secret for the endpoint
TURBOPUFFER_API_KEY=        # vector store
TURBOPUFFER_REGION=gcp-us-central1
AWS_ACCESS_KEY_ID=          # S3 file storage
AWS_SECRET_ACCESS_KEY=
AWS_REGION=us-east-1
S3_BUCKET=callcenter-files
```

## RAG pipeline (primary)

upload → extract text (unpdf/mammoth) → chunk (existing) → **Modal CLIP** text embeddings (512-dim, ViT-B-32)
→ **TurboPuffer** upsert, namespace `org-<orgId>`, attributes {document_id, filename, chunk_index, content}
→ search: CLIP-embed query → TurboPuffer top-k.

Fallback (no MODAL_EMBED_URL or no TURBOPUFFER_API_KEY): OpenAI text-embedding-3-small → pgvector (existing tables, 1536-dim). Provider chosen consistently for read+write via `ragMode()`. Dims never mix (CLIP-512 lives only in TurboPuffer; pgvector stays 1536).

## File storage (primary)

All uploaded files store raw bytes to **S3** (`orgId/documentId/filename` keys) — EXCEPT CSVs, which keep the current parse-to-dataset path (and small-CSV embedding). documents gains `s3_key text`. Serving: presigned GET (redirect) from /api/files/[id]/raw. Fallback: no AWS env → bytea in documents.data as today. Hold-music renditions stay in Postgres (runtime latency).

## Flow viewer

React Flow replaced by a **Three.js** renderer (@react-three/fiber + drei): orthographic camera (2D presentation identical to today — dot grid, white cards, bezier edges, rings, badges), nodes as drei `<Html>` wrapping the existing card components, pan/zoom via camera, all existing props/behaviors preserved (onNodeClick, active/visited, hold chip, experiment badge, outbound labels, diff rings, mini non-interactive mode).
