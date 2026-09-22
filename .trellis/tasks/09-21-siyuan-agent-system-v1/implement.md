# Implementation plan

## Current handoff — formally paused, 2026-09-22

> RESUME: maintenance-intake — read this handoff and the latest Human-first PRD/design sections, then take the next maintainer's concrete change request. No unfinished implementation is being handed off.

- [x] verified: human-facing background publication, explicit `siyuan_search`, Hindsight coexistence, no automatic SiYuan recall or parallel mental model.
- [x] verified: formal deployment, first production note, isolated-test retirement and project/topic/article hierarchy without a content-kind directory.
- [x] verified: 211 tests / 1,271 assertions, typecheck/build/lint; actual SiYuan content, moved-note search and browser hierarchy.
- Paused by user request, not archived or marked completed. Trellis intentionally retains `in_progress`; `task.json.meta.paused` and this RESUME anchor carry the pause. The separate guideline-bootstrap task is not included in this pause.
- Checkpoint branch: `task/siyuan-agent-system-v1`. User authorized committing this workspace, pushing the existing `chrisro320/siyuan_agent_system` remote and making it public. This repository is independent, not a GitHub fork.

### Read first and preserve

1. Latest **Human-first correction** in `prd.md` and **Human-first cutover** in `design.md` override historical automatic-recall/mental-model plans. Earlier execution records are history, not work to redo.
2. `.trellis/spec/backend/runtime-contracts.md` and `.trellis/spec/frontend/control-panel.md` are the executable contracts. Their index files route to them; other template specs are not completed guidelines.
3. Core ownership: `src/contracts` shared schemas; `src/sources` input; `src/storage` durable state; `src/providers` extraction/Jev; `src/pipeline/worker.ts` processing; `src/siyuan` writes; `src/memory` capture/search; `integrations/omp` native adapter; `web` panel; `scripts/setup-omp.ts` opt-in installation.
4. Keep Hindsight independent. Do not reintroduce automatic SiYuan recall, mental cards, historical backfill or collection from other projects. No OMP/SiYuan host-source patch is required.
5. Never loosen Jev policy, remove meaningful whitespace, reset a terminal conflict, rewrite a frozen plan/receipt, or blindly retry an uncertain external write. In-root note moves preserve IDs and receipts; first publication still verifies the exact planned path.
6. Generation is cloud-based `deepseek-v4.1-flash`; Jev is the publication gate. The actual source-backed controls and serializer evidence are recorded below and in backend specs.

### Environment and verification for the next LLM

- Public checkout contains no credentials, runtime DB, raw session evidence or machine-local adapter activation. Use `.env.example`, provide your own secrets, run `bun install --frozen-lockfile`, then follow README. The ignored `.omp/config.yml` remains local; agent cards retain portable role aliases.
- This workstation's existing production panel is `http://127.0.0.1:18787`, native SiYuan is `http://127.0.0.1:6806`. Notebook **探索未至之境**, managed root `/自動知識`, project `siyuan-agent-system`. Do not provision a second publisher against the same data directory.
- Production container/volume and ignored `.trellis/.runtime/production/` configuration remain intact. The old 16806 isolated environment was deliberately retired, not a service to restart.
- Local evidence resides under ignored `.trellis/.runtime/human-first/`; public maintainers do not receive those files. Reproduce external-write tests in their own isolated notebook/workspace, never the production notebook.
- Before delivering code changes: `bun run typecheck && bun test && bun run build && bun run lint`, relevant machine checks in specs, and the actual affected UI/CLI/provider path. Unit tests alone do not prove native serializer or provider behavior.
- Unknown future requirements remain unapproved. Start with the next user's request rather than inventing a new feature backlog or redoing this completed baseline.

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

## Hands-free integration execution plan — 2026-09-21

Status: implementation approved. The user selected `實作並啟用本專案` after the
concrete hands-free planning summary; `task.py start` succeeded. This increment
implements R10/R11 and AC12–AC19. Verify the complete synthetic path first, then
activate the approved new-session-only project scope; no historical backfill.

