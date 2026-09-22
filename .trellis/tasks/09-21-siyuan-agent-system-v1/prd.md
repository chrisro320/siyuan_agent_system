# SiYuan Agent System — First Working Release

## Goal

Build a source-independent, single-user knowledge publishing service for human
readers. Approved new dialogue is captured in the background, reusable knowledge
passes Jev's publication gate into SiYuan, and the user can read and correct it.
Hindsight remains the primary automatic LLM memory system. SiYuan is searched only
on demand, never through automatic recall or context injection.

## Background

- The initial repository contained project/Trellis initialization only.
- The repository is `chrisro320/siyuan_agent_system`, private, on `master`.
- The user authorized creation of this Trellis task on 2026-09-21.
- The initial OMP-specific idea was generalized by the user: only the SiYuan
  destination is fixed, and OMP must be an interchangeable input source.
- The latest instruction selects cloud generation instead of local Ollama.
  Its official native API identifier is `deepseek-v4.1-flash`.

### Model-role configuration for planning review

| Role | Provider/model |
|------|----------------|
| Extraction and readable note generation | Ollama Cloud `deepseek-v4.1-flash` |
| Mental-context maintenance | Ollama Cloud `deepseek-v4.1-flash` |
| Retention judgment | TypeSafe Jev, retaining the user's earlier decision |

The cloud-model change applies to the two generative roles. The proposed scope
does not interpret it as permission to remove Jev's retention authority.

## Proposed first-release requirements

### R1 — Independent service and durable operation

Run the HTTP API, background worker, and web panel from one Docker deployment.
Persist raw imports, normalized revisions, jobs, judgments, mental-model versions,
and write receipts outside the container. Restarting must not discard accepted
input or require re-importing it.

### R2 — Universal input plus an OMP adapter

Accept a documented conversation JSON format through the API and web upload.
Accept pasted/uploaded Markdown or text as explicitly unstructured source data;
unknown roles or timestamps remain unknown, not invented.

Provide opt-in OMP acquisition from selected read-only mounted session directories,
with periodic rescan and stable source/message identity. Do not collect all of the
user's home directory. The core pipeline must also accept a non-OMP fixture with
no OMP installation or configuration.

### R3 — Evidence-bearing extraction

Use `deepseek-v4.1-flash` to extract candidate conclusions, decisions, methods,
project information, questions, and action items. Every factual candidate retains
resolvable source message references and relevant original excerpts.

Preserve the source and record incomplete/truncated input. A generated summary is
not the only evidence sent to Jev. Imported prompts and code are data, never
instructions granting tool access.

### R4 — Jev retention gate

Jev evaluates candidates using source evidence, configured retention rules,
project context, and relevant existing knowledge. Supported dispositions are
retain, archive-only, and review. Classification, value dimensions, confidence,
and action recommendations are recorded separately.

Only a validated retention result that passes the configured policy may proceed
automatically to publication. Invalid, incomplete, or unavailable judgments must
not default to retention. User review/corrections remain explicit audit events;
generative models have no authority to bypass the gate.

### R5 — Lightweight mental context

Maintain a small project-scoped context card: goals, current confirmed decisions,
constraints, terminology, and superseded conclusions. Cards are visible and
editable in the panel, with source links and revision history.

Use the same Ollama Cloud model to propose updates after retained, confirmed
information changes. Preserve manual corrections and conflicting alternatives.
Unconfirmed inferences do not silently become durable user preferences.

### R6 — Readable SiYuan publication

Publish into user-selected notebooks/managed roots, organized by project/topic
and content type. The user can inspect and correct destination mappings.

Notes include a title, short summary, useful conclusions/details, scope or
limitations, relevant actions/examples, and source links. Do not fill absent
sections with invented material. Link related knowledge rather than duplicating
the same accepted content for each source platform.

The first release automatically creates notes or appends owned additions; it
does not automatically rewrite arbitrary existing human-authored blocks.

### R7 — Idempotency, revisions, retry, and compensation

Repeated imports do not create repeated jobs or notes for identical source
revisions. Changed content and changed policies can be reprocessed without
forgetting previous publications.

