---
description: "Pause the current task: commit, write a RESUME anchor, no archiving."
---

# Paused Work

Lightweight mid-task checkpoint — persist progress so the next session's `/trellis-continue` resumes cleanly. Unlike `/trellis-finish-work`, this does **NOT** archive the task, write a session journal, or finalize specs. Task stays `in_progress`.

Use when stopping mid-bundle (out of time, context full, switching focus) with work unfinished.

## Step 1: Survey

The active-task pointer is per-session and may already be lost (new session / `/clear` / new window). Re-bind it first:

```bash
python3 ./.trellis/scripts/task.py current --source
```

- **Has output** → run `get_context.py` below.
- **No output / exit 1** → `python3 ./.trellis/scripts/task.py list --mine`, filter `(in_progress)`:
  - **0** → "no in_progress task to pause." Stop.
  - **1** → silently re-bind: `python3 ./.trellis/scripts/task.py start <dir>`.
  - **≥2** → `ask` to pick which to pause → `task.py start <chosen dir>`.

```bash
python3 ./.trellis/scripts/get_context.py
```

Note the active task, dirty paths, and recent commits.

## Step 2: Persist progress to `implement.md` (the durable record)

`implement.md` is what `/trellis-continue` reads next session. Session-only todo lists (the `todo` tool etc.) do NOT survive — never rely on them for handoff.

Open the active task's `implement.md`. For every step touched this session:

- Tick `[x]` steps whose verification passed; leave `[ ]` for unstarted.
- Append a one-line status note to each touched step: `verified` / `pending-smoke` / `blocked: <why>` / `uncommitted`.
- Add or refresh a single RESUME pointer near the top of the execution section:
  > `> RESUME: <next step id> — <first action, e.g. "clear S2 chrome smoke before S3">`

If the task is PRD-only (no `implement.md`), append a `## Resume` section to `prd.md` carrying the same pointer + done/pending bullets.

## Step 3: WIP commit — optional, ask once

Working-tree changes survive a normal session pause on disk. A WIP commit is only for a durable checkpoint (work spans machines, or risk of `git clean` / branch switch).

Ask once: **"Commit current work as a WIP checkpoint, or leave it in the working tree? (wip / leave)"**

- **wip** → on a task branch (never the default branch): stage the task's scope and commit
  `wip(<scope>): <task> checkpoint — resume at <step>` with the standard `Co-Authored-By` trailer. Do NOT push unless asked.
- **leave** → report the dirty paths and continue.

Do NOT archive, do NOT journal, do NOT flip task status.

## Step 4: Handoff line

Print one line:

> `Paused at <step>. Next session: /trellis-continue resumes from the implement.md RESUME pointer (<first action>). Tree: <WIP committed <hash> | uncommitted on disk>.`
