# Public release secret gate

Run the complete gate from `web/` before publishing a commit or source archive:

```bash
npm run audit:public
```

The command runs two independent, read-only checks. A zero process exit is not
enough for automation: parse both JSON reports and verify the contracts below.

## Locked dependency audit

Run the dependency gate separately from `web/`:

```bash
npm run audit:dependencies:locked
```

The gate runs npm's production-only and complete lockfile audits independently.
The production graph must contain no advisory at any severity; development
exceptions can never authorize a runtime dependency. The complete graph must
exactly match the short-lived reviewed exception in
[`.security/npm-audit-exceptions.json`](../.security/npm-audit-exceptions.json).
That manifest binds the advisory identity and metadata, every propagated
vulnerability record, all dependency edges and node paths, exact locked node
versions, direct development dependency constraints, package identity, lockfile
version, Node engine, justification, and UTC expiry.

A new advisory, changed severity or affected range, dependency update, graph
movement, promotion into production dependencies, malformed manifest, or
expired review fails closed. A clean complete audit also fails while an
exception remains, forcing removal of stale policy instead of silently carrying
it forward. Do not extend an expiry mechanically: first check for compatible
upstream releases, verify the production audit remains empty, review the exact
new graph, and document why the residual development-only exposure is bounded.

## Current publishable tree

`npm run audit:public:worktree` scans the bytes that Git can publish now:

- every tracked file, using its current working-tree bytes (including modified
  files);
- every non-ignored untracked file returned by
  `git ls-files --others --exclude-standard`; and
- tracked deletions, which are counted but not read because they are absent from
  the release tree.

Its Git subprocesses clear ambient repository/index/worktree routing variables,
disable replacement objects, and require Git's canonical top-level path to
resolve to the requested repository. This prevents a clean external index from
being substituted for the release tree being read.

The report must have:

```json
{
  "schema_version": 1,
  "kind": "hacc_public_worktree_secret_audit",
  "inventory_contract": "tracked_plus_nonignored_untracked",
  "ignored_files_scanned": false,
  "complete": true,
  "pass": true,
  "finding_count": 0
}
```

Also require `allowlist.unused_entry_ids` to be empty. Bind release evidence to
`head_commit`, `head_tree`, `git_status_sha256`, and
`publishable_file_manifest_sha256`; the last value commits to each publishable path, whether
it is tracked or untracked, its byte size, and its current SHA-256. Any content,
path, or source-state change changes the manifest.

Ignored files are intentionally outside this *public-release* inventory: Git
does not include them in a normal commit or source archive. This is not a claim
that local `.env`, raw recordings, or local benchmark outputs are safe. Keep
them access-restricted and never use `git add -f` to publish them. If an ignored
file is force-added, it becomes tracked and this gate scans it. Release tooling
that uploads ignored files or arbitrary build context must audit that separate
artifact with a deployment-specific scanner.

The scanner detects common OpenAI, Anthropic, xAI, Gemini/Google, Groq, GitHub,
AWS, Stripe, Resend, SendGrid, Slack, npm, Hugging Face, and Replicate shapes;
provider-secret assignments; database URLs with embedded passwords; bearer,
Basic, JWT, OAuth, and PEM credentials; and Base64, URL-encoded, or hex-encoded
provider keys. It also rejects publishable private environment, key-material,
recording/transcript, customer/export/runtime-data, raw benchmark-evidence, and
obviously sensitive filename paths even when their contents have no recognizable
token. Named provider/domain-secret assignments are recognized in env/TOML `=`,
YAML `:`, and ordinary one-line JSON property forms.

Credential-like filenames, email addresses, URL userinfo, E.164-like phone
numbers, and control characters are replaced with a path digest in the report.
Paths classified as recording/transcript or customer/runtime data are always
replaced with a digest, even when the filename contains no recognizable PII.
Source lines, matched substrings, file contents, and Git stderr are never emitted.

### Resource and filesystem boundary

