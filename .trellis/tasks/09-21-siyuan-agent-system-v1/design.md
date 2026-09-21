# First-release design

## Architecture and decisions

Use one Bun/TypeScript application, SQLite, and a browser control panel. Serve the
panel from the backend origin; package the application in one Docker image and
persist its data directory through Compose. The worker is part of the same
service, not an external queue deployment. Start with one publisher to simplify
ordering and recovery. Do not add Redis, a vector database, or an agent swarm.

Suggested source boundaries:

- `src/contracts/`: authoritative runtime schemas and shared DTOs.
- `src/sources/`: generic import and OMP normalization/acquisition.
- `src/storage/`: SQLite migrations, transactions, raw-object storage, repositories.
- `src/pipeline/`: extraction, Jev decisions, mental-context revisions, worker state.
- `src/providers/`: Ollama Cloud and TypeSafe HTTP clients.
- `src/siyuan/`: scoped reads, publication planning, operation reconciliation.
- `src/server/`: HTTP routing, configuration, worker lifecycle.
- `web/`: Traditional Chinese control panel, consuming the same DTO contract.

These are proposed new product boundaries, not claims about existing code. Existing
Trellis spec layers are still templates; executable conventions must be recorded
from the actual implementation rather than invented as existing practice.

## Data flow

1. An explicit upload/API request or enabled source adapter supplies source data.
2. Save an immutable received snapshot, then normalize it into source revisions.
3. Apply source permissions and local exclusion/redaction policy before cloud use.
4. Select a bounded dialogue segment with adjacent context and revision identity.
5. DeepSeek extracts evidence-bearing candidates; validate JSON and source anchors.
6. Fetch matching project context and relevant notes from the configured scope.
7. Jev evaluates each candidate against original evidence and those references.
8. Archive-only candidates stop; uncertain/conflicting candidates enter review.
9. A retained candidate receives a deterministic publication plan and write receipt.
10. Execute the plan, read back the result, and persist confirmed target identities.
11. Important confirmed changes may propose a versioned mental-context update.

The worker can resume after any durable boundary. Network calls are never performed
inside an open SQLite transaction. A failed mental-context update does not replay a
successful note publication.

## Source and identity contract

The normalized conversation envelope contains `schemaVersion`, `source`,
`sourceSessionId`, `projectId`, `startedAt`, `sourceLocator`, and `messages`.
Each message contains `sourceMessageId`, `parentId`, `role`, `timestamp`, typed
`content`, attachment references, and a raw-record locator. Unknown values are
nullable with explicit missing-field metadata. Do not synthesize historical times.

Keep a source namespace so IDs from different platforms cannot collide. A stable
record key identifies a message; a content digest identifies a particular revision.
Import digests, source revisions, extraction/policy versions, candidate identity,
and write operation identity are different concepts and must not share one key.

Candidate identity uses evidence anchors, content kind, and a stable source scope,
not a model-generated title. Reprocessing creates a new candidate revision and
reconciles it with prior publications; it is not permission to duplicate a note.

OMP is an adapter only. Respect `id`/`parentId` branch structure, header/metadata
records, complete-line boundaries, and edits to old records. Rescan with identity
and digest comparison, not byte-offset-only tailing. Import only configured root
session files, excluding nested worker transcripts by default. Preserve tool
results as evidence, but do not forward system prompts, provider payloads,
credential bookkeeping, or arbitrary extension records to generative models.

Store attachment references and availability; do not claim their contents were
analyzed. Mark source truncation and irrecoverable missing data. Periodic acquisition
is the baseline; an OMP event hook can later accelerate it without being required.

## Storage and worker state

Use SQLite tables for sources/imports, source records/revisions, projects,
candidates/revisions, jobs, judgments, mental-context revisions, publication
operations, and audit events. Use explicit migrations and parameterized queries.
Raw snapshots live under the persistent data directory, referenced by digest.

The externally visible job phases are queued, extracting, judging, review,
archive-only, ready, writing, complete, retry-wait, and failed. A separate operation
status distinguishes planned, sent, uncertain, verified, and conflict. Persist
attempt counts and error stage; do not represent all failures as a completed job.

On restart, interrupted reads/model calls can retry. Interrupted writes must first
reconcile their intended IDs and receipts. Use bounded retry/backoff for transient
network/429/5xx failures. Authentication or invalid configuration pauses that stage;
exhausted retries remain visible. Configuration changes do not erase prior errors.

## Ollama Cloud: generation roles

- Provider: native Ollama Cloud HTTP API, `https://ollama.com/api/chat`.
- Model: `deepseek-v4.1-flash` for extraction, note wording, and mental updates.
- Authentication: server-side `OLLAMA_API_KEY`; never forwarded to the browser.
- Request: role/content messages, `stream: false`; no model tools or shell access.
- Response: accept finalized assistant `message.content`; record reported model and
  available usage/duration fields. Do not mistake `message.thinking` for output.