Persist operation identity and intended targets before external writes. Resolve
an ambiguous timeout by checking the intended target, never by blindly appending.
Failures remain visible and retryable without losing input.

Allow undo of this application's own writes when the affected content still
matches its recorded state. If it has been changed by a human, stop and show the
conflict instead of restoring an old whole-document snapshot.

### R8 — Useful web control panel

Provide source setup/import, job status, candidate previews with source evidence,
review/correction/reprocessing, mental-context cards, destination/rule settings,
publication links, and operation history. Use Traditional Chinese UI text.
The panel is for inspection, correction, and failures; opening it, importing files,
or manually requesting recall must not be required during normal enabled chatting.

Provider keys are server-side environment/secret-file inputs. The panel may show
whether a provider is configured, never its secret value.

### R9 — Data boundaries and observable operation

Use explicit source and destination allowlists. Preserve raw originals separately
from generated notes; keep runtime databases, logs, and secrets out of Git.
Record model identifiers, policy/prompt versions, available usage statistics,
failure stages, and human corrections without logging credentials.

Cloud processing is explicit, not represented as offline operation. Validation
uses synthetic or user-approved data and an isolated SiYuan test workspace, not
unrestricted mutation of the existing knowledge base.

## Acceptance criteria

- AC1 (R1/R2): Start through Docker Compose, open the real web panel, import an
  OMP sample and a generic conversation, and inspect their persistent job states.
- AC2 (R2/R7): Import the same source revision three times; there is one logical
  ingestion and no duplicate publication. A changed revision is recognized.
- AC3 (R3): A candidate's references resolve to the imported original; missing
  fields, split boundaries, and truncated input are visible rather than invented.
- AC4 (R3/R4): Synthetic retained, archive-only, and uncertain cases travel through
  real Ollama Cloud and Jev calls. The panel displays the actual decisions.
- AC5 (R4): Missing answers, invalid enums/probabilities, malformed generated JSON,
  provider failures, and exhausted retries cannot cause an automatic SiYuan write.
- AC6 (R5): A confirmed change to a project decision can produce a traceable mental
  card revision; manual edits and unresolved conflicting claims are preserved.
- AC7 (R6): Read back real created/appended SiYuan content and visually inspect its
  title, layout, references, and configured destination in the actual application.
- AC8 (R7): Exercise restart and successful-write/lost-response scenarios in the
  isolated workspace; recovery does not repeat the intended write.
- AC9 (R7): Undo an untouched owned addition; then modify another addition and
  confirm undo stops at a conflict instead of deleting the modified content.
- AC10 (R8/R9): Complete import, review, correction, retry, and opening a published
  note through the browser. Credentials are not returned by UI/API responses.
- AC11 (R3/R5): Both generative roles use Ollama Cloud `deepseek-v4.1-flash`; no
  local inference or unapproved substitute model runs.

## Explicitly deferred for this release

- Additional platform-specific automatic adapters beyond OMP; generic import
  remains usable for other sources.
- Automatic scraping of logged-in web chat products.
- OCR, audio transcription, and binary-attachment understanding; preserve their
  source references and report that their contents were not analyzed.
- Multi-user accounts, public hosting, complex role management, and other
  knowledge-base destinations.
- Automatic destructive consolidation of existing notes and automatic rewriting
  of human-authored content.
- Autonomous preference learning, model training, local inference, and vector
  database infrastructure.

## Technical evidence and validation boundaries

- Ollama Cloud lists the requested model:
  https://ollama.com/api/tags
- Native cloud API and server-side authentication:
  https://docs.ollama.com/cloud
- Cloud structured outputs are explicitly unsupported in current documentation:
  https://docs.ollama.com/capabilities/structured-outputs
  The implementation must validate generated JSON locally and keep invalid
  results out of later stages, rather than assume provider-enforced JSON Schema.
- OMP message identity and branch fields:
  `src/session/session-entries.ts:66-71` in the installed coding-agent package.
- OMP history rewrites exist:
  `src/session/session-maintenance.ts:626-647`; title rewriting:
  `src/session/session-storage.ts:623-639`.
