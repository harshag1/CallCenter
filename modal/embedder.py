# Author: Harsha Gundala
# embedder.py — Modal-hosted CLIP ViT-B-32 text embedder (512-dim, L2-normalized) behind a bearer-authed web endpoint.

import modal

MODEL = "ViT-B-32"
PRETRAINED = "laion2b_s34b_b79k"
DIM = 512
MAX_BATCH = 128


def _bake_weights() -> None:
    """Download CLIP weights at image build so containers cold-start from local cache."""
    import open_clip

    open_clip.create_model_and_transforms(MODEL, pretrained=PRETRAINED)


image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install(
        "torch==2.5.1",
        extra_options="--index-url https://download.pytorch.org/whl/cpu",
    )
    .pip_install("open_clip_torch==2.29.0", "fastapi[standard]==0.115.6")
    .run_function(_bake_weights)
)

app = modal.App("callcenter-clip-embedder", image=image)

with image.imports():
    import fastapi


@app.cls(
    secrets=[modal.Secret.from_name("callcenter-embed-secret")],
    scaledown_window=120,
    min_containers=0,
    cpu=4,
    memory=4096,
)
class Embedder:
    @modal.enter()
    def load(self) -> None:
        import open_clip
        import torch

        torch.set_num_threads(4)
        self.model, _, _ = open_clip.create_model_and_transforms(MODEL, pretrained=PRETRAINED)
        self.model.eval()
        # open_clip tokenizer truncates to CLIP's 77-token context window by default.
        self.tokenizer = open_clip.get_tokenizer(MODEL)

    @modal.fastapi_endpoint(method="POST")
    def embed(self, payload: dict, request: "fastapi.Request"):
        import os

        import torch
        from fastapi import HTTPException

        auth = request.headers.get("authorization", "")
        if auth != f"Bearer {os.environ['EMBED_SECRET']}":
            raise HTTPException(status_code=401, detail="invalid bearer token")

        texts = payload.get("texts")
        if not isinstance(texts, list) or not texts or not all(isinstance(t, str) for t in texts):
            raise HTTPException(status_code=400, detail="body must be {\"texts\": [\"...\"]}")
        if len(texts) > MAX_BATCH:
            raise HTTPException(status_code=413, detail=f"max {MAX_BATCH} texts per request")

        tokens = self.tokenizer([t[:2000] for t in texts])  # pre-trim; tokenizer truncates to 77 tokens
        with torch.no_grad():
            feats = self.model.encode_text(tokens)
            feats = feats / feats.norm(dim=-1, keepdim=True)
        return {"embeddings": feats.tolist(), "model": "clip-vit-b-32", "dim": DIM}
