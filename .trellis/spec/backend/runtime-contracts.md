# Runtime, Provider, and Publication Contracts

## 1. Scope / Trigger

Required when changing `src/contracts`, ingestion, storage, providers, worker, HTTP routes, SiYuan integration, or deployment. This is a standalone Bun 1.3.14 service, not a patch to OMP or SiYuan. `src/contracts/index.ts` is the shared runtime-schema authority. Do not create parallel DTO definitions.

## 2. Signatures

- `normalizeImport(request: ImportRequest): Conversation`; `scanOmpRoot(root, projectId): AsyncGenerator<OmpScanItem>`.
- `Store.ingest(request, conversation)` preserves raw snapshots and returns `{ import, job, duplicate }`.
- `Store.commitExtractionSegment(job, candidates)` commits the entire segment and its **post-commit** cursor atomically. No network await inside a SQLite transaction.
- `OllamaClient.extract(...)`, `OllamaClient.reviseMental(...)`, `JevClient.judge(...)` validate external responses before returning typed results.
- `SiyuanWriter.plan(candidate, destination, source, appendDocumentId?)` returns an immutable operation plan; `execute(operation)` reconciles or sends it; `undo(operation)` deletes only a matching owned addition.
- `POST /api/candidates/:id/review` returns `{ candidateId, jobId }`, not a void response. `PUT /api/settings` returns the new `Settings` revision.

## 3. Contracts

### Sources and durable state

Source identity, source revision, message revision, job run, candidate lineage, and publication identity are distinct. SQL uniquely constrains `(sourceKey, revision)`, `(importId, policyRevision, promptVersion, run)`, and operation `contentKey`. Raw snapshots and normalized revision membership are separate. Locations do not rewrite message content identity; completeness warnings do affect source revision. IDs longer than the shared limit fail rather than being silently shortened.

Polling reads only direct regular JSONL files from an explicitly enabled server-allowed root. Refuse symlink roots and open children with `O_NOFOLLOW`. Read at most the checked file size, bounded by 64 MiB; growing files cannot trigger an unbounded read. Yield one file at a time, preserve per-file errors, and continue with siblings. Polling consumes newline-committed records; malformed complete lines are not treated as pending tails. Preserve parent IDs, missing parents, cycles, attachments, unknown metadata, and truncation as observable information.

`Job.extractionPlan` fingerprints the actual segmented/redacted input plus prompt version. A resume cannot change a non-null plan, rewind its cursor, regress completion, or commit only part of a segment. A replayed segment batch fails; no partial-subset success shortcut. Candidate and mental histories are append-only. `saveJob` updates an existing identity, never creates or moves one.

### Providers and policy

- Both generative roles use `GENERATION_MODEL = "deepseek-v4.1-flash"` at `https://ollama.com/api/chat`. Require a final assistant response with `done: true` and the approved model (`:cloud` suffix accepted). No local endpoint, fallback model, tools, or assumed remote JSON-schema enforcement.
- Validate final JSON locally, allow one bounded repair, and validate evidence quotes as exact substrings of the offered source messages. Segmentation never silently discards the end of a conversation.
- Jev uses `https://api.typesafe.ai/v1/systemone`, alias `jev-latest`; record the actual response model. Require all requested typed answers, known enum keys, valid distributions (sum tolerance `1e-6`), consistent argmax and weighted score, and the declared score legend.
- Retention requires validated `disposition: retain` plus policy gates. `action: review` vetoes retention. Append/duplicate recommendations require an owned related note. Archive never upgrades to retain.
- Record available provider usage even if later semantic validation fails. Never log keys or entire provider failure bodies.
- Mental sources must be same-project published/duplicate candidates with a retained judgment. Human context and conflicting/deleted/reclassified claims require a proposal; they are not silently replaced. Active revisions use CAS.

### SiYuan and environment

Persist a `planned` operation before a mutation. Reserve document/block IDs and freeze destination, source revision, `expectedAttributes`, Markdown, and content key. A receipt is first accepted only when verified, then immutable. Terminal conflict/undo states cannot revert to writable states.

Call `flushTransaction` before relying on SQL indexes; SQL absence alone does not establish block absence. `sent`/`uncertain` plus no visible block means **read-only reconciliation**, not permission to resend. Read-back checks notebook, managed root, document, ownership, and every expected source attribute.