### Minimal change boundary

- Extend shared contracts and service routes for automatic capture and bounded,
  project-scoped recall. Reuse durable ingestion, Jev, existing publications,
  mental revisions, and SiYuan read-back.
- Add a separately installable OMP adapter in this repository. Do not patch OMP
  core, register a second model-specific tool surface, or scrape chat websites.
- Add only the persistence required for capture acknowledgement/replay and stable
  recall injection. Never use the live OMP database as a test sandbox.
- Extend existing status/settings surfaces only where needed to inspect enabled
  sources and failures; do not make the panel a required per-conversation step.
- Keep existing `.omp` role bindings intact. Any approved project-level memory
  cutover must preserve unrelated keys and leave other projects untouched.

### Ordered work after approval

1. Finalize shared adapter/API contracts from the inspected OMP event ordering.
   Capture and recall must agree on project identity, source IDs, activation
   boundaries, acknowledgement, provenance, and injected-context exclusion.
2. Implement durable automatic capture using existing normalization and ingestion.
   Acknowledgement follows durable acceptance, never only an HTTP send attempt.
3. Implement scoped recall from current, eligible SiYuan content and active
   confirmed context. Enforce output bounds and fail closed on authorization.
4. Implement the OMP adapter, local delivery state, session/branch filtering,
   bounded pre-turn recall, and append-only contextual injection.
5. Run actual sandboxed OMP + real cloud + isolated SiYuan end-to-end scenarios.
   Three independent repetitions for lost acknowledgements/restart/deduplication;
   include outage, cross-project isolation, human edit, undo, resume, and feedback
   loop scenarios. Inspect outgoing context, not only callback mocks.
6. Main runs typecheck, behavior tests, build, lint, Compose validation, and the
   existing spec grep gates once after integration. A read-only reviewer checks
   the complete change; the implementation owner handles any fixes.
7. After successful smoke verification, update the executable specs and usage
   documentation; remove disposable runners. Obtain separate local-commit
   approval. Do not push or archive implicitly.

### Required skills and release gates

Use `trellis-before-dev`, the existing backend/frontend contracts, cross-layer
and reuse guides before implementation. Use `trellis-check` for independent
review and `trellis-update-spec` after exercised behavior is proven. Use
`trellis-break-loop` if an integration defect exposes a recurring failure class.

Curate `implement.jsonl` / `check.jsonl` with the concrete integration research.
Read actual spec/AGENTS text into work orders rather than paraphrasing it. Child
workers skip formatting, lint, builds, and tests while edits are concurrent.

### Activation and rollback boundary

Suggested initial scope is new root conversations for this project and the
existing isolated SiYuan notebook only. No historical backfill, no unrelated
project scan, no production notebook write, and no Hindsight data deletion.
Disable the adapter to stop future capture/recall while preserving delivery and
publication records. Never use wholesale database restoration as normal rollback.

### Hands-free verification checkpoint — 2026-09-22

- Initial integration: 157 tests passed, 0 failed, 883 assertions; typecheck,
  web/OMP builds and lint passed. The actual production-dependency Docker image
  built and both isolated services reached readiness. Evidence:
  `.trellis/.runtime/handsfree/checks.json`.
- Real OMP 18.2.3 used the approved cloud model in a separate profile. Session
  `01a0c766-61e6-7000-8ea7-6e96b95807c5` supplied a synthetic export decision;
  session `01a0c767-628e-7000-8e6b-78cf7ff0ffa8` received its note and provenance
  in the outgoing payload and answered `BLUE-7319` without that code in the new
  question. Note `20260922043651-0d4c118` is inside `/HandsFreeValidation`.
- This first smoke is not the final AC12 pass: one-shot `omp -p` left durable
  pending data until the same session was resumed. A bounded shutdown drain
  must be implemented and the no-manual-resume path re-exercised.
