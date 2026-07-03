# File Storage — S3 primary, bytea fallback

Author: Harsha Gundala. Raw uploaded file bytes live in S3 when AWS env is present; otherwise everything behaves exactly as before (bytea in `documents.data`).

## Env

```
AWS_ACCESS_KEY_ID=        # required to enable S3
AWS_SECRET_ACCESS_KEY=    # required to enable S3
S3_BUCKET=callcenter-files  # required to enable S3
AWS_REGION=us-east-1      # optional, default us-east-1
S3_ENDPOINT=              # optional; S3-compatible stores (minio/s3rver) — enables forcePathStyle
```

`s3Enabled()` (web/lib/storage.ts) is true only when all three required vars are set. No partial modes.

## Key scheme

```
<orgId>/<documentId>/<sanitized-filename>
```

Filenames are sanitized to `[A-Za-z0-9._-]` (max 180 chars). Keys are stored on `documents.s3_key` (migration 007).

## Semantics

- **Uploads** (`/api/knowledge`): knowledge docs, media (mp3/wav/m4a), and JSON go to S3 with `documents.data` left NULL. **CSVs always stay on the bytea path** — dataset auto-import and small-CSV embedding read `documents.data`. If an S3 put fails, the file falls back to bytea for that upload (logged).
- **Serving** (`/api/files/[id]/raw`): docs with `s3_key` get a 302 to a presigned GET URL (5 min TTL, inline content-disposition); bytea docs are served directly. Org scoping and 404s unchanged.
- **Hold music**: transcode sources bytes via `documentBytes(doc)` (S3 when keyed, else bytea); the μ-law rendition itself stays in Postgres for runtime latency.
- **Fallback** (no AWS env): identical to pre-S3 behavior end to end. Documents written while S3 was enabled keep their `s3_key` and will 404 on raw serving until env returns — don't flip env off with S3-resident data in production.
