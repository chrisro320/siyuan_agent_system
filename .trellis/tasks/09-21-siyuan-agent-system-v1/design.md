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

## Hands-free integration design — planning increment

The new user path is normal chat -> durable background capture -> existing
extraction/Jev/publication -> automatic contextual recall in a later chat.
The existing panel is an inspection/control surface, not the trigger.
Scope and live-data authorization are owned by PRD R10/R11.

### Service boundary

Add `POST /api/capture` and `POST /api/recall` with shared schemas in
`src/contracts/index.ts`. An adapter credential is separate from cloud and
SiYuan credentials, server-side scoped to explicitly enabled project IDs.
Keep the existing loopback, expected-host, JSON, and hostile-Origin checks;
native local adapters can omit Origin. Do not bypass these checks or expose
other project data through a convenience overview request.

Capture carries a stable capture ID, source namespace, original session and
message identities, branch provenance, and completed new dialogue. The server
acknowledges only durable acceptance. Resending the same identity/content returns
the original acceptance; reusing an identity with different content is a conflict.
Normalize through the existing source boundary and reuse Store.ingest and its
publication protections. Do not manufacture timestamps or hide missing parents.

Use a local durable delivery queue in the adapter, not network completion as a
capture cursor. Keep activation/session baselines and message revisions so an
acknowledgement loss or restart cannot lose accepted dialogue or enqueue all old
history. Do not resubmit an entire growing session after every turn. The existing
directory poller remains an explicit legacy/manual acquisition option, not the
new automatic rollout mechanism, and cannot be a second owner of the same source.

Recall requests carry a project ID and the current user query. Return a bounded
snapshot of eligible active context plus relevant current SiYuan excerpts, with
block/document/source identifiers, content revision, and truncation indicators.
Do not echo the raw query into routine logs or call another model merely to fetch
local memories. An empty result is valid; no cross-project fallback is allowed.

### Search and freshness

Use SiYuan's actual `/api/search/fullTextSearchBlock` for body search, with bounded
query terms and results. The read-only probe in
`research/handsfree-service.json` confirms Chinese, numeric, and English queries.
This is full-text retrieval, not a claim of embedding or semantic equivalence.

Search path values contain a notebook ID plus an internal node-ID path, not the
human-readable `rootPath`. Search only within an approved scope and revalidate
the returned block/document against notebook, managed root, project ownership,
and a verified publication before returning content. A broad notebook hit by
itself is not authorization. Never inject the search API's highlighted HTML;
read current plain/Kramdown source through the existing SiYuan client.

Derive recall eligibility from the current operation and live block, not just
`candidate.status`. Exclude undone, undoing, uncertain, conflicted, deleted, and
out-of-scope material. Return a human-edited owned note's current content and
mark its changed revision rather than substituting an old candidate draft.
Omit derived mental claims whose source was withdrawn or changed; a stale card
cannot override the live note. Do not introduce a second independently updated
withdrawn flag merely to support recall.

### Adapter and context invariants

Ship adapter source here and load it through OMP's supported extension mechanism.
Root-session completion drives background capture; the next ordinary user turn
drives bounded recall. Capture only original user/assistant dialogue, never
thinking, system instructions, tool payloads, subagent transcripts, or the memory
snapshot itself. Preserve parent/session identity instead of flattening branches.

Use `agent_end` with `willContinue` false for capture, after root/session/branch
validation. OMP 18.2.3 also invokes `before_agent_start` for automatic continuations;
that hook may stage a bounded recall but cannot alone authorize a new injection.

Apply recall through the `context` hook's cloned user-message view, following the
existing persistent-anchor pattern rather than adding a transient tail message.
Bind a snapshot to the genuine user message's original content, timestamp, and
session. Replay every previously bound snapshot byte-for-byte on follow-ups,
retries, and resume. Persist explicit empty/timeout outcomes too: recovery during
a tool follow-up must not insert text into an already-sent user message.

Do not write the injected view into the raw transcript, change system prompts or
tools, or rewrite provider-specific payloads. A newly staged result must match
the new human anchor; an automatic continuation cannot reuse it for an older turn.
Concrete inspected host contracts are in `research/handsfree-omp.json`.

The adapter must have bounded foreground work; all generation, Jev judgment,
publication, and mental maintenance remain background service work. An outage
leaves capture pending and recall visibly degraded without stopping normal chat.

### Project cutover and rollout