- Native evidence also covers a real subagent exclusion, unrelated-project
  isolation, service outage, three persisted retries, explicit empty anchors,
  and matching tool-follow-up/resume prefix hashes. Detailed scope and limits:
  `.trellis/.runtime/handsfree/NativeMemorySmoke/evidence/native-e2e-evidence.json`.
- An offline experiment composed the actual Trellis and memory extensions in
  both orders. Nonempty recall and Trellis context were present; prior user
  hashes stayed identical through continuation, resume and the next user turn.
  The recall transport was controlled in this experiment, not a real-provider
  claim. Evidence: `.trellis/.runtime/handsfree/trellis-coexistence.json`.
- Independent read-only reviews found capture receipt transaction gaps,
  parent-document authorization and await-time revocation gaps, unbounded
  recall reads, pending/history-watermark and corrupt-state hazards, shutdown
  delivery loss, provenance/budget loss, and stale/misdirected build artifacts.
  Three separate owners are correcting backend, adapter and deployment; Main
  will rebuild, re-exercise affected paths and request follow-up review.
- The real project has not yet been activated. Its setup dry-run preserves task
  role bindings; fingerprints of global settings and role files are saved in
  `.trellis/.runtime/handsfree/activation-baseline.json` for the final scope check.

### Integrated checks and final-smoke corrections — 2026-09-22

- Main completed `bun run format`, `bun run typecheck`, `bun test`,
  `bun run build`, and `bun run lint`: 184 tests passed, 0 failed; all commands
  passed. The unsafe-type/HTML-injection grep returned no matches. Evidence:
  `.trellis/.runtime/handsfree/final-checks.json`.
- Bun declaration dependency now matches the installed 1.3.14 runtime, including
  the supported build metafile API. Both deployment surfaces build in staging;
  the manifest covers transitive local sources plus package/lock contents.
  The rebuilt Docker service reached readiness; project setup remains dry-run.
- OMP state is schema 2. Consumed revision identity is a non-evicting ledger,
  rather than the previous lossy receipt/window cursor. New baseline state
  prevents fork/resume history from being captured or newly injected.
- Native final smoke observed three single-shot persisted `omp -p` sessions
  exiting with `accepted=2`, `pending=0`, without a manual resume. The suspected
  detached-handler race was not reproduced; reviewers also confirmed that the
  handler persists capture before its first await.
- Real Jev controls identified background contamination by a generated local
  control-panel URL. Main restricted only the sensitivity question to the
  proposed candidate/evidence/cited messages. No input URLs were stripped and
  no policy threshold changed. Three alternating controls returned original
  `0.63/0.60/0.59`, scoped `0.10/0.10/0.11`, and a genuinely sensitive candidate
  `0.97/0.96/0.96`. Evidence:
  `.trellis/.runtime/handsfree/jev-scope-probe.json`; executable contract updated.
- Final real smoke found SiYuan-inserted U+200B before inline code causing a
  false write conflict. Both native/fault agents reproduced it independently.
  A dedicated writer owner is fixing the serializer boundary with real
  positive/negative controls; original terminal-conflict records stay intact.
- Final read-only reviewers additionally identified missing duplicate-candidate
  mental references, non-durable anchor injection after disk failure, baseline
  ledger overflow failing open, clipped mental source IDs, and trimming of raw
  dialogue. Three independent owners are fixing these bounded issues. No real
  project activation, commit, push or archive has occurred.

### Final hands-free acceptance — 2026-09-22

- Integrated validation after the three targeted fixes: **193 tests passed,
  0 failed, 1,137 assertions**; `bun run typecheck`, `bun run build`, and
  `bun run lint` all exited 0. Main fixed one optional-key type mismatch in a
  newly added regression assertion. Log: runtime `handsfree/closing-checks.json`.
- AC12/13: the installed project stub loaded the actual bundled adapter in
  persisted native OMP 18.2.3 sessions. Session `01a0c7ad-c129` captured a normal
  synthetic conversation with no manual import/retain, reached Jev retain 0.89,
  and published document `20260922055739-02834f2`. Independent new sessions
  recalled `FINAL-4826` from an ordinary blind question, with SiYuan and original
  source references in the outgoing provider context.
