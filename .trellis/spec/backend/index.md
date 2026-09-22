# Backend Development Guidelines

> Best practices for backend development in this project.

---

## Overview

Read [Runtime Contracts](./runtime-contracts.md) before backend changes. It records source, storage, providers, human-readable publication, HTTP, OMP background capture, explicit knowledge search, Hindsight coexistence, and deployment boundaries. The older topic files below remain templates; they are not evidence of a completed full spec bootstrap.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Runtime Contracts](./runtime-contracts.md) | Executable backend contracts, failure matrix, and real-service verification | Implemented |
| [Directory Structure](./directory-structure.md) | Module organization and file layout | To fill |
| [Database Guidelines](./database-guidelines.md) | ORM patterns, queries, migrations | To fill |
| [Error Handling](./error-handling.md) | Error types, handling strategies | To fill |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, forbidden patterns | To fill |
| [Logging Guidelines](./logging-guidelines.md) | Structured logging, log levels | To fill |

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

Follow Runtime Contracts §6. Run typecheck, behavior tests, build, and lint; repeat its built-in grep checks at review and delivery. SiYuan serializer or recovery changes also require an isolated real read-back/lost-response probe. Never substitute passing mocks for that evidence.