- Model changes are explicit settings revisions, never an automatic fallback.

Current cloud documentation explicitly says structured outputs are unsupported.
Do not depend on `format`, `response_format`, or JSON Schema enforcement by the
provider. Supply the output contract in the prompt, parse the entire response as
JSON (optionally one surrounding code fence), then validate with a shared runtime
schema. A bounded repair request may correct a schema failure; unsuccessful repair
stops the job. Never salvage partial JSON into publishable content.

Extraction returns candidate kind, title, summary, factual content, evidence
references, uncertainty/conflicts, proposed project/topic, and missing context.
Every referenced source ID must exist in the supplied slice. A polished summary
without evidence is not publishable. Split long inputs without silently deleting
the final decision or relevant correction.

## Jev: retention authority

Use `POST https://api.typesafe.ai/v1/systemone` with server-side TypeSafe credentials.
Use typed `choice`, `score`, and `noul` questions with explicit rubrics. Keep the
response's actual model ID and question/policy version. Explanations are rubric
outcomes plus evidence references, not invented free-form Jev prose.

Separate questions for retention, reusable value, information status, domain,
sensitivity concern, and relationship/action. Include a none/unknown/review escape
where a forced choice would hide uncertainty. Candidates are the unit of judgment,
not an all-or-nothing verdict on an entire long conversation.

Validate question/answer identity, requested answer types, allowed choice keys,
finite numeric ranges, score legends, and probability distributions. Missing
answers are failures. Do not reuse the existing local helper's silent string
truncation or weak response validation. Feed Jev the candidate AND relevant source
excerpts, not only the generative model's paraphrase.

Thresholds are editable and versioned; initial conservative thresholds are
operational defaults, not a promise that confidence equals measured accuracy.
Permissions can block publication regardless of model output, but no other model
can silently promote an archive-only or failed judgment to automatic retention.
A human correction creates an auditable revision and, when material, a new judgment.

## Mental context

A context card is a small project-scoped derived representation: current goals,
confirmed decisions, constraints, terminology, superseded claims, and source IDs.
Read the prior card during judgment; propose its next revision after confirmed
publication. Do not let a candidate manufacture the background used to approve
itself in the same judgment.

Use DeepSeek for the proposal and deterministic validation for references and
revision ordering. Retain conflicting claims and their dates instead of pretending
they agree. User edits take precedence and are versioned. A derived card is not
an alternative authority for original conversations or SiYuan content.

## SiYuan publication and retrieval

The user selects allowed notebooks/managed roots. Retrieval is restricted to that
scope, using source/project identity, tags, titles, and text matching. Start without
embeddings. Any local knowledge index is rebuildable from the selected SiYuan
scope; SiYuan remains authoritative for human-readable published knowledge.

Use `custom-` properties for application ownership, source/item identity, revision,
and operation identity. Reserve a valid SiYuan document/block ID and persist the
write plan before submitting it. A human-readable path is not unique identity.
Confirm the chosen ID-preserving document/append representation in an isolated
v3.8.4 workspace before making the writer available for production use.

Creation and attribute assignment may be separate calls: represent both steps in
the same recoverable operation plan. After timeout, look up the reserved ID and
read content/ownership before retrying. A collision with another owner is a
conflict, not success. Do not classify a generic already-exists error as success
without checking that the existing content belongs to this exact operation.

Append only application-owned additions; preserve existing human-authored blocks.
When a prior conclusion is superseded, append/link the new decision rather than
silently rewriting the old one. Automated wholesale document merges are deferred.

Undo requires a stored receipt, ownership, and read-back match. If the target has
changed, show a conflict. Do not use whole-workspace/history restoration as normal
per-operation undo. Read-check-write is not server-side compare-and-swap; v1 must
not advertise a guarantee against every simultaneous external editor race.

## Control-panel surfaces

1. Overview: source health, queue, provider configuration presence, recent failures.
2. Import/sources: generic JSON/text upload and enabled read-only OMP source roots.
3. Candidate detail: original evidence, extracted text, Jev outcomes, destination,
   review/correction/retry/reprocess actions, and publication link.
4. Projects: mental-context cards, version/source history, manual correction.
5. Settings/history: retention rules, destination mappings, operation status, undo.

Use a same-origin API and one shared schema owner. Render imported content safely;
model-generated Markdown is not trusted HTML. Bind the default published port to
loopback. Do not expose secrets in settings DTOs, error text, or screenshots.

## Verification and unresolved technical checks

Account authorization and actual generated JSON quality are not proven by the
public model list. After planning approval, perform synthetic real-provider smoke
calls before building the full pipeline around assumptions. If cloud model access
fails, report the actual error without changing the requested model.

SiYuan write-ID preservation, append reconciliation, and undo need real tests in a
separate test workspace. Do not claim live write reliability from source inspection.
The existing production notes are not the failure-injection environment.

No product-code implementation is authorized until the user approves the latest
planning summary. The first-release scope and deferrals are owned by `prd.md`.