- After the final build and Docker restart, Main repeated the blind native
  question: session `01a0c7ba-cb60` answered `FINAL-4826`; outgoing context had one
  memory-bearing user message; accepted=2, pending=0, degraded=null.
  Evidence: runtime `handsfree/post-build-native.json`.
- AC14/19 isolation: old activation-boundary sessions, nonpersisted sessions and
  actual subagents were excluded; cross-project recall returned no foreign note.
  Schema-2 regressions additionally cover baseline overflow, sibling histories,
  raw whitespace revisions, and corrupt state without historical backfill.
- AC15/16: real proxy lost-response and outage/recovery trials preserved pending
  work and reused capture IDs. Three replays returned the same import/job with
  one logical publication. Independent SQLite processes proved a same-ID
  different-payload race produces one accepted result and one 409; two SIGKILL
  windows left no executable job outside its receipt.
- AC17: real owned-block human edits returned current text with `edited=true`
  and omitted stale derived claims. Parent-document project tampering excluded
  its children until restored. Undo of a separate untouched addition removed
  only that block; its document and another valid note remained.
- AC18: real retries, tool continuations and resumes kept existing user prefixes
  unchanged; captures excluded recall envelopes. Main reran the actual Trellis
  extension together with the latest memory adapter in both load orders:
  continuation/resume/next-turn hashes remained identical in each run.
- Native `/siyuan-memory` was exercised through real RPC extension-command
  dispatch: normal status and HTTP-502 pending/degraded status were both visible.
- Serializer regression: three real creates and two appends with inline code
  now verified. Changed code, ordinary-text U+200B and paragraph merging still
  conflicted; human-edited exact-receipt undo was blocked. Previous conflict
  operations were preserved, not reset or force-retried.
- Durable-context regression: a failed local save never sends the unpersisted
  snapshot, retains already-durable prefixes, and cannot late-fill the failed
  turn after recovery/restart. Mental clipping retains all source IDs.
- Evidence directories: `NativeFinalSmoke/evidence/native-final-evidence.json`,
  `FaultFinalSmoke/evidence.json`, `SiyuanInlineFix/writer-e2e.json`,
  `MemoryDurabilityFix/evidence/omp-durability-evidence.json`,
  `ReceiptLinkFix/evidence/receipt-link-fix-evidence.json`, all under
  `.trellis/.runtime/handsfree/`.
- The native verifier's additional SQL-empty observation was not established
  as a persistent fault: Main queried the published document via `/api/query/sql`
  and received its correct id/root_id/notebook/type row. Authorization does not
  use SQL absence as proof of deletion.
- Real Jev results remain variable: the fault trial recorded 27 candidates,
  with three published, one retained but stopped by the pre-fix serializer
  conflict, and the remainder review/archive-only. This is functional
  acceptance, not a retention-rate or model-quality guarantee.
- Required Phase 3.3 completed: updated backend runtime contracts/index for
  capture atomicity, duplicate-source pairing, current authorization, immutable
  durable context, raw evidence, source budgets, build/installation, Jev
  boundaries and SiYuan serializer artifacts. README now documents automatic
  setup/status/disable and limitations. No new spec-template distribution exists.

### Final serializer review closure

- Independent `MemoryPatchReview` caught a regression in the follow-up
  quoted-fence change: comparing raw prefixes rejected legal indentation
  differences. Main changed the fence identity to quote depth plus marker.
  The reviewer then returned **PASS**, including duplicate-source pairing and
  exact-receipt undo. All implementation owners stopped editing before the
  final integration run.
- Real final writer probe: **five creates plus two appends verified**; three
  negative controls remained conflicts, no unexpected outcomes, and all five
  probe documents were removed. Evidence:
  `SiyuanInlineFix/writer-e2e-final.json` under the same private runtime.
