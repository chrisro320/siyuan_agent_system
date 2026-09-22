# Runtime, Provider, and Publication Contracts

## 1. Scope / Trigger

Required when changing `src/contracts`, ingestion, storage, providers, worker, HTTP routes, SiYuan integration, `integrations/omp`, or deployment. This is a standalone Bun 1.3.14 service, not a patch to OMP or SiYuan. `src/contracts/index.ts` is the shared runtime-schema authority. Do not create parallel DTO definitions.

## 2. Signatures

- `normalizeImport(request: ImportRequest): Conversation`; `scanOmpRoot(root, projectId): AsyncGenerator<OmpScanItem>`.
- `Store.ingest(request, conversation)` preserves raw snapshots and returns `{ import, job, duplicate }`.
- `Store.commitExtractionSegment(job, candidates)` commits the entire segment and its **post-commit** cursor atomically. No network await inside a SQLite transaction.
- `OllamaClient.extract(...)` and `JevClient.judge(...)` validate external responses before returning typed results. There is no parallel mental-model generator.
- `SiyuanWriter.plan(candidate, destination, source, appendDocumentId?)` returns an immutable operation plan; `execute(operation)` reconciles or sends it; `undo(operation)` deletes only a matching owned addition.
- `POST /api/candidates/:id/review` returns `{ candidateId, jobId }`, not a void response. `PUT /api/settings` returns the new `Settings` revision.
- `Store.ingestCapture({ captureId, payloadDigest, branchLeafId, request, conversation })` returns a discriminated `created` / `replay` / `conflict` result. It owns the capture receipt and ingestion transaction.
- `POST /api/capture`: `{ schemaVersion: 1, captureId, branchLeafId, conversation }` → `{ captureId, importId, jobId, duplicate }`; automatic capture accepts original user/assistant messages only.
- `POST /api/search`: `{ projectId, query, limit?, maxChars? }` → `{ projectId, notes, truncated }`. Notes include current block/document IDs, candidate/operation IDs, revision, edit/truncation flags, and original source/message identities. `/api/recall` and mental-card routes are removed, not aliased.
- `bun run setup-omp -- --project <absolute-root> --project-id <id> --service-url <PUBLIC_ORIGIN> --token-file <absolute-file> [--apply]` defaults to dry-run. `--status` inspects effective readiness; scope/artifact changes require `--reconfigure`.
- OMP `siyuan_search(query, limit?, maxChars?)` is an explicit read tool. Its project ID comes only from trusted local configuration. Ordinary turns never invoke it or receive automatic SiYuan context.

## 3. Contracts

### Sources and durable state

Source identity, source revision, message revision, job run, candidate lineage, and publication identity are distinct. SQL uniquely constrains `(sourceKey, revision)`, `(importId, policyRevision, promptVersion, run)`, and operation `contentKey`. Raw snapshots and normalized revision membership are separate. Locations do not rewrite message content identity; completeness warnings do affect source revision. IDs longer than the shared limit fail rather than being silently shortened.

Polling reads only direct regular JSONL files from an explicitly enabled server-allowed root. Refuse symlink roots and open children with `O_NOFOLLOW`. Read at most the checked file size, bounded by 64 MiB; growing files cannot trigger an unbounded read. Yield one file at a time, preserve per-file errors, and continue with siblings. Polling consumes newline-committed records; malformed complete lines are not treated as pending tails. Preserve parent IDs, missing parents, cycles, attachments, unknown metadata, and truncation as observable information.

`Job.extractionPlan` fingerprints the actual segmented/redacted input plus prompt version. A resume cannot change a non-null plan, rewind its cursor, regress completion, or commit only part of a segment. A replayed segment batch fails; no partial-subset success shortcut. Candidate histories are append-only. `saveJob` updates an existing identity, never creates or moves one. Retired `mental_cards` rows/table remain on disk without active reader, writer, provider, public API or UI.

### Automatic publication capture and explicit current-note search

