# HACC LC4 qualification v3 operator runbook

Status: provider calls remain closed until the signed `authorize` step is
complete. `prepare`, `authorize`, and `report` make no provider calls. `run` is
one-shot authority: presenting its authorization consumes it before source or
credential inspection, and it must never be retried or resumed.

Run from `web/` with Node.js 20.19+ and an exactly clean checkout. Use absolute,
normalized paths throughout. The evidence root must be outside the repository
and either absent or an empty, non-symlink directory with mode `0700`. `prepare`
creates an absent final directory as `0700`; it does not reuse a nonempty root.

Authority and terminal keys must be distinct Ed25519 PKCS#8 private-key files.
Key, authorization, and credential files must be regular non-symlink files,
must not be hard linked, and must be inaccessible to group and other users.
The authorization emitted below has a fixed 30-minute lifetime; the verifier
rejects every authorization longer than 60 minutes.

```bash
umask 077

REPOSITORY_ROOT=/absolute/path/to/X_Project
EVIDENCE_ROOT=/private/tmp/hacc-lc4-qv3-evidence-$(date -u +%Y%m%dT%H%M%SZ)
KEY_ROOT=/private/tmp/hacc-lc4-qv3-keys-$(date -u +%Y%m%dT%H%M%SZ)
PROVIDER_ENV=/absolute/private/path/provider-overlay.env
REPO_ENV=/absolute/private/path/repository.env

mkdir -m 700 "$KEY_ROOT"
openssl genpkey -algorithm Ed25519 -out "$KEY_ROOT/authority.pem"
openssl genpkey -algorithm Ed25519 -out "$KEY_ROOT/terminal.pem"
chmod 600 "$KEY_ROOT/authority.pem" "$KEY_ROOT/terminal.pem" "$PROVIDER_ENV" "$REPO_ENV"

TRUST_ROOT_FINGERPRINT="$(
  openssl pkey -in "$KEY_ROOT/authority.pem" -pubout -outform DER |
  shasum -a 256 |
  awk '{print $1}'
)"

npm run benchmark:lc4:qualification:status

npm run benchmark:lc4:qualification:prepare -- \
  --root "$EVIDENCE_ROOT" \
  --repository-root "$REPOSITORY_ROOT" \
  --authority-private-key "$KEY_ROOT/authority.pem" \
  --trust-root-fingerprint "$TRUST_ROOT_FINGERPRINT" \
  --provider-env-file "$PROVIDER_ENV" \
  --repo-env-file "$REPO_ENV"

npm run benchmark:lc4:qualification:authorize -- \
  --plan "$EVIDENCE_ROOT/lc4-qualification-v3-plan.json" \
  --output "$KEY_ROOT/authorization.json" \
  --authority-private-key "$KEY_ROOT/authority.pem" \
  --terminal-private-key "$KEY_ROOT/terminal.pem" \
  --trust-root-fingerprint "$TRUST_ROOT_FINGERPRINT"

npm run benchmark:lc4:qualification:run -- \
  --root "$EVIDENCE_ROOT" \
  --repository-root "$REPOSITORY_ROOT" \
  --authorization "$KEY_ROOT/authorization.json" \
  --trust-root-fingerprint "$TRUST_ROOT_FINGERPRINT" \
  --terminal-private-key "$KEY_ROOT/terminal.pem" \
  --provider-env-file "$PROVIDER_ENV" \
  --repo-env-file "$REPO_ENV"

npm run benchmark:lc4:qualification:report -- \
  --root "$EVIDENCE_ROOT" \
  --trust-root-fingerprint "$TRUST_ROOT_FINGERPRINT"
```

Stop after any nonzero exit. Preserve the evidence root and the command output;
do not edit, retry, resume, or replace artifacts in place. A new attempt needs a
new clean source commitment, evidence root, plan, keys, and authorization.
The paid `run` command re-proves the root is physically outside
`--repository-root` and pins that directory identity through finalization. The
read-only `report` command has no repository argument; it replays artifact
integrity and requires the same physical, non-symlink `0700` root, but makes no
independent location claim.

## Resumable v4 release runner

The v3 command above is the strict one-shot legacy path. The current v4 release
runner preserves the same signed plan and `$3` ceiling but splits execution into
serial OpenAI, Gemini, and xAI shards. It can continue only at a scientifically
clean boundary: an unopened provider shard, or a retained setup terminal before
that shard's paid admission. Completed shards are replayed byte-for-byte. Any
admission without terminal evidence is quarantined permanently.

Inspect the contract without credentials or provider calls:

```bash
npm run benchmark:lc4:qualification:v4 -- --help
npm run benchmark:lc4:qualification:v4 -- status
```

After the same signed `prepare` and `authorize` steps above, continue or inspect
the retained v4 attempt with the exact same arguments:

```bash
npm run benchmark:lc4:qualification:v4 -- continue \
  --root "$EVIDENCE_ROOT" \
  --repository-root "$REPOSITORY_ROOT" \
  --authorization "$KEY_ROOT/authorization.json" \
  --trust-root-fingerprint "$TRUST_ROOT_FINGERPRINT" \
  --terminal-private-key "$KEY_ROOT/terminal.pem" \
  --provider-env-file "$PROVIDER_ENV" \
  --repo-env-file "$REPO_ENV"
```

Reissuing `continue` does not authorize a paid retry: it verifies and skips
completed shards, resumes only the next admitted clean boundary, and stops on
the first failed or ambiguous shard.
