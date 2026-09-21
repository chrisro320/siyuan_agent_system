# SiYuan Agent System — First Working Release

## Goal

Build a source-independent, single-user knowledge distillation service. The user
continues using different AI conversation tools; this service extracts reusable
knowledge, asks Jev whether it deserves retention, and publishes readable,
traceable notes to SiYuan. SiYuan is the only knowledge-base destination.

## Background

- The repository currently contains project/Trellis initialization only.
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
- SiYuan metadata reads succeeded earlier; no production write or rollback has
  been tested. Real provider quality, latency, cost, and account authorization
  have not yet been measured for this release.

## Planning approval

This document proposes the complete first-release boundary for review. Creation
of the task does not authorize implementation. The latest planning summary must
receive a subsequent explicit user approval before `task.py start`.