`ADAPTER_TOKEN` / `ADAPTER_TOKEN_FILE` authorize native adapters; direct values win. `ADAPTER_PROJECTS` is a comma-separated allowlist, and each allowed project also needs a current destination mapping. Keep exact `PUBLIC_ORIGIN` host checking. A native client may omit `Origin`, not authentication or project authorization.

Write raw bytes before starting the capture transaction. Inside one transaction, compare/reserve immutable `captureId` and create the import, job and receipt together. A crash may leave unreferenced raw bytes, never an executable job outside its capture receipt. Do not reintroduce `ingest` followed by a separate receipt write.

Search uses native SiYuan `fullTextSearchBlock` envelopes (`id`, `rootID`, `box`; SQL still uses `root_id`). Child/document hits are discovery only, not authorization. Project/status/notebook-scoped storage queries select at most 60 matching operations before external reads. Both parent document and owned block must pass current notebook, managed-root, owner/project and operation checks.

After the final external await, synchronously reload destination, candidate and operation. Only current verified publications qualify. Return current human-edited owned-block content and mark `edited`; never substitute the old generated draft. There is no derived mental content. This is full-text retrieval, not a semantic/embedding search claim.

### Hindsight ownership and OMP publication progress

Hindsight remains the primary automatic LLM memory system. The publisher must not disable, replace or reject enabled Hindsight or its Jev gate. Preserve global configuration, project task bindings and unrelated settings. Only the known overrides introduced by the superseded rollout may be restored during an explicitly authorized local migration.

Only persisted root sessions created at/after `activatedAt`, within `projectRoot`, may be captured automatically. Explicit search is a separate user-requested read, authorized by current project configuration and server scope; it does not require a new capture session.

State schema 2 contains monotonic `consumed`, `pending`, and bounded `accepted` details. Queued, accepted and baseline identities are never evicted. At 20,000 consumed revisions or 32 pending captures, stop adding work and show degradation. Legacy schema-2 anchor/observation fields are ignored on load and omitted on the next successful save; pending/consumed/accepted/identity/activation are preserved. Do not reset state to remove the old injection feature.

If an existing session cannot fit in the baseline ledger, disable it with `baseline_overflow`; never save or use an empty baseline. State-save failure rolls back to the last durable state and stops new capture with `state_unwritable`.

Baseline acquisition uses `sessionManager.getEntries()`, not only `getBranch()`: `/tree` changes the active leaf without switching sessions. Keep `baseline_overflow` sticky for that session in-process; restart at a short leaf must still see the full persisted session and refuse an oversized baseline.

Only ENOENT permits fresh state. Corrupt/oversized/unreadable state or mismatched project/session-file/activation identity stops delivery without overwriting the file. State files are 0600 under 0700 directories, saved through fsync and rename. A state reset never authorizes historical backfill.

Reparse each persisted pending payload through `captureRequestSchema` before delivery. Its capture/project/session identity and queued revision keys must agree with the state ledger and payload. A JSON string alone is not a validated request. A response only settles pending work when its `captureId` matches the request; a mismatched acknowledgement preserves pending work and reports degradation.

Capture original user/assistant text on settled root turns; exclude synthetic/provider-only/system/tool/thinking/known-secret/reserved-knowledge-envelope content. Use `trim()` only to reject empty messages; preserve exterior whitespace in evidence and revision hashes. Persist outbox and consumed keys together before delivery. Acknowledgement removes pending work and records acceptance. Shutdown delivery is bounded to 1,500 ms; timeout preserves pending work.

The adapter registers no `before_agent_start` or `context` recall handler. It neither constructs nor replays automatic anchors, and never mutates provider context or toolsets mid-turn. `siyuan_search` is registered statically and called only on demand; results are untrusted tool data with current-note provenance. Existing raw transcripts remain unchanged.

Search output has a 16,000-character hard cap. Reserve complete later provenance headers and minimum useful body slices before spending the remaining budget on earlier notes. Headers are atomic, only bodies are clipped, and final truncation reflects both service and adapter clipping. Search is not an automatic memory preload.

Escape reserved-envelope markers and line breaks in every provenance field, not only the title/body; include operation identity and encode URI path segments. Propagate the tool AbortSignal through both headers and response-body reads. External cancellation remains cancellation; only the internal deadline is a timeout.

