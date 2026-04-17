---
date: 2026-04-16
topic: phase-1-alignment-and-build
---

# Phase 1: Architecture Alignment and Platform Build

## Problem Frame

The AI PR review platform has Phase 1 partially implemented (10 source files: 8 TypeScript, 1 SQL schema, 1 prompt template), but the existing code deviates from the project's architecture conventions (CLAUDE.md). Raw `fetch` is used instead of `@effect/platform` HttpClient. Raw `bun:sqlite` is used instead of Drizzle + `@effect/sql-drizzle`. Files are organized in a flat feature structure instead of the documented hexagonal layers. Port interfaces and adapter implementations are mixed in the same files. The config default model doesn't match the Phase 0 decision. `console.log` is used in `main.ts` instead of Effect Logger.

Building the remaining features on top of the misaligned foundation would compound the drift. Aligning now — while the codebase is 8 files — is cheaper than retrofitting later.

## Requirements

**Architecture Alignment**

- R1. All source files follow the hexagonal directory layout: `domain/`, `application/`, `infrastructure/`, `presentation/` under `src/`
- R2. Port interfaces (Context.Tags + error types) are separated from their Layer implementations. Ports in `application/`, adapters in `infrastructure/`
- R3. All outbound HTTP calls use `@effect/platform` HttpClient — no raw `fetch`
- R4. Database schema defined with Drizzle ORM schema-as-code (`drizzle-orm/bun-sqlite`). Queries execute through a custom Effect Layer wrapping Drizzle (not `@effect/sql-drizzle`)
- R5. Config default model updated to `openai/gpt-oss-120b:free` (matches Phase 0 decision)

**Core PR Review Pipeline**

- R6. Review brief generation: takes diff chunks + risk assessments, builds prompt from template, calls LLM, returns structured review output
- R7. PR review orchestration: webhook → delivery dedup (`X-GitHub-Delivery`) → stale-commit cancellation (cancel pending queue jobs for same PR, mark as 'cancelled') → enqueue → process → post comment (or log in DRY_RUN). On LLM failure after retries exhausted: post error comment on PR ("AI review unavailable"), mark delivery as 'failed', log structured error.
- R8. Webhook endpoint with HMAC verification (`crypto.timingSafeEqual`) rejects invalid payloads with 401
- R9. Job queue uses bunqueue (SQLite-backed) for async review processing

**Operational Readiness**

- R10. Health endpoint returns: server status, queue depth, provider connectivity, disk usage
- R11. DRY_RUN mode logs reviews to stdout instead of posting to GitHub
- R12. Structured JSON logging via Effect Logger — no `console.log`
- R13. Graceful shutdown: finish in-progress work before stopping (`Effect.addFinalizer`)

**Application Assembly**

- R14. main.ts wires the full application: Effect layer composition, Elysia plugin registration, bunqueue startup, graceful shutdown hook

**Credential Management**

- R15. All secrets (webhook secret, GitHub PAT, OpenRouter key) via environment variables through Effect Config. `.env.example` documents all required vars with minimum PAT scopes (`repo` read + `pull_requests` write). Secrets manager deferred to Phase 2.

**Testing**

- R16. Tests use bun's built-in test runner (`bun:test`), not vitest. vitest devDependency removed.
- R17. Pure domain functions (diff-parser, risk-classifier) have unit tests
- R18. Effect services have Layer-swapped tests (mock Layers for LLM, GitHub, DB)
- R19. E2E test: POST mock webhook payload → verify review generated (logged in DRY_RUN)

## Success Criteria

- No raw `fetch` calls remain — all HTTP goes through `@effect/platform` HttpClient
- No raw `bun:sqlite` usage — all DB access through Drizzle ORM (`drizzle-orm/bun-sqlite`) wrapped in a custom Effect Layer
- Source files organized in hexagonal layers with no inward-dependency violations
- A webhook POST triggers: diff fetch → chunk → risk classify → LLM review → comment (or DRY_RUN log)
- Duplicate `X-GitHub-Delivery` is skipped; rapid pushes cancel pending queue jobs for stale commits
- LLM failure after retries posts error comment on PR, does not fail silently
- `bun test` passes (bun:test, not vitest), `bun run check-types` passes
- `/health` returns queue depth and provider status

## Scope Boundaries

- Feedback service, feedback UI (Phase 2)
- Local LLM provider (Phase 2)
- Inline PR comments — summary comment only in v1
- GitHub App — PAT for Phase 1
- Multi-repo support
- Plugin system / lifecycle registry
- Drizzle Kit migration workflow — tables created from schema definition at startup, formal migrations deferred

## Key Decisions

- **Align before building:** Refactor existing 8 files first, then build new features on the aligned foundation
- **Phase 0 results accepted as-is:** `openai/gpt-oss-120b:free` selected from informal 5-PR test. Paid fallback models evaluated in Phase 2
- **Ports separated from adapters:** Each Context.Tag in `application/`, each Layer in `infrastructure/`. Enables clean Layer swap for testing
- **Drizzle ORM without @effect/sql:** Use `drizzle-orm/bun-sqlite` directly, wrapped in a custom Effect Layer. Avoids unverified `@effect/sql-drizzle` dependency while keeping schema-as-code and typed queries. CLAUDE.md convention will be updated to match.
- **Prompt template stays as file:** `review-brief.txt` read at startup. Allows non-code prompt iteration

## Dependencies / Assumptions

- OpenRouter API accessible from Naver Cloud (verified in Phase 0)
- `drizzle-orm/bun-sqlite` has first-class bun:sqlite support (no `@effect/sql` dependency needed)
- bunqueue is compatible with Effect runtime — may need a thin Layer wrapper

## Outstanding Questions

### Deferred to Planning

- [Affects R4][Technical] Design the Drizzle ORM Effect Layer: wrap `drizzle-orm/bun-sqlite` in a custom Effect Layer for DI and testability (replaces the current raw `SqliteDb` Layer)
- [Affects R9][Needs research] How does bunqueue integrate with Effect? Own Layer? Shared SQLite DB file? Does it expose a job-removal API for queue-side stale-commit cancellation (required by R7)?
- [Affects R4][Technical] Existing schema.sql includes a `feedback` table (Phase 2). When migrating to Drizzle schema: carry forward in schema definition, or drop?

## Next Steps

-> `/ce:plan` for structured implementation planning