- Latest complete checks: **194 passed, 0 failed, 1,144 assertions**;
  typecheck/build/lint exited 0. Evidence: `handsfree/release-checks.json`.
  Earlier 193-test evidence above remains a historical checkpoint, not the
  final count.
- The global OMP configuration changed externally between the initial snapshot
  and activation preparation. Main did not overwrite it: the current global
  configuration is the installation baseline, captured in
  `handsfree/activation-immediate-baseline.json`. Project task bindings and all
  three role-card fingerprints still match the original baseline.

### Final context boundary closure and activation check

- `AnchorPatchReview` found two additional edge cases: an earlier long note
  consumed a later short claim's body budget, and baseline overflow could be
  bypassed by same-session `/tree` navigation to a short leaf.
- Main reproduced both in behavioral regressions (2 failing tests), then
  reserved complete later headers plus minimum body slices and acquired the
  baseline from all persisted session entries. Overflow remains sticky for the
  session. Both regressions passed; the reviewer returned **PASS**.
- Latest full check now supersedes the previous count: **195 passed, 0 failed,
  1,149 assertions**, typecheck/build/lint all exit 0. Both Trellis extension
  load orders and actual disk-failure handler smoke were rerun successfully.
- Latest native session `01a0c7cc-fad8` received the note on the outgoing user
  context and ended accepted=2/pending=0/degraded=null. This time the model saw
  `FINAL-4826` but declined certainty without tools to verify its source; earlier
  blind sessions answered it directly. Recall delivery is verified; consistent
  model acceptance is not guaranteed and the untrusted-data boundary was not
  weakened. Evidence: `handsfree/activation-build-smoke.json`.
- Approved destination was added at settings revision 7:
  `siyuan-agent-system` → isolated notebook `20260921211444-o3ikhfa`, `/HandsFree`.
  The first installer apply set `activatedAt=2026-09-22T06:29:41.803Z`, preserving
  existing task roles and the immediate global configuration hash.
- Real-repository RPC caught a deployment gap that the external sandbox did not:
  OMP native extension discovery respects `.gitignore`, which excludes the
  generated stub. `--status` reported readiness while `/siyuan-memory` was not
  registered. No successful live activation is claimed at this checkpoint.
  Installer and native-probe owners are closing this with explicit extension
  registration while retaining global/local lists and the same activation time.

### Approved project activated — 2026-09-22

- Installer now explicitly registers the gitignored stub and preserves inherited
  and local extension lists. Reapply kept
  `activatedAt=2026-09-22T06:29:41.803Z`; no cursor/state reset occurred.
- Main's final integrated checks after this fix: **199 passed, 0 failed,
  1,174 assertions**; typecheck/build/lint exit 0. Final log:
  `.trellis/.runtime/handsfree/release-checks.json`.
- **Actual activation verified**, not inferred from files: native OMP RPC at the
  real repository root discovered `/siyuan-memory` through project configuration,
  with no `-e` override. The local command reported ready, the correct project
  and service, eligible session, and one automatic owner. `agentInvoked=false`;
  no provider credential was available or needed. All activation checks passed,
  process exit 0. Evidence:
  `.trellis/.runtime/handsfree/activation-rpc-verify.json`.
- `setup-omp --status` also reports ready and explicit registration. Authenticated
  recall for `siyuan-agent-system` returned HTTP 200, notes=[], mental=null;
  the real project starts without imported historical memory.
- Current deployment: panel/service `http://127.0.0.1:18787`, isolated SiYuan
  `http://127.0.0.1:16806`, notebook `Agent Validation`, managed root `/HandsFree`.
  Both supervised service processes remain persistent/detached.
- Global configuration hash remains unchanged from the immediate installation
  baseline; project task bindings and all three role cards are unchanged.
  Project Hindsight autoRecall/autoRetain/mentalModels are false, and the
  legacy Jev gate is disabled. No production notebook or other project was
  migrated. No historical sessions were backfilled.