### Build and installation

Build web and adapter outputs into one staging directory. Publish the new `dist` only after both builds succeed; failure retains the prior complete artifact. The adapter manifest fingerprints local transitive sources, `package.json`, `bun.lock` and the generated artifact. An index-file mtime alone cannot establish freshness.

The generated stub imports the exact verified adapter path, including overrides. It is gitignored and native OMP discovery filters gitignore, so registration must be explicit: write its absolute path into project `extensions`, preserving unrelated settings and inherited extension lists. Do not alter Hindsight/gate settings or reject their environment flags. Write registration, then stub, then enabled configuration; missing configuration leaves capture disabled. Status checks actual target, manifest freshness and registration, not a claim of exclusive memory ownership.

Runtime and installer share `serviceOriginSchema` and the 8,192-byte token limit. Service URLs must be an exact HTTP(S) origin without credentials/path/query/fragment. Resolve project containment with platform path semantics, not a hard-coded slash prefix. Resolve native global config/profile selection (including `config.yaml` fallback) or require an explicit path rather than silently losing inherited extensions. Status validates the artifact actually bound by the stub; an explicit different artifact is a mismatch, and an unused default artifact cannot make a valid custom installation fail.

### Providers and policy

- Knowledge generation uses `GENERATION_MODEL = "deepseek-v4.1-flash"` at `https://ollama.com/api/chat`. Require a final assistant response with `done: true` and the approved model (`:cloud` suffix accepted). No local endpoint, fallback model, tools, assumed remote JSON Schema enforcement, or extra mental-generation request.
- Validate final JSON locally, allow one bounded repair, and validate evidence quotes as exact substrings of the offered source messages. Segmentation never silently discards the end of a conversation.
- Jev uses `https://api.typesafe.ai/v1/systemone`, alias `jev-latest`; record the actual response model. Require all requested typed answers, known enum keys, valid distributions (sum tolerance `1e-6`), consistent argmax and weighted score, and the declared score legend.
- Jev sensitivity applies only to proposed `candidate`, `evidence` and `cited_messages`. `related_notes` remains available for duplicate/conflict judgment, but its navigation links/provenance are not newly proposed content. No parallel `prior_mental` input. Do not strip arbitrary URLs or lower thresholds to compensate for background contamination.
- Retention requires validated `disposition: retain` plus policy gates. `action: review` vetoes retention. Append/duplicate recommendations require an owned related note. Archive never upgrades to retain.
- Record available provider usage even if later semantic validation fails. Never log keys or entire provider failure bodies.

### SiYuan and environment

Persist a `planned` operation before a mutation. Reserve document/block IDs and freeze destination, source revision, `expectedAttributes`, Markdown, and content key. A receipt is first accepted only when verified, then immutable. Terminal conflict/undo states cannot revert to writable states.

New document paths are `managedRoot/project/topic/title-operationPrefix`; candidate `kind` remains classification metadata, never an intermediate directory. Once a receipt exists, a document may move within its original authorized notebook/root without changing its reserved document/block IDs, frozen plan or exact receipt. Search also checks the current destination root and ownership. First verification still requires the exact planned path; moving outside scope or changing content/attributes must not permit undo. Do not rewrite persisted operation paths merely to reorganize the tree.

Call `flushTransaction` before relying on SQL indexes; SQL absence alone does not establish block absence. `sent`/`uncertain` plus no visible block means **read-only reconciliation**, not permission to resend. Read-back checks notebook, managed root, document, ownership, and every expected source attribute.

SiYuan v3.8.4 normalizes Markdown, adds child IALs, and inserts U+200B at inline-code boundaries. `canonicalMarkdown` removes generated IALs outside fenced code and U+200B immediately outside matched inline-code delimiters only. Preserve code contents, ordinary-text U+200B, escaped literal backticks, fenced contents and paragraph boundaries. User-authored U+200B touching code boundaries cannot be distinguished after SiYuan serialization; normalize this boundary symmetrically. If text still differs, compare `SiyuanClient.renderMarkdown` outputs from `/api/lute/md2html`; its HTML parser removes generated node IDs/timestamps only. Other attributes/content/whitespace remain significant. Never execute or insert returned HTML into the UI. Undo uses the original exact Kramdown/attribute receipt, not semantic comparison.

