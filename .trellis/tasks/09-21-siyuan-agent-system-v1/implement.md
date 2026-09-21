# Implementation plan

## Approval boundary

Status: implementation and AC1–AC11 verified. The user approved implementation with `可以` and the scoped Phase 3.4 local commit with `提交本輪功能`.
`task.py start .trellis/tasks/09-21-siyuan-agent-system-v1` succeeded on 2026-09-21;
the task status changed from planning to in_progress before provider probes and code.

## Change boundary

The gap is an absent product, not a defect in OMP or SiYuan. Add a standalone
application in this repository. Do not patch either host, the user's global model
configuration, existing credential stores, or the production SiYuan workspace.

Expected new areas: package/build configuration; `src/contracts`, `src/storage`,
`src/sources`, `src/providers`, `src/pipeline`, `src/siyuan`, `src/server`; `web`;
container/deployment configuration; narrowly justified regression fixtures/tests.
Update ignore rules for runtime data and secrets. Keep the original source request,
current PRD, and approved scope linked rather than silently narrowing the release.

## Required workflow and guidelines

- Before implementation: `trellis-before-dev`, backend/frontend indexes, and shared
  cross-layer/code-reuse guides. Current package guidelines are unfilled templates.
- During implementation: one authoritative runtime contract owner. Frontend,
  worker, providers, and source adapters consume that owner instead of recasting
  untyped objects independently.
- If agents are used: verify role/model cards first; include the actual AGENTS and
  applicable spec-index text, file ownership, DTO contracts, and verification
  patterns in work orders. No agent may inspect real credentials or another
  agent's transcripts; give synthetic fixtures instead. Agents skip formatters,
  lint, builds, and suites while concurrent work is active.
- Integration owner runs final checks once, using `trellis-check`.
- After working behavior is proven: `trellis-update-spec` records actual contracts,
  tested API limitations, and code-backed conventions; complete bootstrap work
  only if its own acceptance criteria have actually been met.
- On formal interruption during implementation: `trellis-paused-work`.

## Ordered implementation

### 1. Prove the real external contracts

- Inspect only credential presence; never print key values or whole config files.
- Use the requested native Ollama Cloud model `deepseek-v4.1-flash` with a synthetic
  conversation. Confirm finalized content, JSON parsing, repair behavior, errors,
  and actual usage fields. Do not rely on cloud structured-output enforcement.
- Exercise Jev on synthetic candidates with the current documented typed contract.
  Validate question coverage, enums, distributions, and unavailable-provider paths.
- Start a separate SiYuan v3.8.4 test workspace using an isolated data volume and
  port. Confirm caller-selected IDs, ID-preserving append representation, attribute
  read-back, and duplicate/retry outcomes before choosing the writer's final format.
- Keep actual API failures visible. An unavailable requested model is a missing
  prerequisite, not permission to substitute another model or return fake output.

### 2. Establish the shared contracts and durable core

- Define normalized source records, revisions, candidate schemas, Jev decisions,
  mental cards, write plans/receipts, API responses, and error envelopes.
- Implement SQLite migrations and transactions plus persistent raw-object storage.
- Enforce unique source revisions and operation IDs at the database boundary.
- Implement durable job transitions, bounded retry scheduling, restart recovery,
  and write reconciliation. Do not hold database transactions over network calls.
- Keep model/policy/prompt revisions separate from source and publication identity.

### 3. Connect acquisition and the model pipeline

- Implement generic JSON ingestion plus text/Markdown input with missing metadata.
- Implement opt-in OMP polling for configured read-only roots; complete-line parsing,
  branch identity, old-record changes, source exclusions, and attachment status.
- Add evidence-preserving extraction using the requested cloud model.
- Add restricted-scope related-note retrieval and Jev's retention/routing gate.
- Add archive/review paths and correction/reprocessing without duplicate outputs.
- Add source-linked mental-card proposals/revisions with manual-edit precedence.

### 4. Implement the real SiYuan writer

- Persist reserved IDs and all intended steps before the first write.
- Create notes or append owned additions in the selected managed roots.
- Reconcile ambiguous responses using identity, ownership, and content; never
  blindly replay append or treat every already-exists error as successful work.
- Read back writes and expose actual SiYuan links and operation receipts.
- Implement owned-operation undo and explicit conflict handling. Do not restore
  old whole documents or rewrite arbitrary human blocks.

### 5. Deliver the control panel and deployment

- Implement real API-backed overview, import/source setup, evidence/candidate
  detail, review/correction/retry, mental cards, settings, and operation history.