- To stop this adapter, set `.omp/siyuan-memory.json` `enabled=false` and start
  a new OMP process. Do not rely on OMP `disabledExtensions` to suppress an
  explicitly configured file; the native loader bypasses that filter for
  explicit file paths. Disabling does not re-enable another memory owner.
- No commit, push or archive was performed. Task bookkeeping remains open for
  a separately authorized commit/archive; implementation and activation are
  complete.

### Delivery cleanup

- Final independent reviews: `MemoryPatchReview` PASS (publication/recall),
  `AnchorPatchReview` PASS (durable context/baselines/budget), and
  `OmpFinalReview` PASS (installation after explicit registration).
- Removed 32 task-owned throwaway probe/driver scripts after acceptance.
  Preserved private JSON/JSONL evidence, the adapter token, Compose override,
  deployed data, and generated project configuration/stub/state. No probe/RPC
  process remains live. Cleanup receipt: `handsfree/cleanup.json`.
- The two application services remain running; the browser inspection tab was
  released. The panel visually shows the approved project/notebook/root mapping.

## Human-first correction execution — 2026-09-22

User clarified: Hindsight remains the primary automatic LLM memory; SiYuan is for
human-readable knowledge and explicit lookup only. After the correction summary,
the user said "繼續吧,我給的意見應該比較明確了". Implementation of that cutover is
authorized. Earlier automatic-recall/mental acceptance is historical, not the new
product target. No production write has been made.

1. Parallel owners implement backend no-mental/search contract, capture-only OMP
   plus explicit search, noninterfering installer, and the human-facing panel.
   Shared contracts and ownership are in design.md. Skip concurrent validation.
2. Main integrates, runs formatter/typecheck/tests/build/lint, then independently
   reviews the changed behavior. Preserve user-owned role cards/configuration.
3. Real isolated proof: ordinary native OMP publication with zero automatic
   SiYuan search/context mutation; explicit tool lookup returns current note and
   provenance; active Hindsight is not rejected; no mental provider generation.
   Exercise persisted state migration, recovery and the actual web panel.
4. Restore only the old rollout's project Hindsight/gate disabling overrides,
   rebuild/install the adapter and verify actual native extension discovery.
5. Confirm the exact formal notebook/root before the first production write.
   Keep synthetic deployment data separate; verify one authorized publication
   and on-demand lookup in the real destination, not only a healthy connection.
6. Update README and executable specs (trellis-update-spec), remove throwaway
   scripts after evidence is saved. No commit/push/archive without user request.

Required skills: trellis-before-dev, trellis-continue, trellis-check,
trellis-update-spec. LSP status returned no configured language servers; use
scoped reference searches. Agent roles were checked: task resolves to DeepSeek,
slow to openai-codex/gpt-5.6-sol; do not modify model bindings.

- Concrete deployment confirmation: create production notebook
  `探索未至之境` for this project's future publications and the first genuine
  Hindsight/SiYuan responsibility note. After formal acceptance remove the entire
  isolated 16806/test-service environment and its data, preserving evidence.
  No destructive action has yet run. Production kernel was read-only verified
  at `127.0.0.1:6806`; it binds loopback, so the deployment will use host networking
  with the application itself also bound to loopback (no kernel exposure change).

### Integrated human-first verification

- Four implementation owners finished; Main fixed the tool's `unknown` input
  boundary with shared-schema validation and a trusted projectId override.
- Unified checks: 191 tests passed, 0 failed, 1,142 assertions; formatter,
  typecheck, build and lint passed. Evidence: `human-first/integrated-checks.json`.
- Native `Settings.loadReadOnly` and `loadHindsightConfig` after removing only the
  old project overrides report autoRecall/autoRetain/mentalModelsEnabled=true,
  gateDisabled=false. Global hash and project task bindings are unchanged:
  `human-first/hindsight-restored.json`.
- The real web panel exposes four navigation entries, one visible surface at a
  time, no mental-card workflow, and legacy #mental renders overview. Historical
  source text can still mention mental models. `human-first/panel-proof.json`.