SiYuan v3.8.4 normalizes Markdown and adds child IALs. First strip generated IALs **outside fenced code** only; if text differs, compare `SiyuanClient.renderMarkdown` outputs from `/api/lute/md2html`. Its HTML parser removes generated node IDs/timestamps only; paragraph structure, other attributes, content, and code whitespace remain significant. Do not execute or insert returned HTML into the UI. Undo uses the original exact Kramdown/attribute receipt, not semantic comparison.

`OLLAMA_API_KEY`, `TYPESAFE_API_KEY`, `SIYUAN_TOKEN` accept `_FILE` alternatives; direct values take precedence. `PUBLIC_ORIGIN` must match request host/origin. `SIYUAN_URL` is server-facing; optional `SIYUAN_PUBLIC_URL` is browser-facing and must not contain credentials. Compose publishes loopback-only and uses a persistent volume. One publisher per data directory; no distributed worker claims are implemented.

## 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| Missing key / malformed output / missing Jev answer | Visible failure; no write plan or default retention |
| Excluded source / fabricated quote / unknown mental source | Stop before unsafe cloud use or publication |
| Changed policy or extraction plan mid-run | Fail closed; explicit reprocessing required |
| Repeated raw source revision | Existing ingestion/job; no new publication |
| Uncertain write, block not yet found | `write_outcome_unknown`; no repeat mutation |
| Read-back identity/content mismatch | `siyuan_conflict`; no receipt accepted |
| Human change after receipt | Undo conflict; preserve content |
| SiYuan renderer unavailable | Retryable verification error, not successful publication |
| Concurrent setting/candidate/card edit | CAS conflict; retain submitted draft/history |

SiYuan has no atomic conditional delete. A human mutation between the last check and deletion remains a race; document this limitation and do not claim transactional undo across services.

## 5. Good / Base / Bad Cases

- Good: a lost successful append is found by its reserved ID, verified once, and never sent again.
- Base: a retained synthetic rule creates one note and a source-linked model card.
- Bad: remove all whitespace to make Markdown comparisons pass. This would hide paragraph and code changes.
- Bad: interpret a missing/invalid judgment or a transport failure as permission to retain.

## 6. Required Verification

`bun run typecheck && bun test && bun run build && bun run lint`.

Preserve behavioral regressions in `tests/sources.test.ts`, `storage.test.ts`, `providers.test.ts`, `pipeline.test.ts`, and `writer.test.ts`. Assert fail-closed publication, full-segment atomicity, revision conflicts, no duplicate mutation, and preservation of changed human content. Do not pin incidental wording or source-code text.

After SiYuan serialization changes, run an isolated real read-back probe: heading/list normalization must compare equal; paragraph merging and code-space changes must compare unequal. Exercise create/append successful-write/lost-response plus SQLite reopen at least three times. Real browser/SiYuan inspection is required for UI/layout claims. Use synthetic fixtures and an isolated workspace, never unrestricted production data.

Machine scope checks with the built-in `grep` tool (repeat at review/delivery):

- `path="src/providers;src/contracts/index.ts;src/pipeline/worker.ts"`, `pattern="deepseek-v4\\.1-flash|ollama\\.com|systemone|disposition !=="`.
- `path="src/storage;src/siyuan/writer.ts"`, `pattern="commitExtractionSegment|expectedAttributes|checkReceipt|write_outcome_unknown|UNIQUE"`.
- `path="src;web;scripts;tests"`, `pattern="as any\\b|: any\\b|@ts-ignore|@ts-nocheck|innerHTML\\s*="`: no implementation matches.

## 7. Wrong vs Correct

```ts
// Wrong: absence after timeout is not permission to repeat an append.
// await appendBlock(markdown);
// catch { await appendBlock(markdown); }

// Correct: execute reuses the durable operation and reserved target.
await writer.execute(store.getOperation(operationId));
```

Root-cause record: literal Markdown comparison assumed the external serializer preserved spacing (cross-layer contract / coverage gap). Removing only IALs fixed one example but not headings adjacent to lists. The same-engine rendering comparison fixes the semantic boundary without weakening exact-receipt undo. See the task acceptance record for pre-fix failure and real post-fix evidence.