- Existing OMP dialogue extraction is not lossless:
  `~/orca/projects/trellis/omp/scripts/mem/omp_mem.py:240-261`.
- Existing Jev helper must not be copied unchanged: weak response validation at
  `~/.omp/agent/lib/jev.ts:143-172`, lossy state handling at `:396-427`.
- SiYuan v3.8.4 source does not make a human-readable document path an idempotency
  key: https://github.com/siyuan-note/siyuan/blob/v3.8.4/kernel/model/path.go#L75-L113
- First-release cloud authorization and isolated SiYuan write/recovery evidence
  are recorded in `implement.md`. Production write/rollback, provider-quality
  benchmarking, and the new hands-free path are not covered by that evidence.

## Approval history

The first-release implementation was approved and recorded in `implement.md`;
commit `b33c43f` contains that release. The hands-free integration below is a new
planning increment. Its implementation and live-data activation require approval
of the latest concrete scope; earlier synthetic-data approval is not permission
to upload real session history or write production notebooks.

## Hands-free integration — 2026-09-21


### R10 — Automatic capture

Provide an OMP adapter without patching OMP core. Capture completed root-session
dialogue for explicitly enabled projects only. Activation must not silently
backfill historical sessions. Preserve canonical session/message identity and
source evidence; exclude system instructions, thinking, subagent transcripts,
known credential patterns, and previously injected recall content.

Reuse the existing durable ingestion, generation, Jev, publication, and mental
context pipeline. Delivery failures remain retryable without blocking ordinary
chat or losing already captured data. A restart or resend must not create a
second publication. Keep the ingestion contract source-independent.

### R11 — Automatic recall

Before a normal user turn, retrieve authorized project context and relevant
confirmed SiYuan knowledge automatically. Include traceable source references.
Candidates awaiting review, archive-only items, withdrawn writes, and inaccessible
material are not eligible as confirmed memory. Respect manual changes in SiYuan
rather than returning a stale generated copy.

Supply memory as bounded, untrusted contextual data, not a system instruction or
new tool authority. Do not rewrite previously sent history or dynamically alter
the toolset. Timeouts must not prevent the chat from proceeding; degraded status
must remain inspectable. Recalled content must not be captured as new evidence.

### Acceptance additions

- AC12 (R10): In a real sandboxed OMP session, finish a synthetic conversation
  without using the panel or a retain command; observe durable ingestion and
  the real approved-provider pipeline reaching an isolated SiYuan note.
- AC13 (R11): Start another sandboxed conversation in the same project and ask
  a relevant ordinary question. Confirm the outgoing model context includes the
  note and provenance without any explicit recall request; an unrelated project
  receives none of that project's memory.
- AC14 (R10): Activation ignores pre-existing history; subagent sessions, system
  records, thinking, and recalled context do not enter the retained evidence.
- AC15 (R10/R7): Repeat capture delivery and reopen the local state three times;
  observe no duplicated note and eventual delivery of pending accepted captures.
- AC16 (R11): A service outage does not block normal chat or inject stale output.
  Pending capture remains recoverable, and degraded state is visible.
- AC17 (R11): Human edits, withdrawn notes, and unconfirmed candidates are handled
  according to R11. Returned references resolve inside the approved destination.
- AC18 (R10/R11): Tool follow-ups, retries, and resumed turns preserve prior
  message prefixes; memory injection does not feed itself back into capture.
- AC19 (R10/R11): The approved project has only one automatic memory owner.
  Unrelated projects retain their existing memory configuration and behavior.

### Scope and activation decision

Implement the generic service boundary and OMP adapter first; additional client
adapters, logged-in website scraping, and full Hindsight API emulation remain out
of scope. Existing R1–R9 safety, cloud models, and SiYuan write boundaries still
apply. Do not replace global Hindsight state or migrate its history implicitly.

Recommended initial activation: only new root conversations under
`/mnt/data/Projects/siyuan`, mapped to project `siyuan-agent-system` and managed
root `/HandsFree` in the existing isolated `Agent Validation` notebook. Other
projects, historical sessions, and production notes remain untouched. This scope
requires user approval before implementation and activation.

