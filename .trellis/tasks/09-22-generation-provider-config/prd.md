# Configurable Generation Providers and Models

## Goal and authorization

Remove the generation layer's hard dependency on Ollama Cloud and one DeepSeek model. Users can stage supported provider/protocol, endpoint, model and authentication mode in the panel; the next service restart activates the selection. Server-side credentials remain outside the browser. Both cloud and local generation are supported; Jev remains the fixed judgment and publication gate.

The original task request authorized planning only. The user subsequently confirmed the full multi-provider scope, panel/restart configuration surface and fail-closed old-job policy, then approved implementation with “可以” on 2026-09-23 after the final planning summary. Production changes, real provider calls, commit and push remain outside that approval.

## Priority and scheduling

- Priority: **P0**.
- Execute this task before `09-22-candidate-review-automation` (**P1**).
- This is a scheduling precedence, not a parent/child task relationship or a claim that every automation requirement technically depends on provider configuration.
- Keep the two tasks' requirements, context and acceptance independent. Do not resume the previous paused delivery task.
- The current branch/session binding is unchanged; `--no-start` was used. Before continuing implementation from the automation task, honor this higher-priority planning task first.

## Confirmed historical baseline

Baseline: `ad78300f552679560413a556ab54557c1db8d8ae`.

- `README.md:3-5` presents Ollama Cloud as part of the fixed pipeline and states that generation always uses `deepseek-v4.1-flash`, excludes local inference and does not switch models.
- `src/contracts/index.ts:3` exports a fixed `GENERATION_MODEL`.
- `src/providers/ollama.ts:25-28` hardcodes the cloud origin, chat URL and provider label.
- `src/providers/ollama.ts:60-73` accepts only that fixed model or its `:cloud` tag; `:224-245` sends the constant model to the fixed endpoint.
- `.env.example:6-10`, `compose.yaml:11-14` and `README.md:24-35` expose Ollama credentials but no selectable generation provider/endpoint/model.
- The baseline Runtime Contracts §3 specifies a fixed generation service/model. The current working tree has already updated this clause for one OpenAI-compatible adapter; the final contract must cover both approved protocols.

## Current working-tree evidence (2026-09-23)

- An uncommitted change already replaced the Ollama client with `src/providers/generation.ts`, defaulting to the configured Antigravity OpenAI-compatible endpoint and `gemini-3.7-flash-medium`. Extraction and mental proposals share that transport; Jev remains separate. This supersedes the historical baseline observations above.
- `src/server/config.ts` exposes only generation URL, model and key; `GenerationClient` speaks only `/chat/completions` and calls `requireApiKey` before every request. The working tree has no protocol selection, Ollama adapter or no-auth local mode. Thus it does not yet meet AC1's two approved services or AC2's local authentication policy.
- The user confirmed the original multi-provider/local scope on 2026-09-23. Preserve the selected Antigravity OpenAI-compatible default while adding native Ollama and explicitly configured local no-auth support.

## Requirements

### R1 — Configurable generation, fixed Jev

Make the provider/protocol, API endpoint, model and server-side credential source configurable for both approved adapters. Keep Antigravity and `gemini-3.7-flash-medium` as the initial selection, not the only allowed service/model. Permit local generation, including explicit no-auth mode on a loopback endpoint; this does not remove Jev's cloud dependency.

Keep Jev's validated judgment, retention thresholds and publication veto unchanged. Local generation does not make the whole pipeline offline: Jev still requires its service.

### R2 — Explicit support boundaries without vendor lock-in

Keep the pipeline dependent on the generation contract rather than one vendor client. Additional supported protocols must not require rewriting candidate extraction, evidence validation or publication logic. Configuration alone does not magically support arbitrary wire protocols; document and validate the actual adapter set, rejecting unsupported selections clearly.

The approved initial adapter set is the OpenAI-compatible API plus native Ollama. Native Anthropic/Gemini protocols are deferred, not claimed supported or permanently excluded; Antigravity remains the initial configured OpenAI-compatible endpoint.

### R3 — User selection is not silent substitution

Users may deliberately change the configured generator. A failed request must not silently switch provider/model or send source material to another endpoint. Validate reported model identity according to the selected adapter's documented semantics, against configured selection rather than a hardcoded DeepSeek name; retain requested and actual identity in existing provenance where appropriate.

Pin the selected generation configuration when a job is created, including work that has not yet extracted a segment. A saved panel draft does not change the running generator. After restart with a different configuration, unfinished jobs from the old configuration stop visibly; they neither continue under the new provider nor automatically reprocess. The user must explicitly create a new run. Preserve the extraction-plan fingerprint and existing publication receipts.

