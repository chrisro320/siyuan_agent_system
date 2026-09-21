# Frontend Development Guidelines

> Best practices for frontend development in this project.

---

## Overview

Read [Control Panel Contracts](./control-panel.md) before frontend changes. It records the implemented DOM, shared schema, polling, dirty-state, and publication-link behavior. The older topic files below remain templates, not completed project specifications.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Control Panel Contracts](./control-panel.md) | Executable browser lifecycle and state contracts | Implemented |
| [Directory Structure](./directory-structure.md) | Module organization and file layout | To fill |
| [Component Guidelines](./component-guidelines.md) | Component patterns, props, composition | To fill |
| [Hook Guidelines](./hook-guidelines.md) | Custom hooks, data fetching patterns | To fill |
| [State Management](./state-management.md) | Local state, global state, server state | To fill |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, forbidden patterns | To fill |
| [Type Safety](./type-safety.md) | Type patterns, validation | To fill |

---

## How to Fill These Guidelines

For each guideline file:

1. Document your project's **actual conventions** (not ideals)
2. Include **code examples** from your codebase
3. List **forbidden patterns** and why
4. Add **common mistakes** your team has made

The goal is to help AI assistants and new team members understand how YOUR project works.

---

**Language**: All documentation should be written in **English**.

## Quality Check

Follow Control Panel Contracts §6. Run typecheck, build, and lint, then exercise the actual browser: cold load, first-request failure/recovery, unsaved drafts, repeated saves, live candidate updates, and real SiYuan links. Repeat its built-in grep checks at review and delivery.
