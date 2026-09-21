---
description: "Initialize Trellis in this project for Oh My Pi."
---

Initialize Trellis in the current git repository. This is a **command**, not a skill — it must stay user-invocable so a throwaway directory does not pay Trellis skill tokens.

There is no `trellis-init` skill. The writer is the official CLI; this command only tells you how to run it and how to overlay the local fork.

## Step 1: Preconditions

- Must be inside a git repository. If not, stop.
- `trellis` must be on PATH (`~/.local/bin/trellis`). If missing, tell the user to install `@mindfoldhq/trellis` and stop.

## Step 2: Official scaffold

```bash
trellis init --omp --skip-existing
```

`--skip-existing` keeps files the project already customized. A first-time run writes `.trellis/` plus `.omp/{commands,skills,agents,extensions}`.

Do **not** hand-copy `.trellis/scripts` from a random tree. The CLI writes `.trellis/.template-hashes.json` and `.trellis/.version`; skipping it makes the next `trellis update` report every file as locally modified.

## Step 3: Fork overlay (this machine)

Official 0.6.15 does ship `continue.md` / `finish-work.md` / `paused-work.md`, but they are generic (platform tokens like `{{PYTHON_CMD}}`, `{{CLI_FLAG}}`, `AskUserQuestion`, `TaskCreate`, `/trellis:continue`). The fork edition hard-codes omp equivalents (`python3`, `--platform omp`, `ask`, `todo`, `/trellis-continue`), so the omp build must always win. `trellis-init.md` itself is not shipped by the official template. If the local fork exists, overlay the fork's commands + skills unconditionally; if it does not, skip this step and say so.

Fork root (first path that exists):

- `~/orca/projects/trellis/omp`