### R4 — Preserve data and credential boundaries

Retain local output-schema validation, exact evidence-quote checking, bounded repair, response completeness, usage recording and secret-safe errors. Credentials stay in server environment variables or mounted files; the panel may choose authentication mode and show configured presence only, never receive credential values. Explicit local loopback no-auth sends no Authorization header. Remote authenticated endpoints require safe transport and explicit credential-origin binding.

Only trusted service configuration chooses endpoints and credentials. Conversation text, generated candidates and provider responses must not redirect requests or choose credentials. Define safe endpoint/redirect handling without reinstating a single-vendor origin restriction.

### R5 — Consistent cutover and documentation

Update every affected configuration consumer, provider selection point, contract, existing test, Compose/example setting, README statement and executable spec check together. Document the migration for existing Ollama installations and reject invalid/unsupported configuration visibly. Do not merely broaden README claims while the runtime remains hardcoded.

Preserve Hindsight coexistence, zero automatic SiYuan recall, project isolation, human-edit protection and immutable publication receipts.

### R6 — Staged panel selection

Use the existing settings surface to edit the non-secret provider/protocol, endpoint, model and authentication mode with revision conflict protection. Saving shows a pending selection and restart requirement while the current worker keeps its startup selection. Restart activates the validated pending selection without changing the Jev policy revision or silently switching an in-flight job; a malformed pending selection fails closed and remains diagnosable.

## Acceptance criteria

- AC1 (R1/R2): Through configuration alone, switch between two different model IDs and approved generation services without editing pipeline code; actual requests use the selected endpoint/model, not the old constant.
- AC2 (R1/R4): An approved local-generation configuration works under its configured authentication policy. Jev still performs the same mandatory publication judgment; no offline-publication bypass exists.
- AC3 (R2/R3): Unsupported protocol/configuration, transport failure and unexpected model identity produce visible failures without fallback requests or publication.
- AC4 (R3/R4): Request/response provenance and available usage identify the selected generator correctly; malformed output and fabricated evidence still fail the existing gates. Configuration changes and restart/replay obey the approved durable-work rule.
- AC5 (R4): Credential values never appear in public configuration output, logs or errors. Redirects and untrusted content cannot change the authorized destination or leak credentials.
- AC6 (R5): Existing Ollama operation has an explicit migration path; README, example environment, Compose and Runtime Contracts describe the implemented capabilities and limitations consistently.
- AC7 (R5): Existing project-isolation, Hindsight, zero-auto-recall, human-edit and receipt guarantees remain intact. Use isolated fixtures and actual selected protocol entry points; production switching or external credential use requires separate authorization.
- AC8 (R6): Save a provider/model change in the panel, observe pending versus active values and restart notice, and confirm ongoing jobs still use the old selection until restart. A second tab cannot overwrite a newer draft; no secret appears in any API/DOM value.
- AC9 (R3/R6): After restart, both partially extracted and never-started old jobs stop with a visible configuration-change error. Ordinary retry does not send them to the new endpoint; explicit reprocessing creates a new run without mutating earlier candidates or publication receipts.

## Out of scope

- Replacing Jev, lowering its gates or automatically changing review into retain.
- Candidate-identity fixes or automatic review resolution; those remain in the separate P1 task.
- Automatic provider fallback, model routing optimization, new telemetry systems, Hindsight changes or automatic context injection.
- A universal provider framework, an unapproved full SDK catalog or claims of arbitrary protocol compatibility.
- Production deployment/configuration changes, reprocessing existing jobs or accessing real source data without separate authorization.

## Confirmed product decisions

1. Initial adapters: OpenAI-compatible API plus native Ollama, including explicit local loopback no-auth. Native Anthropic/Gemini protocols are deferred.
2. The panel edits only non-secret provider/protocol, endpoint, model and authentication mode. Saving stages a draft; restart activates it. Credentials remain server-side.
3. Configuration changes stop unfinished old jobs, including jobs that have not started extraction. Only a user-initiated reprocess uses the new selection; there is no automatic migration, re-send or publication.

## Planning gate

The planning gate was satisfied by a separate user message approving the final Goal, In Scope, Out of Scope, Acceptance Criteria, Key Decisions and Risks summary. `task.py start` moved this task to `in_progress`; implementation and isolated synthetic verification are permitted. Production deployment, external credential use, reprocessing and committing/pushing require separate authorization. Before delivery, run read-only `trellis-check` and required `trellis-update-spec` with updated machine checks.