If standard Markdown HTML still differs on first verification, read the same block via `getTextMarkKramdown(id)` (`getBlockKramdown` mode `textmark`, matching response ID required). Render that source with `renderMarkdown(..., true)`: convert only native single-type `span[data-type=strong/em/s]` into `strong/em/del`, preserving all other attributes and every whitespace/content byte. Compare to the original expected HTML. Unknown/composite textmark types are not stripped or guessed. This read-only fallback avoids the standard exporter’s punctuation padding; it does not add/delete/collapse spaces, mutate a note, or weaken the original exact Kramdown receipt/undo check.

Fences inside blockquotes also protect literal content. Pair fence delimiters by quote depth and marker, not the raw whitespace prefix: opening/closing indentation and spaces after `>` may differ legally. Regression inputs must cover top-level three-space opening versus zero-space closing, and `> ` versus `>` at the same quote depth.

`OLLAMA_API_KEY`, `TYPESAFE_API_KEY`, `SIYUAN_TOKEN` accept `_FILE` alternatives; direct values take precedence. `PUBLIC_ORIGIN` must match request host/origin. `SIYUAN_URL` is server-facing; optional `SIYUAN_PUBLIC_URL` is browser-facing and must not contain credentials. Compose publishes loopback-only and uses a persistent volume. One publisher per data directory; no distributed worker claims are implemented.

## 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| Missing key / malformed output / missing Jev answer | Visible failure; no write plan or default retention |
| Excluded source or fabricated quote | Stop before unsafe cloud use or publication |
| Changed policy or extraction plan mid-run | Fail closed; explicit reprocessing required |
| Repeated raw source revision | Existing ingestion/job; no new publication |
| Uncertain write, block not yet found | `write_outcome_unknown`; no repeat mutation |
| Read-back identity/content mismatch | `siyuan_conflict`; no receipt accepted |
| Human change after receipt | Undo conflict; preserve content |
| SiYuan renderer unavailable | Retryable verification error, not successful publication |
| Concurrent setting/candidate edit | CAS conflict; retain submitted draft/history |
| Capture identity reused with different content | `capture_conflict` / 409; no second import/job |
| Missing/wrong adapter Bearer token | `adapter_unauthorized` / 401; no input echoed |
| Adapter disabled or project/destination not allowed | 503 or `project_not_allowed` / 403; no fallback project |
| Parent document changes owner/scope | Exclude its child blocks |
| Withdrawal or destination removal during search await | Revalidate current state; omit or reject, never use the old snapshot |
| Corrupt or mismatched local adapter state | Fail closed; do not recapture history |
| Outbox or consumed-ledger limit | Visible degradation; preserve existing durable state |
| Old session or subagent | No automatic capture |
| Hindsight or its Jev gate enabled | Publication/search can coexist; no owner conflict or settings mutation |
| Stale artifact or mismatched generated stub | Installer rejects activation or reports degraded status |
| Capture response belongs to another capture | Preserve pending work; no accepted receipt |
| Pending JSON violates payload/ledger identity | `state_corrupt`; no request or file rewrite |
| Search cancellation during headers/body | Abort request and preserve cancellation semantics |
| Provenance contains reserved markup/newlines | One untrusted envelope; no forged provenance lines |
| Invalid service origin or oversized token | Runtime and installer both reject readiness |
| Global config/profile cannot be resolved | Fail closed or require explicit config; no inherited-list loss |

SiYuan has no atomic conditional delete. A human mutation between the last check and deletion remains a race; document this limitation and do not claim transactional undo across services.

## 5. Good / Base / Bad Cases