```bash
FORK="$HOME/orca/projects/trellis/omp"
HASH_FILE=".trellis/.template-hashes.json"

# Read the hash the CLI recorded for a shipped path (official original), or ''
# if the file is not recorded / the hash file is absent. Schema: hashes is a
# flat map of "path" -> "<sha256 hex>" (plain string, NOT an object).
hash_of() {
  [ -f "$HASH_FILE" ] || { printf ''; return; }
  python3 -c "import json
try:
    d = json.load(open('$HASH_FILE'))
    print(d.get('hashes', {}).get('$1', ''))
except Exception:
    print('')"
}

# Official computeHash: sha256 of CRLF->LF-normalized utf-8 content. Mirror it
# so a file that is byte-identical-but-CRLF still counts as an untouched
# original. To be safe we compute over the same normalized bytes.
current_hash() {
  python3 -c "import hashlib,sys
data = open('$1','rb').read().replace(b'\r\n', b'\n')
print(hashlib.sha256(data).hexdigest())"
}

# Write the fork file into place. Deliberately do NOT update hashes[key]: the
# stored hash still describes the official original, so a later 'trellis
# update' sees the fork content as a user-modified file and preserves it
# (or asks) rather than silently reverting the omp adaptation to upstream.
write_managed() {
  src="$1"; key="$2"
  cp -L "$src" "$key"
}

# Overlay one fork default without destroying an existing project customization.
# Missing files install directly; untouched official files are replaced; every
# other existing file stays in place and receives a reviewable `.new` sibling.
overlay_default() {
  src="$1"; key="$2"; label="$3"
  mkdir -p "$(dirname "$key")"
  if [ ! -f "$key" ]; then
    write_managed "$src" "$key"
    echo "installed $label (absent)"
    return
  fi
  orig="$(hash_of "$key")"
  now="$(current_hash "$key")"
  if [ -n "$orig" ] && [ "$orig" = "$now" ]; then
    write_managed "$src" "$key"
    echo "overlaid $label (matches official hash)"
  else
    cp -L "$src" "$key.new"
    echo "kept $label (user-modified or unrecorded); wrote $key.new"
  fi
}

# Default execution policy: implementation finishes before read-only review.
# Reviewers report findings; the main session or implementation owner repairs
# them and dispatches review again. Apply this policy consistently to workflow,
# OMP roles, the check skill, and the platform-agnostic channel check role.
overlay_default "$HOME/orca/projects/trellis/defaults/workflow.md" ".trellis/workflow.md" "Trellis workflow"
for f in trellis-implement.md trellis-check.md trellis-research.md; do
  overlay_default "$FORK/agents/$f" ".omp/agents/$f" "$f"
done
overlay_default "$FORK/skills/trellis-check/SKILL.md" ".omp/skills/trellis-check/SKILL.md" "trellis-check skill"
overlay_default "$HOME/orca/projects/trellis/defaults/agents/check.md" ".trellis/agents/check.md" "channel check role"

# omp commands: the fork edition hard-codes omp platform tokens and must win
# over the generic official template, but never clobber a user's edits.
# Only replace when the on-disk file still matches the hash the CLI recorded
# (untouched original). Otherwise keep it and drop a .new alongside.
# trellis-init.md is fork-only (the official template never ships it), so it
# is installed only when absent.
mkdir -p .omp/commands
for f in trellis-continue.md trellis-finish-work.md trellis-paused-work.md; do
  key=".omp/commands/$f"
  if [ ! -f "$key" ]; then
    write_managed "$FORK/commands/$f" "$key"
    echo "installed $f (absent)"
  else
    orig="$(hash_of "$key")"
    now="$(current_hash "$key")"
    if [ -n "$orig" ] && [ "$orig" = "$now" ]; then
      write_managed "$FORK/commands/$f" "$key"
      echo "overlaid $f (matches official hash)"
    else
      cp -L "$FORK/commands/$f" "$key.new"
      echo "kept $f (user-modified or unrecorded); wrote $key.new"
    fi
  fi
done
if [ ! -e ".omp/commands/trellis-init.md" ]; then
  cp -L "$FORK/commands/trellis-init.md" ".omp/commands/trellis-init.md"
fi

# Trellis context injection is cache-sensitive. Replace the official extension
# only when it is untouched; preserve project-specific edits beside a `.new`
# candidate instead of collapsing them into the shared overlay.
ext_key=".omp/extensions/trellis/index.ts"
mkdir -p "$(dirname "$ext_key")"
if [ ! -f "$ext_key" ]; then
  write_managed "$FORK/extensions/trellis/index.ts" "$ext_key"
  echo "installed trellis extension (absent)"
else
  orig="$(hash_of "$ext_key")"
  now="$(current_hash "$ext_key")"
  if [ -n "$orig" ] && [ "$orig" = "$now" ]; then
    write_managed "$FORK/extensions/trellis/index.ts" "$ext_key"
    echo "overlaid trellis extension (matches official hash)"
  else
    cp -L "$FORK/extensions/trellis/index.ts" "$ext_key.new"
    echo "kept trellis extension (user-modified or unrecorded); wrote $ext_key.new"
  fi
fi

# session-insight must be the omp edition (trellis-mem). The official CLI
# ships a version and records its hash; replace it only when untouched,
# otherwise preserve the user copy and drop the fork edition as .new.
si_key=".omp/skills/trellis-session-insight/SKILL.md"
if [ ! -f "$si_key" ]; then
  cp -rL "$FORK/skills/trellis-session-insight" .omp/skills/trellis-session-insight
  echo "installed session-insight (absent)"
else
  orig="$(hash_of "$si_key")"
  now="$(current_hash "$si_key")"
  if [ -n "$orig" ] && [ "$orig" = "$now" ]; then
    rm -rf .omp/skills/trellis-session-insight
    cp -rL "$FORK/skills/trellis-session-insight" .omp/skills/trellis-session-insight
    echo "overlaid session-insight (matches official hash)"
  else
    cp -rL "$FORK/skills/trellis-session-insight" .omp/skills/trellis-session-insight.new
    echo "kept session-insight (user-modified or unrecorded); wrote .new"
  fi
fi

# omp thin-shell skills: omp dispatches slash commands poorly (models trigger
# skills, not slashes). continue / finish-work / paused-work ship as skill
# discovery pointers into .omp/commands/. The official scaffold never ships
# these skill dirs, so install only when absent (preserve any user copy).
for s in trellis-continue trellis-finish-work trellis-paused-work; do
  if [ ! -e ".omp/skills/$s/SKILL.md" ]; then
    mkdir -p ".omp/skills/$s"
    cp -L "$FORK/skills/$s/SKILL.md" ".omp/skills/$s/SKILL.md"
    echo "installed thin-shell skill $s (absent)"
  else
    echo "kept thin-shell skill $s (already present)"
  fi
done

# AGENTS.md: append trellis spec & pause conventions outside the official
# managed block (<!-- TRELLIS:END -->) so official `trellis update` won't clobber it.
if [ -f "AGENTS.md" ]; then
  if ! grep -q "Trellis spec mechanism" "AGENTS.md"; then
    cat >> "AGENTS.md" << 'EOF'

## Trellis spec mechanism (mandatory when rotating between models)

- **A work order must embed the original text of two specs**: the nearest `AGENTS.md` for the target package + the relevant `.trellis/spec/` index.
- **Specs must be machine-checkable** (attach the grep command, run it before delivery and again at review time); relying on discipline alone always drifts.
- **Formatting fixes belong to the reviewer-of-record, not the auditor** — letting the auditing role edit code destroys independence.
- **Do not skip Phase 3.3 `trellis-update-spec`** (required): this batch's specs are written back so the next batch inherits them automatically.
- Deep usage (skills list / spec mechanism / migration criteria / review blind spots) → `/home/chris/orca/projects/trellis/shared/rules/trellis-handbook-omp.md`, **do not `@`-preload it**. Three moments where it must be read: ① before entering the planning phase of a new trellis task ② before handing work to another model ③ before closing out a batch.
- **Formal pause (mandatory)**: stopping mid-way through a trellis task **must use `/trellis:paused-work`** (commit + RESUME anchor + no archiving).
EOF
    echo "appended trellis spec mechanism to AGENTS.md"
  fi
fi
```

Do not rewrite the rest of `.omp/` into absolute symlinks. That wiring is kimi-agent-specific and is gitignored there.

## Step 4: Developer workspace

```bash
python3 ./.trellis/scripts/init_developer.py
```

Add `.trellis/workspace/*/journal-*.log` to the project `.gitignore` if it is not already there.

## Step 5: Report

Print:

- `.trellis/` and `.omp/` are ready
- next: `/trellis-continue` or `python3 ./.trellis/scripts/task.py create`
- cross-session search uses `trellis-mem`, not `trellis mem`