Approval: after reviewing the concrete plan, the user selected
`實作並啟用本專案`. This authorizes implementation and, after synthetic acceptance,
the exact new-session-only project activation above. It does not authorize
historical backfill, production notes, other projects, or a git push.

## Human-first correction — 2026-09-22 (current scope)

The user clarified that SiYuan is primarily for people, not a second Hindsight,
and then authorized continuing the correction. This section supersedes the
automatic-recall and parallel mental-model requirements above; earlier sections
and acceptance records describe the already delivered isolated implementation.

- R5 is retired from the active product: no parallel SiYuan mental-model
  generation, maintenance, injection, or editable mental-card surface. Preserve
  stored historical data without continuing that subsystem.
- R10 remains: authorized new root dialogue is published in the background
  through extraction, Jev and the existing durable writer. Hindsight being
  enabled is not a reason to reject publication.
- R11 becomes explicit knowledge search: provide a bounded, read-only interface
  and OMP tool for requests such as "find that note in SiYuan". Ordinary turns,
  automatic continuations, retries and session startup do not perform a SiYuan
  search or inject its content.
- AC6 is replaced by proof that publishing does not generate mental cards.
  AC11 applies to extraction/readable knowledge generation only; Jev retains
  publication authority. Retired mental data is not deleted or republished.
- AC13/AC16/AC18 now require zero automatic search/context mutation, explicit
  search with current content and provenance, and nonblocking capture recovery.
  AC14/AC15/AC17 source, durability and authorization boundaries remain.
- AC19 now requires Hindsight to retain its original automatic-memory role.
  Restore only this rollout's project-level disabling overrides; preserve global
  configuration, existing Hindsight data and unrelated project/task settings.
- The panel remains a human-facing publication/review/settings/history surface.
  This is still cloud processing, not an offline claim.
- Formal SiYuan connection must use a confirmed notebook/root, a clean service
  data boundary and no synthetic-memory migration. The discovered production
  Agent-System notebook is `20260820010437-15chezf`; selecting its managed root
  and authorizing the concrete write remain deployment gates.
- No historical backfill, new project scope, arbitrary handwritten-note edits,
  Hindsight uninstall/data migration, commit, push or archive is authorized.

Acceptance: actual ordinary OMP turns publish without automatic search; an
explicit search tool call returns an authorized current note and source link;
Hindsight coexists without ownership errors; no mental-generation request is
made; the real panel has no mental-model editing workflow. Retain capture replay,
write reconciliation, human-edit protection, project isolation and credential
boundaries. Verify existing persisted state upgrades without backfill or replay.

### Formal destination and retirement authorization

At the concrete deployment confirmation, the user selected a **new** production
notebook named `探索未至之境`, not the existing Agent-System notebook. The first
publication records the confirmed Hindsight/SiYuan responsibility split. This
supersedes the candidate Agent-System destination above. The project remains
`siyuan-agent-system`; no other project or history is enrolled.

The user also explicitly selected removal of the **entire isolated test
environment** after formal acceptance: the 16806 test SiYuan workspace including
Agent Validation, and its test service/data. Preserve verification evidence;
do not delete production notes, Hindsight or unrelated containers/data.

### Publication layout and maintenance handoff authorization

The user approved removing the content-kind directory: keep managed root,
project, topic and article; retain classification as metadata. The existing
production note was moved by stable ID and only its empty `decision` parent
was removed.

After verification, the user authorized a formal pause, a workspace checkpoint,
push to the existing `chrisro320/siyuan_agent_system` remote, and changing that
repository from private to public. This supersedes the earlier no-commit/no-push
restriction for this checkpoint only. Keep credentials, raw runtime evidence,
local activation and databases out of Git; inspect history before publication.
The task is not archived and the separate guideline-bootstrap task is unchanged.
Other LLMs will maintain and extend the verified baseline; no future feature
scope is implied. The user additionally authorized publishing reusable lessons
from this long task into the confirmed SiYuan destination.