After explicit approval, enable one project mapping, a source activation boundary,
and a selected notebook/root. Suggested initial mapping is this repository to a
new `siyuan-agent-system` project under `/HandsFree` in the isolated
`Agent Validation` notebook. Do not mix prior synthetic validation project memory
into this project's automatic context.

Give the enabled project one automatic memory owner. At a fresh session boundary,
preserve task role bindings and set project-scoped `hindsight.autoRecall`,
`hindsight.autoRetain`, and `hindsight.mentalModelsEnabled` to false; disable the
existing Jev memory-gate extension only in this project. Hindsight environment
flags outrank YAML, so verify effective flags and refuse activation if ownership
still conflicts. Do not erase global Hindsight configuration/history or change
unrelated projects. Disabling the adapter stops future collection/recall while
retaining durable pending and accepted operation history.

### Proof and release criterion

The decisive scenario is two real sandboxed OMP conversations: the first stores
synthetic knowledge without a memory command, the second receives it automatically
in its outgoing context without a recall command. Provider calls and SiYuan writes
use the already approved synthetic/isolated boundary. Add independent restart,
lost acknowledgement, cross-project isolation, outage, human-edit, withdrawal,
prefix-stability, and feedback-loop cases per AC12–AC19. Hook-unit success alone
does not establish the complete user behavior.

The real OMP capture probe requires persisted sandbox sessions; do not use
`--no-session`, because the root-only adapter intentionally skips in-memory
sessions that cannot be classified. A load-only `omp models -e ...` result
establishes loading, not the memory loop. Keep native credentials/databases
outside the sandbox and use only the explicitly approved synthetic cloud setup.

## Human-first cutover — 2026-09-22 (supersedes memory-owner design)

Keep the source-independent capture/extraction/Jev/publication service. Hindsight
owns automatic LLM memory; this service owns human-readable knowledge publishing.
Do not replace Hindsight or add another per-turn retrieval/mental-model loop.

Contract shared by parallel implementation slices:

- Replace `/api/recall` with authenticated `POST /api/search`; no compatibility
  alias. Export `SearchRequest`, `SearchResponse`, `searchRequestSchema`,
  `searchResponseSchema` and `searchNoteSchema` from `src/contracts/index.ts`.
  Request fields retain projectId/query/limit/maxChars and their current bounds.
  Response is `{ projectId, notes, truncated }`; notes preserve all current
  authorization, current-content, source and revision fields. There is no mental
  field. Capture contract is unchanged.
- OMP registers a stable `siyuan_search` tool at startup. It takes query plus
  optional limit/maxChars; projectId is bound by trusted adapter configuration,
  not supplied by the model. Describe it as explicit/on-demand SiYuan lookup,
  not ordinary-turn memory retrieval. Results are untrusted tool data with
  provenance, never context-hook injection. No new cloud call is needed to search.
- Remove before_agent_start/context recall hooks, anchor construction/replay and
  the Hindsight competing-owner gate. Keep original-dialogue filtering and the
  durable outbox, consumed ledger, baseline and shutdown bounds. Legacy persisted
  capture state must upgrade without dropping pending/consumed data or backfill;
  retired anchor snapshots must not be replayed or destructively reset.
- Remove active mental schemas/API/UI/provider generation and worker updates.
  Keep historical stored rows on disk, but remove their runtime use. Extraction
  and Jev receive actual source evidence and scoped existing notes, not a parallel
  derived mental model. Publishing ends after verified publication.
- Installer preserves all Hindsight/gate settings, including inherited extension
  arrays, and does not reject active Hindsight. Main restores the known rollout
  overrides in this project only after the new adapter is verified.
- UI consumes Overview without mentalCards and removes the mental panel/API.
  Existing import, review, settings/history, provenance and safe rendering stay.

Ownership: backend slice owns src/ and backend tests; adapter slice owns
integrations/omp and its tests; installer slice owns setup-omp and its tests;
frontend slice owns web/. Main owns documentation, project configuration,
deployment, integration and final verification. No slice runs validation during
concurrent editing. No product code in the installed OMP/Trellis is patched.

Deployment uses a new session boundary. Do not attempt to preserve the retired
injected-view prefix by retaining hidden compatibility hooks. Existing raw
transcripts and persistent capture identity remain intact. Formal connection
requires a separate clean service state and a confirmed production managed root;
synthetic projects/jobs/notes must not be redirected to the production kernel.