- Good: a lost successful append is found by its reserved ID, verified once, and never sent again.
- Base: a retained synthetic rule creates a readable note; explicit search returns it with provenance, while ordinary conversation performs zero SiYuan searches.
- Bad: remove all whitespace to make Markdown comparisons pass. This would hide paragraph and code changes.
- Bad: interpret a missing/invalid judgment or a transport failure as permission to retain.
- Bad: scope only the child block, or apply `limit` after reading every historical publication.
- Good: a concurrent conflicting capture loses before any import/job is committed; a lost response replays the original receipt.

## 6. Required Verification

`bun run typecheck && bun test && bun run build && bun run lint`.

Preserve behavioral regressions in `tests/sources.test.ts`, `storage.test.ts`, `providers.test.ts`, `pipeline.test.ts`, and `writer.test.ts`. Assert fail-closed publication, full-segment atomicity, revision conflicts, no duplicate mutation, and preservation of changed human content. Do not pin incidental wording or source-code text.

`tests/memory.test.ts` covers capture transaction failure/competing payloads, native search parsing, parent-document authorization, changes during network waits, bounded reads, current human edits and withdrawn publications. Real-service acceptance exercises the actual search route, not only injected search fixtures.

Folder-flattening regressions must retain search and exact-receipt undo after an in-root document move, reject an out-of-root move or changed content, and reject a wrong path before the first receipt. Machine check with built-in `grep`: `path="src/siyuan/writer.ts;src/memory/search.ts"`, `pattern="const path =|operation\\.receipt|operation\\.path"`; inspect topic-to-title creation and receipt-gated path checks. Confirm the actual SiYuan tree and authenticated search after a production move.

`tests/omp-memory.test.ts` protects outbox/consumed durability, long and sibling-branch history, root/activation filtering, legacy state migration, corrupt-state isolation, bounded shutdown, explicit-tool authorization/provenance and zero automatic search/context mutation. `tests/setup-omp.test.ts` must load generated stubs, preserve global/project Hindsight and gate settings, merge inherited extensions, reject stale manifests, and prove gitignored discovery via explicit registration. Real persisted OMP must publish on normal turns without a search request, execute `siyuan_search` only after an explicit request, coexist with enabled Hindsight and expose accurate `/siyuan-memory` status.

After SiYuan serialization changes, run an isolated real read-back probe: heading/list normalization and inline-code boundary artifacts must compare equal; paragraph merging, changed code, and ordinary-text U+200B must compare unequal. Exercise create/append successful-write/lost-response plus SQLite reopen at least three times. Real browser/SiYuan inspection is required for UI/layout claims. Use synthetic fixtures and an isolated workspace, never unrestricted production data.

After changing judgment question boundaries, use alternating real-provider controls (at least three pairs) with identical candidate/evidence and only the relevant background variable changed. Include a positive control whose candidate evidence genuinely contains sensitive material. Record actual scores and model; a mocked response or prompt-string assertion does not demonstrate classification behavior.

Machine scope checks with the built-in `grep` tool (repeat at review/delivery):

- `path="src/providers;src/contracts/index.ts;src/pipeline/worker.ts"`, `pattern="deepseek-v4\\.1-flash|ollama\\.com|systemone|disposition !=="`.
- `path="src/storage;src/siyuan/writer.ts"`, `pattern="commitExtractionSegment|expectedAttributes|checkReceipt|write_outcome_unknown|UNIQUE"`.
- `path="src/memory;src/storage/store.ts"`, `pattern="ingestCapture|publicationsByOperations|MAX_SEARCH_OPERATIONS|currentDestination"`: inspect atomic acceptance, pre-read bounds and post-await authorization.
- `path="integrations/omp;scripts"`, `pattern="SESSION_STATE_VERSION|CONSUMED_LIMIT|siyuan_search|session_shutdown|ADAPTER_MANIFEST"`: inspect durable identity limits, explicit search, lifecycle completion and build freshness.
- `path="src;web;scripts;tests;integrations"`, `pattern="as any\\b|: any\\b|@ts-ignore|@ts-nocheck|innerHTML\\s*="`: no implementation matches.
- `path="src;web;integrations;scripts"`, `pattern="mental|Mental|recall|Recall|before_agent_start"`: only legacy-history retention/migration, envelope exclusion and explanatory no-hook comments may remain; no active mental generator/API/UI or automatic search hook.
- `path="integrations/omp;scripts/setup-omp.ts"`, `pattern="serviceOriginSchema|MAX_TOKEN_BYTES|pendingCorruption|capture_ack_mismatch|provenanceValue|signal.*aborted|config\\.yaml"`: inspect shared validation, acknowledgement identity, cancellation and inherited configuration resolution.
- `path="src/siyuan;tests/writer.test.ts"`, `pattern="getTextMarkKramdown|textMarks|native textmark"`: inspect read-only fallback, same-block identity, narrowly converted markup and preserved exact receipts.

