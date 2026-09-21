---
name: trellis-continue
description: "Resume work on the current Trellis task at the correct phase. Trigger when the user says continue, asks 继续/上次到哪了, or a paused/active task needs to be picked up. Thin shell: reads .omp/commands/trellis-continue.md and executes it verbatim."
---

# Trellis Continue (thin shell)

This skill is a discovery pointer. The source of truth is the slash-command file.

1. Read `.omp/commands/trellis-continue.md` (repo root; skip its frontmatter).
2. Execute every step in it verbatim, in order, with the tools available to you.
3. Do not improvise steps that are not in that file.

If the file is missing, tell the user Trellis commands are not installed in this project.
