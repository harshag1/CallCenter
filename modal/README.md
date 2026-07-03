# Author: Harsha Gundala
# modal/ — CLIP embedding service

Modal app `callcenter-clip-embedder`: CLIP ViT-B-32 (laion2b_s34b_b79k) text embeddings, 512-dim, L2-normalized, CPU containers that scale to zero. Weights are baked into the image at build time so cold starts skip the HuggingFace download.

## Endpoint

```
POST https://moonshine--callcenter-clip-embedder-embedder-embed.modal.run
Authorization: Bearer $MODAL_EMBED_SECRET
Content-Type: application/json

{"texts": ["...", ...]}            # ≤128 texts per request
→ {"embeddings": [[512 floats]], "model": "clip-vit-b-32", "dim": 512}
```

Texts beyond CLIP's 77-token context are truncated by the tokenizer — callers should chunk to ~280 chars (see `web/lib/knowledge.ts`). 401 on bad bearer, 413 over batch cap.

## Deploy

```sh
uv venv .venv && uv pip install --python .venv/bin/python modal fastapi
.venv/bin/modal secret create callcenter-embed-secret EMBED_SECRET=$(openssl rand -hex 32)
.venv/bin/modal deploy embedder.py
```

Consumers read `MODAL_EMBED_URL` + `MODAL_EMBED_SECRET` (gitignored env files).