- Use Traditional Chinese UI text and safe Markdown rendering.
- Keep provider secrets server-side; expose configuration-presence booleans only.
- Package backend, worker, and frontend in one Docker image with a persistent
  volume. Default port publication is loopback-only.
- Provide an example environment file with placeholders, never copied live keys.

### 6. Prove the release end to end

- Use real cloud providers with synthetic fixtures; use the isolated SiYuan
  workspace for writes and failure injection.
- Exercise the actual browser UI and inspect the actual SiYuan note layout.
- Demonstrate repeated import, changed source revision, review, retry after restart,
  lost write response, and safe undo/conflict behavior.
- Record exactly what passed and what was not exercised. Do not report model
  quality, latency, or costs without the measurements that produced those claims.

## Validation command contract

The product scripts below are implementation deliverables, not commands that
already exist. Keep the resulting package scripts aligned with these names:

- `bun run typecheck`: backend/frontend shared contract type check.
- `bun run lint`: code-quality check after integration.
- `bun test`: only earned behavior/edge-case regression tests.
- `bun run build`: build the web assets and production application.
- `docker compose config --quiet`: deployment configuration validation.
- `docker compose up --build -d`: actual isolated/local deployment smoke test.

Use a disposable smoke runner to send synthetic input, poll jobs, and verify real
SiYuan IDs/content. Remove throwaway scaffolding after its evidence is recorded.
Do not make passing mocks the end-to-end proof.

Keep permanent tests where plausible bugs are costly: rewritten/partial OMP
records, evidence-reference validation, missing Jev answers, duplicate/revised
imports, uncertain-write recovery, and mental/undo revision conflicts. Test
observable outcomes, not source text, field forwarding, or incidental wording.

Machine-checkable scope review using the built-in grep tool:

- Path `src/providers`: pattern `deepseek-v4\\.1-flash|ollama\\.com|systemone`;
  verify the intended provider boundaries and absence of implicit alternatives.
- Path `src/contracts;src/pipeline`: locate the actual disposition schema and its
  publication gate; verify invalid/unknown results cannot reach the writer.
- Paths chosen by the implementation for source identity and operations: verify
  unique constraints, persisted plan-before-send, and reconciliation ownership.
- A sanitized in-memory credential scan reports paths/rule names only, never
  matching secret values. Do not grep credential files or real transcripts.

## Coverage and completion

- Steps 1/3 cover AC3-AC6 and AC11.
- Steps 2/3 cover AC1-AC3, AC5, and AC8.
- Step 4 covers AC2 and AC7-AC9.
- Steps 5/6 cover AC1, AC7, AC10, and the integrated behavior of all criteria.

Before delivery, map every AC to a concrete command or interactive observation.
After successful smoke verification, update operational documentation and the
Trellis specs with demonstrated behavior, remove temporary experiment artifacts,
and review the completed diff. Do not archive or report a finished first release
while any promised acceptance criterion remains unverified.

## Execution record

- Verified: Jev synthetic preflight returned HTTP 200, actual model `jev-1.13.0`;
  choice, three-level score, probability distributions, noul, and usage were returned.
- Verified: isolated Docker `b3log/siyuan:v3.8.4`, loopback port 16806, separate
  `.trellis/.runtime/validation/siyuan` workspace. No production note writes.
- Verified: caller-selected document IDs and owned superblock IDs survive both
  `createDocWithMd` and `appendBlock` with `dataType: markdown`. Inline `custom-`
  ownership properties survive read-back. Thus the writer uses Markdown plus a
  reserved superblock IAL; it does not need an unverified Markdown-to-DOM endpoint.
- Verified: user-supplied Ollama and Jev credentials are stored only in ignored
  mode-0600 `.env`. Real extraction returned `deepseek-v4.1-flash`; real Jev returned
  `jev-1.13.0`. Synthetic provider evidence is under ignored validation storage.
  Real mental generation also returned `deepseek-v4.1-flash`,
  `extract-1+mental-1`, and source-linked decisions/constraints.
  Integrated publication was subsequently verified; see the acceptance table below.
- Verified: `.env`, `.env.local`, and `secrets/test.key` are ignored by Git;
  Docker context also excludes environment files, secrets, runtime data, and logs.
- Implementation complete: shared contracts, durable storage, source adapters,
  providers, worker, HTTP API, SiYuan writer, control panel, and container deployment.