- `ServiceHumanProof` PASS: authenticated live search/current human-edited text
  with complete provenance; modified isolated paragraph restored byte-for-byte;
  invalid token 401, unauthorized project 403, retired routes 404. Legacy mental
  table retains 9 rows and no post-cutover addition. A new synthetic job completed
  to review using extraction + Jev only, with no mental generation.
- `HumanBackendReview` independently reports PASS and made no changes.
- `NativeHumanProof` exercised real OMP 18.2.3 through installed project-stub
  discovery, isolated native state, real Ollama Cloud and enabled local Hindsight
  fixtures. Seven captures were accepted; three ordinary turns made zero search
  requests. The one explicitly requested `siyuan_search` returned an existing
  verified note with provenance. Twelve captured provider payloads contained no
  SiYuan envelope in system/user/assistant roles, only explicit tool results.
  This proves capture/search coexistence, not a new retained publication: those
  new candidates were review/archive/pending at observation time.
- `HumanAdapterReview` found cancellation, wrong-acknowledgement, persisted
  payload validation, provenance escaping, platform containment and installer
  readiness gaps. Two owners are fixing the adapter and installer independently;
  unified revalidation is required before deployment. The old test publisher
  was stopped after native proof; the isolated 16806 workspace is retained until
  formal acceptance, not migrated into the clean production volume.
- Production notebook `探索未至之境` was created with explicit user approval:
  `20260922054625-c7frzwi`. Its appearance in the real desktop SiYuan notebook tree
  was visually confirmed.
 
### Final boundary checks and formal first publication

- Adapter/installer fixes passed 207 tests / 1,245 assertions, typecheck, build
  and lint; final artifact at that point was 533,729 bytes.
  `human-first/final-checks.json`. `InstallerBoundaryReview` reports PASS.
- Production service `siyuan-agent-production` uses its own empty
  `siyuan-agent-production_agent-data` volume, host networking with HOST=127.0.0.1,
  application port 18787 and native SiYuan 6806. The sole mapping is this project
  to `探索未至之境` / `/自動知識`; directory scanning remains disabled.
- The explicitly approved user excerpt was imported, not historical sessions.
  Extraction invented a separate “四元” data model and team-confirmation caveat;
  Main corrected only those unsupported inferences through the normal rejudge
  route, preserving literal source evidence and unchanged policy.
- Real Jev then returned retain: confidence 0.94, reusable value 1.99, sensitivity
  0.04, confirmed/create. Writing created document `20260922101715-f8834c4`, but
  first-readback correctly stopped under the existing comparator: SiYuan adds
  one space between bold text ending in parentheses and the next punctuation.
  Three isolated native writes reproduced this in Chinese and English.
  Evidence: `production-readback-conflict.json`, `serializer-punctuation-repro.json`.
- The operation remains terminal conflict, with no forged receipt or status reset.
  User explicitly selected deletion of **only this failed first document** after
  fixing the comparator, followed by republication of the same approved decision.
  Preserve the conflict history/evidence. The exact target and baseline hash are
  saved in `approved-conflict-cleanup.json`; the authorized cleanup is now complete.

### Human-first delivery — verified, uncommitted

- Final unified check: **209 tests passed, 0 failed, 1,259 assertions**;
  typecheck/build/lint passed. `human-first/final-checks.json`.
- The final adapter review found an unconsumed payload-message boundary.
  Main reproduced one unintended request before the fix, then proved zero
  requests and unchanged corrupt-state bytes after it. All payload revisions
  must now be consumed, while queued keys remain a subset for legacy replay.
  `human-first/ledger-prefx.json`; regression in `tests/omp-memory.test.ts`.
- `ReadbackSafetyReview` PASS. `ReadbackNativeProof` passed **122/122 checks**:
  real strong/em/strike punctuation fallback, 6 creates/4 appends, three SQLite
  reopen/lost-response reconciliations with zero resend, human whitespace/text
  edit protection, and exact owned-block undo. `ReadbackNativeProof/evidence.json`.
  Source fix reads native `textmark` only as a first-verification fallback;
  no blanket whitespace normalization, frozen-plan reset or receipt forgery.
