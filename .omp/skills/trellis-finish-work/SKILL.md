---
name: trellis-finish-work
description: "Wrap up the current Trellis session: quality gate, commit reminder, task archive, journal. Trigger when the user says finish-work/收尾/收工. Thin shell: reads .omp/commands/trellis-finish-work.md and executes it verbatim."
---

# Trellis Finish Work (thin shell)

This skill is a discovery pointer. The source of truth is the slash-command file.

1. Read `.omp/commands/trellis-finish-work.md` (repo root; skip its frontmatter).
2. Execute every step in it verbatim, in order, with the tools available to you.
3. Do not improvise steps that are not in that file.

If the file is missing, tell the user Trellis commands are not installed in this project.