- `bun .trellis/.runtime/validation/cloud-cases.ts`: real generated port-validation
  rule → retain (0.96); one-time lunch reminder → archive-only (0.99).
  An unverified deletion guess was also archive-only (0.46), not review.
  `bun .trellis/.runtime/validation/cloud-cases.ts cloud-conflict review-conflict`:
  contradictory port limits → review (0.75). These are individual functional
  samples, not a model-quality or latency benchmark; default thresholds unchanged.
- `bun .trellis/.runtime/validation/cloud-mental.ts`: real mental role generated
  source-linked project decisions/constraints from the Jev-retained synthetic rule.
  This is role preflight only, not proof that the candidate was published.
- A transient Jev network failure occurred during the first three-case run.
  A separate real request returned HTTP 200 without redirect; the subsequent
  complete run succeeded. No production endpoint or proxy settings were changed.

## Final acceptance record — 2026-09-21

All checks used synthetic conversations and the isolated workspace. Production
SiYuan and the user's live OMP history were not read or modified. No retention
threshold was lowered to obtain a passing result. Provider outcomes below are
individual functional observations, not statistical quality or cost claims.

| AC | Result and concrete evidence |
| --- | --- |
| AC1 | PASS — Compose built and served the real panel at `http://127.0.0.1:18787`; notebook `20260921211444-o3ikhfa`. Browser-imported generic JSON and OMP JSONL created persisted jobs `46fce5c4-703c-4cdb-8561-3d224668bf4c` and `99888511-350a-4159-a25d-1b41cf811a71`. Opt-in read-only `/sources/omp` polling also reported healthy. |
| AC2 | PASS — Three browser submissions of the same generic revision returned one import `a5d7d976-209b-4818-b7bb-9947eea21091`, one job, and duplicate flags `false,true,true`. The changed source returned revision `ebbd05ddcf7f62f7b6f50dde3f29a7daf8fdb5f7f98a96c57cf8dc654731845d` and a new job. The corrected retained candidate produced exactly one verified application operation; restart preserved its ID. |
| AC3 | PASS — Expanded browser evidence resolved `retain-1` to `messages/0`, exact original text, and missing timestamp warnings. A disposable real source-adapter run read 8,100,249 bytes into 676 segments and preserved the final decision; overlapping redaction terms did not leak a suffix, and a 513-character source ID was rejected. Source regressions cover partial tails, malformed committed records, missing metadata, and branch identities. |
| AC4 | PASS — Real Ollama/Jev processing produced archive-only lunch candidate `e4048be1…` (0.99) and review conflict candidate `c77ec39d…` (0.59). The initial rule candidate was review (0.59); a browser correction of its title/uncertainty wording was independently rejudged retain (0.99), candidate `350d1cf1…`, and published. The original uncertainty/review outcomes remain recorded rather than hidden. |
| AC5 | PASS — `providers.test.ts` rejects missing answers, malformed JSON, wrong enums/types, invalid probability sums/argmax/weighted scores, and unavailable credentials. `pipeline.test.ts` verifies invalid generation/judgment and exhausted transport retries produce no write plan. A real isolated SiYuan timeout at `judging` left operation count unchanged at 2; after browser retry the lunch job became archive-only, still with 2 operations. Invalid model payload scenarios use deterministic fault fixtures, not claims of deliberately corrupting a real provider. |
| AC6 | PASS — The published retained rule produced a real model-authored source-linked mental revision 1. Browser manual editing created human revision 2 with the `人工確認：` text. Subsequent unresolved source updates remained review and did not overwrite this revision. Model-over-human proposal and claim/category/source conflicts are additionally covered by worker regressions. |
| AC7 | PASS — Application create operation `b18cf2b5…` verified document `20260921150511-c812f8e` under `/AcceptanceAppV2/validation-v2`. Browser opened the actual note and visually inspected title, bullets, source revision, original quote, and panel link. A separate writer-transport append to `20260921143847-077b6d7` verified block `20260921151431-48c238b`; the screenshot shows the original human addition followed by the new owned section. This transport fixture's synthetic display title was not separately reclassified by Jev. |
| AC8 | PASS — Final `writer-smoke.ts run4`, using a separate `writer-state4` SQLite directory, passed 3/3 trials: real create and append succeeded, their replies were deliberately dropped, the store was closed/reopened, and recovery sent each mutation only once; each appended ID had exactly one SQL row. Compose rebuild/restart also preserved all prior application job and operation IDs. |
| AC9 | PASS — The same 3/3 real trials deleted the untouched owned append and confirmed absence; a separately modified owned block caused conflict and preserved `人工新增：請保留這段。`. No whole document was deleted. |
| AC10 | PASS — Browser import, correction/new-candidate navigation, manual mental edit, source setup, published-note opening, and retry completed. Pausing only `siyuan-v1-validation` produced `siyuan_timeout`; unpause plus browser `POST /api/jobs/919ebb5e-f6a7-4827-8207-8e3e5c42f504/retry` returned 200 and recovered to archive-only. Two source-setting saves returned revisions 3 and 4. Initial overview failure recovered all five surfaces with exactly one visible; notebook retry preserved typed input; cross-tab revision changes preserved the dirty draft. A deliberately stale detail response then refreshed to the real published version. In-memory scanning of 77 delivery files plus overview/candidate/notebook/API bundle found no actual provider/workspace credential values. |
| AC11 | PASS — Application usage audit reports `deepseek-v4.1-flash` for both `extract-1` and `extract-1+mental-1`; real Jev reports `jev-1.13.0`. Mental generation reported 817 prompt / 1290 evaluation tokens. These are provider-reported usage fields, not a cost estimate. |

