# Control Panel Contracts

## 1. Scope / Trigger

Required for `web/` changes. The UI is Traditional Chinese, dependency-light DOM code, compiled with Bun. `src/contracts/index.ts` owns all API schemas; `web/api.ts` validates every response. Do not introduce parallel DTOs, HTML injection, fake progress, or provider credentials in client state.

## 2. Signatures

- `create*Panel(ctx: AppContext): Surface` owns its DOM and local form state.
- `Surface.update(state: AppState)` receives validated overview state. `isDirty()` reports unsent changes, not focus.
- `ctx.mutate({ button, work })` handles pending/error state and refresh; restore the original button label in all paths.
- `reviewCandidate(id, version, action, draft?) -> { candidateId, jobId }` selects the returned candidate after correction.
- `saveSettings(settings, rawBase) -> Settings`; `putSettings(..., onSaved)` updates revision/baseline after every successful mutation.
- `noteHref(id, siyuanPublicUrl)` uses the configured browser-facing SiYuan URL or native `siyuan://` when absent.

## 3. Contracts

Four human-facing surfaces remain mounted: overview, import/sources, candidate review, and settings/operation history. There is no mental-card panel or API; `Overview` has no `mentalCards`. Hindsight owns automatic LLM memory, and this panel must not describe publication as replacing it. `.panel[hidden] { display: none; }` overrides panel layout declarations. Remove the initial loading placeholder; after initial overview failure, a successful retry restores the actual surfaces.

Polling is every five seconds. Each panel controls safe updates. Persist unsent inputs independently of fetched state; dirty means a baseline comparison. Another tab's settings revision shows a stale warning and preserves the draft. Reload explicitly discards it after confirmation. A saved settings response becomes the new baseline, so an immediate second save succeeds.

Notebook loading only updates its status slot and select options; it must not rebuild policy/destination inputs. Failure exposes a retry button in the same slot. Keep new-destination inputs while polling or loading notebooks.

Candidate detail cannot load before overview context is available: publication links need `providers.siyuanPublicUrl`. On polling, refresh clean detail when candidate version, related operation state, or the public URL changes. Never refresh a dirty form into oblivion. A successful correction opens the returned **new** candidate ID; retain the previous candidate in history. Switching candidates with unsent changes requires confirmation.

Render source excerpts, full normalized originals, source/message identifiers, missing metadata, warnings, and available usage as actual backend data. Read-back Markdown uses the safe local DOM renderer, never `innerHTML`. Links permit only HTTP(S) and `siyuan://`. A withdrawn block's link points at the surviving document; the undo action is not offered again.

## 4. Validation & Error Matrix

| Condition | UI behavior |
| --- | --- |
| Initial `/api/overview` failure | Visible error and retry; success remounts all four surfaces |
| Unknown/malformed API response | `contract_mismatch`; no fake success |
| Notebook failure or delayed load | Visible retry; typed destination survives completion |
| External settings revision with local edits | Stale warning and preserved draft; backend CAS rejects overwrite |
| Correction creates another candidate | Select returned ID and show its live status |
| Candidate changes during user edit | Preserve input; CAS error remains actionable |
| Successful mutation | Restore button state, refresh actual backend data |
| Missing provider configuration | Presence-only status, never secret values |

## 5. Good / Base / Bad Cases

- Good: edit a title, blur it, wait for polling; the title remains. A server update must not be mistaken for permission to discard it.
- Base: importing an example creates a persistent job and exposes its actual decision.
- Bad: checking only `document.activeElement` for dirty state, copying a stale settings revision after save, or leaving the old candidate selected after correction.
- Bad: constructing a native-only note link before provider configuration has loaded and never refreshing it.

## 6. Required Verification

Run `bun run typecheck`, `bun run build`, and `bun run lint`. The actual browser is the UI proof, not a DOM-string unit test. Verify:

1. Exactly one surface is visible and the initial loading message disappears.
2. First overview request fails, then retry restores real content.
3. Notebook request fails then succeeds while an input is dirty; the input survives.
4. Two consecutive settings saves use current revisions; a second tab's revision preserves the first tab's draft.
5. Correction selects the new ID, background state changes appear, and evidence expands to the original message/locator.
6. Import, retry, candidate correction, and opening the actual SiYuan note work through the panel.
7. Provider keys are absent from UI/API payloads. Scan in memory and print only pass/fail or paths, never matching values.
8. Exactly four navigation entries are present; legacy `#mental` falls back to overview. No mental-card endpoint is requested. Historical source text may mention mental models; that does not make it an active UI feature.

Machine checks with the built-in `grep` tool:

- `path="web"`, `pattern="innerHTML\\s*=|outerHTML\\s*=|as any\\b|: any\\b|@ts-ignore"`: no matches.
- `path="web/main.ts;web/panels/review.ts;web/panels/settings.ts;web/panels/import.ts;web/style.css"`, `pattern="panel\\[hidden\\]|replaceChildren|formBaseline|savedSettings|detailPublicUrl"`: inspect the shared lifecycle and dirty-state boundaries, not merely match counts.

## 7. Wrong vs Correct

```ts
// Wrong: changing a shared settings object while keeping its stale baseline.
// await saveSettings(draft, raw);

// Correct: consume the authoritative returned revision.
const saved = await saveSettings(draft, raw);
// Feed saved into the panel's revision/baseline update callback.
```

Root-cause record: per-panel rendering passed static checks while authored CSS overrode `hidden`, initial errors detached surfaces, and candidate detail raced overview state. Real cold-load, failure/retry, and background-update scenarios are mandatory after lifecycle changes. The two publication-link callsites (`review.ts`, `settings.ts`) must migrate together.