## 7. Wrong vs Correct

```ts
// Wrong: absence after timeout is not permission to repeat an append.
// await appendBlock(markdown);
// catch { await appendBlock(markdown); }

// Correct: execute reuses the durable operation and reserved target.
await writer.execute(store.getOperation(operationId));
```

Root-cause record: literal Markdown comparison assumed the external serializer preserved spacing (cross-layer contract / coverage gap). Removing only IALs fixed one example but not headings adjacent to lists. The same-engine rendering comparison fixes the semantic boundary without weakening exact-receipt undo. See the task acceptance record for pre-fix failure and real post-fix evidence.

Follow-up serializer evidence: both native and fault smoke found U+200B adjacent to inline code. Equal `md2html` rendering alone was insufficient because that character survives rendering. The narrow delimiter-boundary normalization passed three real creates and two appends; changed code, ordinary-text U+200B and merged paragraphs still conflicted. Human-edited exact-receipt undo remained blocked.

Punctuation-padding root cause: SiYuan 3.8.4 uses Lute `ProtyleExportMdRenderer.renderTextMark` to export default-mode Kramdown; punctuation/symbol boundaries of strong/em/s gain spaces that are absent from stored text. `/api/lute/md2html` alone does not perform that export step. Three real Chinese/English writes reproduced the mismatch. Native `textmark` readback preserves the original content; its semantic HTML matched the approved plan without whitespace removal. Keep an end-to-end regression for verified first readback plus rejection of changed ordinary whitespace/text and exact undo after edits. Never reopen a terminal conflict or forge a receipt to repair an earlier false conflict.

### Judgment context contamination

- Root cause: cross-layer contract / implicit assumption. Published notes contain a local control-panel link; `SiyuanClient.related()` supplies those notes to Jev as background. The sensitivity question did not explicitly exclude background, so ordinary new knowledge inherited sensitivity from an existing navigation URL.
- Rejected fix: stripping every URL or host would hide actual candidate risks. Lowering thresholds would weaken the retention gate. Both address the symptom.
- Prevention: state the sensitivity data boundary in that question, retain all candidate/evidence bytes, and keep background available to the other judgment questions. Existing validation and policy gates are unchanged.
- Evidence: three alternating controls returned original sensitivity `0.63/0.60/0.59`, scoped sensitivity `0.10/0.10/0.11`, and genuinely sensitive candidate control `0.97/0.96/0.96` from `jev-1.13.0`. This is a scoped regression experiment, not a quality guarantee or broad benchmark.
- Review: repeat the real controls after changing the question or background format. Inspect the candidate/evidence channel as well as the background channel; do not test only a sanitized happy path.

### Adapter and installer boundary assumptions

- Root cause: cross-layer contracts and coverage gaps. A well-shaped acknowledgement was assumed to belong to the request; a stored payload string was assumed to be valid; only note bodies were treated as untrusted. The installer independently approximated runtime URL, token, profile and artifact rules.
- Prevention: shared runtime validators, request/receipt identity checks, semantic outbox validation, complete provenance neutralization and cancellation propagation. Regressions must exercise malformed persisted state, wrong acknowledgements, cancellation after headers, Windows containment and native configuration selection, not only happy-path mocks.
- Review gate: run the behavioral adapter/installer tests and native stub discovery after rebuilding. Keep production activation separate from isolated proof; do not replace the user's Hindsight or copy test queues into production.