### Commands and preserved evidence

- `bun run format && bun run typecheck && bun test && bun run build && bun run lint`:
  117 tests passed, 0 failed, 545 assertions across five files; typecheck/build/lint passed.
- Actual Compose launch: `docker compose --env-file .env --env-file .trellis/.runtime/validation/test.env -f compose.yaml -f .trellis/.runtime/validation/compose.test.yaml -p siyuan-agent-validation up --build`, managed through `hub`; readiness was observed, not inferred from process creation.
- `bun --env-file .trellis/.runtime/validation/test.env .trellis/.runtime/validation/writer-smoke.ts run4`, with `DATA_DIR=.trellis/.runtime/validation/writer-state4` and `SIYUAN_URL=http://127.0.0.1:16806`: 3/3 final transport/recovery/undo trials passed.
- `semantic-probe.ts`: 3/3 real same-engine read-back comparisons matched; paragraph-boundary and code-whitespace changes remained unequal.
- `source-boundaries.ts`: 8,100,249 bytes, 676 segments, final decision preserved, longest-first overlapping redaction and overlong-ID rejection passed.
- Disposable runners are removed after recording their results. Sanitized local evidence remains under ignored `.trellis/.runtime/validation/`: `app-observations.json`, `writer-observations.json`, `semantic-observations.json`, `append-visual.json`, cloud preflight JSON, and screenshots `panel-overview.webp`, `note-references.webp`, `append-preserves-human.webp`.

### Review fixes and root causes

- Earlier read-only reviews covered source bounds/identity, persistent job/candidate/operation invariants, provider validation and usage, UI draft/revision handling, and ownership/undo boundaries. Main integrated the corrections and owned formatting.
- Cross-layer/implicit-assumption bug: removing SiYuan-generated IALs did not account for a blank line inserted between a heading and list. The initial application attempt correctly stopped as conflict. Real `/api/lute/md2html` probing established same-engine semantic comparison; paragraph/code changes remain detectable. That historical failed fixture is intentionally still visible in the test panel.
- Browser lifecycle/coverage gaps: authored `display` overrode `hidden`; initial error detached surfaces; notebook completion rebuilt drafts; detail loaded before overview and ignored later versions. Actual browser fault/recovery and dirty-state scenarios verified the fixes.
- Phase 3.3 complete: backend `runtime-contracts.md` and frontend `control-panel.md`, linked from their indexes, now define executable contracts and machine-checkable review patterns. Full template bootstrap is not claimed. This repository has no Trellis template-distribution tree to synchronize.
- Operational documentation is `README.md`; deployment source defaults remain conservative. No unapproved production connection, cloud model substitution, or proxy change was made.

### Remaining operational boundaries

No distributed publishers, authentication service, broad filesystem discovery, or attachment inference is implied. Raw data is not encrypted at rest. Unknown write outcomes remain read-only retries; terminal conflicts need human inspection. SiYuan has no atomic conditional delete, so concurrent editing during the final undo check/delete remains a documented race. Provider latency/quality/cost is not benchmarked.

The user approved one local work commit: `feat: add SiYuan knowledge pipeline and review panel`.
It includes the application, tests, examples, build/deployment files, README, task
artifacts, and backend/frontend specs. Pre-existing `.omp` role/configuration
changes, credentials, and runtime data are excluded. No push or task archive is authorized.
