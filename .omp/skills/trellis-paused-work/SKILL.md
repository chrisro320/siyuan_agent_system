---
name: trellis-paused-work
description: "Pause the current Trellis task formally: WIP commit on task branch, RESUME anchor, no archiving. Trigger when the user says paused-work/暂停/先停这里, or when work must stop mid-task (blocked, needs another model/session to continue). Thin shell: reads .omp/commands/trellis-paused-work.md and executes it verbatim."
---

# Trellis Paused Work (thin shell)

This skill is a discovery pointer. The source of truth is the slash-command file.

1. Read `.omp/commands/trellis-paused-work.md` (repo root; skip its frontmatter).
2. Execute every step in it verbatim, in order, with the tools available to you.
3. Do not improvise steps that are not in that file.

If the file is missing, tell the user Trellis commands are not installed in this project.