- Final built adapter: **533,774 bytes**, SHA256
  `aea654d8024cabf53e546029726e3d95529bbf8e0544b41b5f4b1a450dec9322`.
  Real OMP through installed stub accepted a new root capture (201), with zero
  ordinary search. Explicit `siyuan_search` returned one verified note with
  operation/source/link; three observed payloads had no non-tool envelope.
  New captured synthetic content went to review, not forced retention.
  `human-first/native-final-evidence.json`; earlier three-turn Hindsight
  coexistence proof is retained separately.
- The only failed first production document was freshly checked against its
  approved baseline and deleted, with no child documents or other-note edits.
  Its original conflict operation remains immutable history. The corrected
  decision was rejudged normally: Jev retain, confidence **0.95**, value **1.99**,
  sensitivity **0.04**; job complete, candidate published, operation verified.
- Formal note: **Hindsight 與思源的分工：自動記憶、人類閱讀與按需搜尋**,
  document `20260922104221-1668bb5`, block `20260922104221-77ec69f`.
  Actual SiYuan/browser content and references were visually checked; authenticated
  formal search returned exactly this verified note and source.
  `production-final-overview.json`, `production-final-search.json`,
  `production-ui-proof.json`, `production-note.webp`.
- Production adapter reconfigured to `.trellis/.runtime/production/adapter-token`.
  Activation time `2026-09-22T06:29:41.803Z`, state directory, project settings and
  global config were preserved. Installer status is ready. Open a **new persisted
  root OMP session** to load the rebuilt extension; old sessions/history remain
  excluded. `production-adapter-activation.json`.
- Deployment remains `siyuan-agent-production` with its own named volume,
  host networking and loopback-only app at <http://127.0.0.1:18787>.
  Launch definition: `docker compose --env-file .env -f compose.yaml -f
  .trellis/.runtime/production/compose.production.yaml -p siyuan-agent-production
  up --build`. The native 6806 kernel and Hindsight container were not reconfigured.
- Authorized retirement completed: both test containers, test named volume,
  test network, 16806 workspace, old adapter token and sandbox DB/state/probes
  removed. JSON/JSONL/screenshots and native transcript evidence retained;
  production token/volume/notebook, repo secrets/examples and unrelated systems
  preserved. Ports16806/18788/18997/18998 closed; production still healthy and
  its published note still searchable. `retirement-complete.json`,
  `post-retirement-proof.json`.
- README and executable backend/frontend specs updated, including source/ledger,
  cancellation, provenance, installer and native-textmark contracts. Final
  forbidden-pattern grep had no matches; retired mental matches are only legacy
  DDL/migration/comments. No commit, push or task archive.

### Publication tree flattening — 2026-09-22

- User authorized removing the redundant content-kind directory while retaining project/topic grouping. New paths omit `draft.kind`; candidate classification remains unchanged.
- Existing verified documents may move within their authorized notebook/root by stable IDs. First verification retains exact-path checks; search retains current-scope/ownership checks; undo retains exact content/attributes. Frozen plans and receipts are not rewritten.
- Typecheck/build/lint passed; **211 tests, 0 failures, 1,271 assertions**. Regressions cover in-root search/undo, out-of-root/edit rejection and first-readback path mismatch.
- Actual `SiyuanWriter.plan` smoke produced the topic-to-title path and preserved decision classification/operation identity. Rebuilt and restarted the production service.
- Moved document `20260922104221-1668bb5` directly under topic `20260922061715-u73pk9r`. Deleted only the unchanged, now-empty `decision` document `20260922061715-e2e9ffl`.
- Native readback confirmed unchanged owned content/attributes; authenticated search still returns the note. The original operation and receipt remained byte-for-byte unchanged. Evidence: `human-first/flatten-before.json`, `human-first/flatten-result.json`.