The default bounds are 20,000 publishable files, 4 MiB per text file, 1 MiB per
binary file, and 128 MiB total scanned bytes. UTF-8 text and bounded binary
ASCII/UTF-16 views are inspected. Oversized files, total-limit exhaustion,
symlinks, non-regular files, unreadable files, or files changed during the scan
make `complete` false and fail the gate. Symlinks are opened with no-follow
semantics and are never dereferenced.

Large public assets should live in a separately audited release-asset or Git LFS
pipeline; scanning a Git LFS pointer does not scan the remote object.

### Allowlist evidence

The allowlist is [`.security/public-secret-audit-allowlist.json`](../.security/public-secret-audit-allowlist.json).
An entry grants exactly one reviewed file digest and one or more named finding
classes:

```json
{
  "id": "synthetic-detector-fixture",
  "path": "path/to/synthetic-fixture.txt",
  "sha256": "64-lowercase-hex-characters",
  "pattern_classes": ["openai_project_key"],
  "reason": "Why this exact inert fixture is safe to publish."
}
```

Entries require an exact path, current file SHA-256, finding class, bounded
human justification, and stable sorted ID. Wildcards do not exist. A changed
file, wrong path, wrong class, duplicate grant, malformed entry, or unused/stale
entry fails the gate. Operational failures such as symlinks, unreadable files,
and size-limit overflow cannot be allowlisted. Never allowlist a real
credential: remove it, rotate it, and inspect history instead.

## Reachable Git history

`npm run audit:public:history` scans every commit reachable from every local Git
ref (`git rev-list --all`). It uses the same content and sensitive-path rules,
including encoded/UTF-16 values and files deleted from the current branch. It
inventories each reachable tree, deduplicates blobs by object ID, and batch-reads
bounded raw blobs in memory. It separately scans bounded commit messages,
annotated-tag messages, and credential/PII-like ref names. Metadata findings
contain only an object digest, redacted path marker, and class. Match values and
source lines are never emitted.

History is bounded to 10,000 reachable commits, 50,000 unique blobs, 1,000,000
tree/blob references, 4 MiB per text blob, 1 MiB per binary blob, 256 MiB total
decoded bytes, 100,000 refs, 1 MiB per commit/tag metadata object, 32 MiB total
metadata, and 16 MiB per Git batch. Commit/ref/blob/reference overflows abort
before building an unbounded inventory. Symlinks, submodules, oversized objects,
or exhausted byte limits produce path-only operational findings and make the
report incomplete. Annotated tags must resolve directly to a reachable commit;
nested tags and direct blob/tree tag targets fail closed instead of silently
leaving a second object graph unscanned.

Every Git subprocess clears ambient graph-routing variables and sets
`GIT_NO_REPLACE_OBJECTS=1`. The gate refuses replacement refs, nonempty or
non-regular legacy `.git/info/grafts`, and shallow repositories. Those local
overlays can otherwise make ordinary Git traversal omit original parents or
objects that remain part of a published repository.

Release automation must require:

```json
{
  "schema_version": 2,
  "complete": true,
  "pass": true,
  "finding_count": 0
}
```

Record `head_commit`, `reachable_commit_set_sha256`, and
`reachable_ref_set_sha256` with that decision. These bind the sorted commit set
and exact ref-name/object/type set, so a ref added, moved, renamed, or removed
after the scan invalidates the evidence even if the counts are unchanged.

Real secrets are never allowlisted. The history scanner permits only exact,
reviewed grants for synthetic security-test fixtures, bound to the finding
class, blob, and path; every grant must be used or the audit fails. If a real
secret ever entered a reachable commit, revoke/rotate it first, remove it from
every published ref with a reviewed history-rewrite procedure, and rerun the
gate. Deleting the file at HEAD is insufficient.

## Evidence boundary

These checks are high-signal release gates, not proof that arbitrary text has no
secret or personal data. They cannot recognize every provider format, encrypted
payload, steganographic value, remote LFS object, or benign-looking customer
record. Run them at the exact release commit, record both JSON outputs and the
worktree manifest digest, require a clean intended release tree, and combine
them with provider-side secret scanning and repository-host push protection.
