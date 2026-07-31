# LC4 held-out corpus custody handoff

This procedure creates one encrypted, publicly verifiable LC4 publication without exposing the held-out seed, encryption key, or corpus plaintext. It is a seal-only boundary: the repository intentionally contains no unseal command.

## Roles and prerequisites

Use three different people or independently controlled identities:

- the seed custodian creates and transfers the seed;
- the key custodian creates and transfers the encryption key through a separate channel;
- the preparation operator runs the seal command and publishes the sealed artifact and receipt.

The operator needs the reviewed generator source SHA-256, corpus-schema SHA-256, and this approved custody procedure's SHA-256. Do not use `LC4_DEVELOPMENT_TEST_SEED_BYTES`; sealed-custody generation rejects that public development seed. This procedure does not authorize provider calls, preregistration, evaluation, or corpus unsealing.

## Prepare two independent custody files

Each custodian works in a private directory on an encrypted host, with command history disabled if required by local policy. Generate exactly 32 raw random bytes; do not encode them as hex or base64.

```sh
umask 077
openssl rand 32 > lc4-seed.bin   # seed custodian only
chmod 600 lc4-seed.bin
```

```sh
umask 077
openssl rand 32 > lc4-key.bin    # key custodian only
chmod 600 lc4-key.bin
```

Transfer the two files separately and out of band. Never place either file's contents in the repository, chat, ticket, shared log, shell argument, environment variable, or command output. The preparation operator must preserve the original files as regular, non-symlink files with exact mode `0600`; copied contents in one file or hard-linked paths are rejected.

Before sealing, the operator verifies only metadata:

```sh
stat -f '%N %z bytes mode=%Lp' /secure/seed/lc4-seed.bin /secure/key/lc4-key.bin
```

Both sizes must be 32 bytes and both modes must be 600. Do not print or hash the file contents manually.

## Seal once

Create an existing, non-symlink output directory with restrictive permissions. Use a new output filename ending in `.lc4-sealed.json`; the CLI never overwrites an existing path.

Run this ceremony on a network-isolated host or inside an independently enforced no-network environment. The CLI itself makes no provider or network calls, but custody policy must enforce network isolation outside the Node.js process boundary.

```sh
cd web
umask 077
npm run benchmark:lc4:seal -- seal \
  --seed-file /secure/seed/lc4-seed.bin \
  --key-file /secure/key/lc4-key.bin \
  --output-file ../benchmarks/voice-long-horizon/public/lc4-confirmatory-v1.lc4-sealed.json \
  --generator-source-sha256 GENERATOR_SOURCE_SHA256 \
  --corpus-schema-sha256 CORPUS_SCHEMA_SHA256 \
  --custody-procedure-sha256 CUSTODY_PROCEDURE_SHA256 \
  --seed-custodian-id seed.custodian \
  --key-custodian-id key.custodian \
  --preparation-operator-id preparation.operator \
  --created-at 2026-07-21T16:00:00.000Z
```

The CLI obtains a fresh 96-bit nonce from the operating-system CSPRNG. It writes a same-directory temporary file, syncs it, publishes the final path through a no-clobber atomic link, syncs the directory, and removes the temporary name. The only stdout record is the sanitized receipt. Redirect it if a separately published receipt is desired; it contains commitments and custody identifiers, never source paths, secret bytes, or plaintext.

The final JSON contains the AES-256-GCM ciphertext, public commitment manifest, receipt, and a publication-payload SHA-256. Keep the artifact mode at `0600` until the custody team approves public release. Before release, independently copy the `manifest_sha256` from the receipt to the preregistration or transparency record; the public verifier requires that independently published digest.

The manifest deliberately makes a narrow held-out claim: only seed-derived content values and surface realization are hidden. The six-by-four topology, domain vocabulary, power-plan identities, and development-path structure are public and have been exercised during development. Do not describe LC4 as a wholly unseen topology or wholly unseen task family.

## Failure and handoff rules

- A nonzero exit publishes no receipt to stdout. Treat an already-present final path as potentially successful and inspect it before retrying under a new filename.
- Never relax file permissions, follow symlinks, reuse a final output path, or combine seed and key custody to bypass a rejection.
- The CLI does not delete custody inputs. Return or destroy each input only under the applicable retention policy and with its custodian's approval.
- Record the final artifact SHA-256, sanitized receipt, operator identity, time, generator revision, and independent manifest publication location in the custody log.
- Unsealing is a later, separately reviewed ceremony. It must be implemented outside this seal-only CLI under explicit authorization and must preserve the preregistered scoring boundary.
