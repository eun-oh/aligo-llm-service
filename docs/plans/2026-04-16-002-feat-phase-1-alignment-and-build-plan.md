---
title: "feat: Phase 1 Architecture Alignment and Platform Build"
type: feat
status: active
date: 2026-04-16
origin: docs/brainstorms/phase-1-alignment-and-build-requirements.md
---

# Phase 1: Architecture Alignment and Platform Build

## Overview

Refactor the existing 10 source files to match the project's hexagonal architecture conventions (CLAUDE.md), then build the remaining PR review pipeline on the aligned foundation. This produces a working webhook-driven PR review service with DRY_RUN mode, idempotency, and structured logging.

## Problem Frame

The AI PR review platform has a partially implemented Phase 1 that deviates from its own conventions: raw `fetch` instead of `@effect/platform` HttpClient, raw `bun:sqlite` instead of Drizzle ORM, flat feature directories instead of hexagonal layers, mixed port/adapter files. The remaining features (review generation, orchestration, webhook handling, job queue) need to be built. Aligning first while the codebase is small prevents compounding drift. (see origin: `docs/brainstorms/phase-1-alignment-and-build-requirements.md`)

## Requirements Trace

- R1. Hexagonal directory layout: `domain/`, `application/`, `infrastructure/`, `presentation/`
- R2. Ports (Context.Tags) in `application/`, adapters (Layers) in `infrastructure/`
- R3. `@effect/platform` HttpClient for all outbound HTTP — no raw `fetch`
- R4. Drizzle ORM schema-as-code (`drizzle-orm/bun-sqlite`) with custom Effect Layer
- R5. Config default model: `openai/gpt-oss-120b:free`
- R6. Review brief generation: diff chunks + risk → prompt → LLM → structured review
- R7. PR review orchestration: webhook → dedup → stale cancel → enqueue → process → comment (or DRY_RUN log). LLM failure → error comment.
- R8. Webhook HMAC verification (`crypto.timingSafeEqual`, SHA-256, `X-Hub-Signature-256`)
- R9. bunqueue job queue for async review processing
- R10. Health endpoint: server status, queue depth, provider connectivity, disk usage
- R11. DRY_RUN mode logs instead of posting
- R12. Effect Logger, no `console.log`
- R13. Graceful shutdown via `Effect.addFinalizer`
- R14. main.ts wires full application
- R15. Secrets via env vars, `.env.example` with minimum PAT scopes
- R16. `bun:test` runner, vitest removed
- R17. Domain unit tests
- R18. Service tests with mock Layers
- R19. E2E webhook test

## Scope Boundaries

- Feedback service and UI (Phase 2)
- Local LLM provider (Phase 2)
- Inline PR comments — summary comment only
- GitHub App — PAT only
- Multi-repo support
- Plugin system / lifecycle registry
- Drizzle Kit migration workflow — startup table creation only

## Context & Research

### Relevant Code and Patterns

- `src/config.ts` — AppConfig Effect Service pattern (reuse, update default model)
- `src/providers/llm-provider.ts` — already clean port pattern (Context.Tag + error type, no Layer). Model for other ports.
- `src/providers/openrouter-layer.ts` — Layer pattern with retry via Schedule. Migrate raw `fetch` to HttpClient.
- `src/features/pr-review/github-client.ts` — mixed port+adapter. Split, then migrate.
- `src/db/sqlite-layer.ts` — raw bun:sqlite Layer. Replace with Drizzle wrapper.
- `src/features/pr-review/diff-parser.ts`, `risk-classifier.ts` — pure domain functions, move as-is.
- `tests/diff-parser.test.ts`, `tests/risk-classifier.test.ts` — existing tests using `bun:test`, fix imports after move.

### Institutional Learnings

- `docs/solutions/best-practices/llm-service-architecture-and-validation-workflow-2026-04-16.md`:
  - Pure functions do NOT use Effect-TS. Only I/O-bound code becomes Effect Services.
  - Provider swap via env var (`LLM_PROVIDER=openrouter|local`).
  - Confidence-gated output (threshold 6/10) is critical to avoid alert fatigue.
  - DRY_RUN is a day-1 requirement, not Phase 2 polish.

### External References

- bunqueue API: Promise-based, embedded mode, deterministic `jobId` for O(1) cancellation, separate SQLite file.
- `drizzle-orm/bun-sqlite`: `drizzle({ client: existingSqliteDb })` for PRAGMA control. `sqliteTable` for schema, `$inferInsert`/`$inferSelect` for types.
- `@effect/platform` HttpClient: `HttpClient.HttpClient` tag, `HttpClientRequest.post/get`, `HttpClientResponse.matchStatus`, `HttpClient.mapRequest` for pre-configured clients, `FetchHttpClient.layer` for production, mock via `FetchHttpClient.Fetch` layer.

## Key Technical Decisions

- **Drizzle + parallel schema.sql**: Drizzle schema.ts provides typed queries. schema.sql runs at startup for table creation (matches existing pattern). Both files are source of truth — keep in sync manually. Drizzle Kit migration workflow deferred to Phase 2.
- **bunqueue separate SQLite**: bunqueue manages its own SQLite file at `data/bunqueue.db`. App DB at `data/aligo-llm.db`. No file sharing — avoids WAL/locking conflicts.
- **Deterministic jobId for stale cancellation**: `pr-review:${owner}/${repo}#${prNumber}`. Call `queue.removeAsync(jobId)` before `queue.add()` — O(1), no query scan. If job is already processing, it completes (accepted trade-off: rare, and the review is almost done anyway).
- **Feedback table carried forward**: Kept in both schema.sql and Drizzle schema.ts. Costs nothing, Phase 2 needs it.
- **HttpClient as Layer dependency**: Adapter Layers (`GitHubClientLayer`, `OpenRouterLayer`) depend on `HttpClient.HttpClient`. In production: `FetchHttpClient.layer`. In tests: mock `FetchHttpClient.Fetch` layer.
- **Prompt template in domain**: `src/domain/pr-review/prompts/review-brief.txt` — it's the core business logic template. A pure `buildPrompt()` function fills template variables.

## Open Questions

### Resolved During Planning

- **bunqueue job removal API**: Use deterministic `jobId` + `queue.removeAsync(jobId)`. No custom query needed.
- **bunqueue SQLite sharing**: Separate files. bunqueue cannot accept an external Database instance.
- **Drizzle startup table creation**: Keep schema.sql + `db.exec(schema)` at startup. No runtime drizzle-kit.
- **Feedback table**: Carry forward in schema definitions.
- **HMAC verification algorithm**: GitHub uses SHA-256, header `X-Hub-Signature-256`, verify entire raw body.

### Deferred to Implementation

- Exact method signatures and helper names will emerge during implementation
- Prompt template variable interpolation format (string replace vs template literal) — decided at implementation time
- Whether bunqueue events (`completed`, `failed`) need Effect Logger integration — evaluate during Unit 6

## High-Level Technical Design

> _This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce._

```
                    ┌─────────────────────────────────────┐
                    │        src/presentation/            │
                    │  webhook-plugin.ts  health-plugin.ts │
                    │  (HMAC verify)      (queue depth)    │
                    └──────────┬──────────────────────────┘
                               │ Effect.runPromise()
                    ┌──────────▼──────────────────────────┐
                    │       src/application/               │
                    │                                      │
                    │  services/                           │
                    │    pr-review-service.ts (orchestrate) │
                    │    review-brief-service.ts (LLM call)│
                    │                                      │
                    │  ports/                              │
                    │    llm-provider.ts    (Context.Tag)  │
                    │    github-client.ts   (Context.Tag)  │
                    │    delivery-repo.ts   (Context.Tag)  │
                    │    review-repo.ts     (Context.Tag)  │
                    │    job-queue.ts       (Context.Tag)  │
                    └──────────┬──────────────────────────┘
                               │ depends on
          ┌────────────────────┼────────────────────────┐
          │                    │                         │
┌─────────▼─────────┐ ┌───────▼────────┐ ┌─────────────▼──────┐
│  src/domain/      │ │ src/infra/     │ │ src/infra/         │
│  pr-review/       │ │ llm/           │ │ db/                │
│   diff-parser.ts  │ │  openrouter-   │ │  schema.ts         │
│   risk-classifier │ │  layer.ts      │ │  drizzle-layer.ts  │
│   prompt-builder  │ │ github/        │ │  delivery-repo-    │
│   prompts/        │ │  github-       │ │  layer.ts          │
│    review-brief   │ │  client-       │ │  review-repo-      │
│    .txt           │ │  layer.ts      │ │  layer.ts          │
└───────────────────┘ │ queue/         │ └────────────────────┘
                      │  bunqueue-     │
                      │  layer.ts      │
                      └────────────────┘
```

## Implementation Units

- [ ] **Unit 1: Project setup and domain layer**

  **Goal:** Install dependencies, create hexagonal directory scaffold, move pure domain files, fix config, set up test runner.

  **Requirements:** R1, R5, R12, R15, R16, R17

  **Dependencies:** None

  **Files:**
  - Modify: `package.json` (add `drizzle-orm`, remove `vitest`, `@effect/vitest`, update scripts: `"test": "bun test"`, `"test:watch": "bun test --watch"`)
  - Modify: `tsconfig.json` (verify path mappings if needed)
  - Create: `src/domain/pr-review/diff-parser.ts` (move from `src/features/pr-review/`)
  - Create: `src/domain/pr-review/risk-classifier.ts` (move from `src/features/pr-review/`)
  - Create: `src/domain/pr-review/prompt-builder.ts` (new: pure function to fill template vars)
  - Create: `src/domain/pr-review/prompts/review-brief.txt` (move from `src/features/pr-review/prompts/`)
  - Modify: `src/config.ts` (change default model to `openai/gpt-oss-120b:free`, remove `localModelUrl` and `localModelName` config fields — no Phase 1 consumer)
  - Create: `.env.example` (all required env vars with comments, minimum PAT scopes)
  - Modify: `tests/diff-parser.test.ts` (fix imports)
  - Modify: `tests/risk-classifier.test.ts` (fix imports)

  **Approach:**
  - `bun add drizzle-orm` and `bun remove vitest @effect/vitest`
  - Create empty directories: `src/domain/`, `src/application/ports/`, `src/application/services/`, `src/infrastructure/db/`, `src/infrastructure/llm/`, `src/infrastructure/github/`, `src/infrastructure/queue/`, `src/presentation/`
  - Move domain files as-is — they are pure and have no dependency changes
  - `prompt-builder.ts`: pure function that reads template string + context object, returns filled prompt string. No I/O — template content is passed in.
  - Update `config.ts` default from `anthropic/claude-sonnet-4` to `openai/gpt-oss-120b:free`
  - `.env.example` documents: `OPENROUTER_API_KEY`, `GITHUB_TOKEN` (scopes: `repo` read, `pull_requests` write), `WEBHOOK_SECRET`, `CONFIDENCE_THRESHOLD`, `DRY_RUN`, `PORT`, `LLM_TEMPERATURE`, `LLM_PROVIDER`, `BUNQUEUE_DATA_PATH`

  **Patterns to follow:**
  - Existing `diff-parser.ts` and `risk-classifier.ts` — pure functions, no Effect

  **Test scenarios:**
  - Happy path: `buildPrompt` with complete context returns filled template with all sections
  - Edge case: `buildPrompt` with empty diff returns template with "No changes" or similar placeholder
  - Happy path: existing diff-parser tests pass after import path change
  - Happy path: existing risk-classifier tests pass after import path change

  **Verification:**
  - `bun test` passes with updated imports
  - `bun run check-types` passes
  - No files remain in `src/features/` or `src/providers/` (empty or deleted after subsequent units)
  - `.env.example` exists with all documented vars

- [ ] **Unit 2: Application ports and infrastructure split**

  **Goal:** Define all port interfaces in `application/ports/` and move adapter implementations to `infrastructure/`. Split mixed port+adapter files.

  **Requirements:** R1, R2

  **Dependencies:** Unit 1

  **Files:**
  - Create: `src/application/ports/llm-provider.ts` (move from `src/providers/llm-provider.ts`)
  - Create: `src/application/ports/github-client.ts` (extract Context.Tag + GithubError from `src/features/pr-review/github-client.ts`)
  - Create: `src/application/ports/delivery-repository.ts` (new port)
  - Create: `src/application/ports/review-repository.ts` (new port)
  - Create: `src/application/ports/job-queue.ts` (new port)
  - Create: `src/infrastructure/llm/openrouter-layer.ts` (move from `src/providers/openrouter-layer.ts`)
  - Create: `src/infrastructure/github/github-client-layer.ts` (extract Layer from `src/features/pr-review/github-client.ts`)
  - Note: `src/db/sqlite-layer.ts` stays in place until Unit 3 replaces it with drizzle-layer.ts (no temporary move)
  - Delete: `src/providers/llm-provider.ts`, `src/providers/openrouter-layer.ts`, `src/features/pr-review/github-client.ts`, `src/db/sqlite-layer.ts`

  **Approach:**
  - `llm-provider.ts` is already a clean port (Tag + error type only). Move as-is.
  - `github-client.ts` mixed: extract `GitHubClient` Tag + `GithubError` → `application/ports/github-client.ts`. Extract `GitHubClientLayer` + `rateLimitRetry` → `infrastructure/github/github-client-layer.ts`.
  - New port interfaces define only the contract shape:
    - `DeliveryRepository`: `save`, `findByDeliveryId`, `findPending(repo, prNumber)`, `updateStatus`
    - `ReviewRepository`: `save`, `findByDeliveryId`
    - `JobQueue`: `enqueue`, `cancel(jobId)`, `getQueueDepth`, `close`
  - Port files export only: Context.Tag, error types, and the service shape type. No implementation.

  **Patterns to follow:**
  - `src/providers/llm-provider.ts` — the existing clean port pattern (Tag + error, no Layer)

  **Test scenarios:**
  - Happy path: `bun run check-types` passes with all new port definitions
  - Happy path: `bun test` still passes (no behavior change, only file moves and splits)

  **Verification:**
  - Every Context.Tag lives in `src/application/ports/`
  - Every Layer lives in `src/infrastructure/`
  - No file in `application/` imports from `infrastructure/`
  - `bun run check-types` passes

- [ ] **Unit 3: Drizzle DB layer and repositories**

  **Goal:** Replace raw `bun:sqlite` Layer with Drizzle ORM. Implement delivery and review repository adapters.

  **Requirements:** R4

  **Dependencies:** Unit 2

  **Files:**
  - Create: `src/infrastructure/db/schema.ts` (Drizzle schema-as-code)
  - Modify: `src/db/schema.sql` (keep for startup, ensure matches Drizzle schema — including feedback table)
  - Create: `src/infrastructure/db/drizzle-layer.ts` (DrizzleDb Context.Tag + Layer)
  - Create: `src/infrastructure/db/delivery-repository-layer.ts`
  - Create: `src/infrastructure/db/review-repository-layer.ts`
  - Delete: `src/db/sqlite-layer.ts` (replaced by drizzle-layer.ts)
  - Test: `tests/delivery-repository.test.ts`
  - Test: `tests/review-repository.test.ts`

  **Approach:**
  - `schema.ts`: define `deliveries`, `reviews`, `feedback` tables using `sqliteTable` from `drizzle-orm/sqlite-core`. Match existing schema.sql exactly. Export inferred types.
  - `drizzle-layer.ts`: `Layer.scoped` that creates `bun:sqlite` Database → sets PRAGMAs → runs schema.sql → wraps with `drizzle({ client: sqlite })` → exposes drizzle instance. `Effect.addFinalizer` closes DB.
  - Repository Layers depend on DrizzleDb and implement the port interfaces using typed Drizzle queries (`db.select().from(deliveries).where(eq(...))`)
  - `DeliveryRepository.findPending(repo, prNumber)` — used by orchestrator to find stale commits to cancel
  - Delivery state machine: `pending` → [`completed` | `failed` | `cancelled`]. Pending: waiting for job processing. Completed: review generated and posted (or logged in DRY_RUN). Failed: LLM or GitHub error after retries exhausted. Cancelled: newer push arrived, prior job removed from queue before processing.

  **Patterns to follow:**
  - Current `sqlite-layer.ts` — Layer.scoped pattern with addFinalizer

  **Test scenarios:**
  - Happy path: insert delivery, retrieve by delivery_id — matches
  - Happy path: insert review with delivery_id FK — retrieves with correct association
  - Edge case: duplicate delivery_id insert — handled (UNIQUE constraint or upsert)
  - Happy path: `findPending(repo, prNumber)` returns pending deliveries for a PR
  - Happy path: `updateStatus` transitions delivery from pending → completed
  - Edge case: `findByDeliveryId` with non-existent ID returns null/None

  **Verification:**
  - All raw `db.run/get/all` calls replaced with Drizzle typed queries
  - `bun test` passes repository tests
  - Schema.ts table definitions match schema.sql

- [ ] **Unit 4: HttpClient migration**

  **Goal:** Replace all raw `fetch` calls with `@effect/platform` HttpClient in both adapter Layers.

  **Requirements:** R3

  **Dependencies:** Unit 2

  **Files:**
  - Modify: `src/infrastructure/llm/openrouter-layer.ts`
  - Modify: `src/infrastructure/github/github-client-layer.ts`
  - Test: `tests/openrouter-layer.test.ts`
  - Test: `tests/github-client-layer.test.ts`

  **Approach:**
  - Both Layers gain `HttpClient.HttpClient` as a dependency (yielded in `Effect.gen`)
  - OpenRouter: `HttpClientRequest.post(url).pipe(HttpClientRequest.bodyUnsafeJson(body), HttpClientRequest.bearerToken(key))` → `client.execute(request)` → `HttpClientResponse.matchStatus({ 401: auth error, 429: rate limit, "2xx": parse JSON, orElse: unknown error })`
  - GitHub: same pattern. Use `HttpClient.mapRequest` to bake in auth headers and API version header. `fetchDiff`: Accept header `application/vnd.github.v3.diff`. `postComment`: POST with JSON body.
  - Remove all `Effect.tryPromise({ try: () => fetch(...) })` wrappers
  - Map `HttpClientError.RequestError` (transport) to existing error types (`LlmError`, `GithubError`)
  - Retain existing retry policies (Schedule-based) — they work the same with typed errors
  - Layer composition in main.ts will need `FetchHttpClient.layer` provided

  **Patterns to follow:**
  - Existing retry policies in `openrouter-layer.ts` and `github-client-layer.ts`
  - `HttpClient.mapRequest` for pre-configured client (bake in auth)

  **Test scenarios:**
  - Happy path: OpenRouter complete() returns parsed content from 200 response
  - Error path: OpenRouter 401 → LlmError with reason "auth"
  - Error path: OpenRouter 429 → LlmError with reason "rate_limit", retry triggered
  - Error path: OpenRouter retries exhausted → LlmError reason "exhausted"
  - Error path: OpenRouter empty response body → LlmError reason "parse"
  - Happy path: GitHub fetchDiff returns raw diff text
  - Happy path: GitHub postComment succeeds, truncates body > 65536 chars
  - Error path: GitHub 401 → GithubError reason "auth"
  - Error path: GitHub 429 → GithubError reason "rate_limit", retry triggered
  - Error path: GitHub 404 → GithubError reason "not_found"

  **Verification:**
  - Zero `fetch(` calls remain in `src/`
  - All tests pass with mock `FetchHttpClient.Fetch` layers
  - `bun run check-types` passes

- [ ] **Unit 5: Job queue layer**

  **Goal:** Integrate bunqueue as the async job queue, wrapped in an Effect Layer implementing the JobQueue port.

  **Requirements:** R9

  **Dependencies:** Unit 2

  **Files:**
  - Create: `src/infrastructure/queue/bunqueue-layer.ts`
  - Test: `tests/bunqueue-layer.test.ts`

  **Approach:**
  - Use `Bunqueue` simple mode with `embedded: true` and `dataPath` from config (`BUNQUEUE_DATA_PATH` or default `data/bunqueue.db`)
  - Processor function: receives job, calls the review pipeline (injected via closure or Effect context)
  - `enqueue(owner, repo, prNumber, commitSha, deliveryId)`: deterministic jobId `pr-review:${owner}/${repo}#${prNumber}`. Call `removeAsync(jobId)` first (cancel any pending), then `add()`.
  - `cancel(jobId)`: delegates to `queue.removeAsync(jobId)` — no-op if not found
  - `getQueueDepth()`: `queue.getWaitingCount()` or similar
  - `close()`: `app.close()` for graceful shutdown
  - Wrap all async methods in `Effect.tryPromise` with a `QueueError` tagged error
  - Layer uses `Effect.acquireRelease` or `Layer.scoped` for lifecycle

  **Patterns to follow:**
  - `sqlite-layer.ts` — Layer.scoped with Effect.addFinalizer for cleanup

  **Test scenarios:**
  - Happy path: enqueue a job, verify it appears in waiting state
  - Happy path: enqueue replaces existing job for same PR (deterministic jobId)
  - Happy path: cancel removes a pending job
  - Edge case: cancel non-existent jobId is a no-op (no error)
  - Happy path: getQueueDepth returns correct count
  - Happy path: close shuts down gracefully

  **Verification:**
  - bunqueue creates its own SQLite file at configured path (not the app DB path)
  - All tests pass
  - `bun run check-types` passes

- [ ] **Unit 6: Core application services**

  **Goal:** Build the review brief service and PR review orchestration service — the business logic core.

  **Requirements:** R6, R7, R11, R12

  **Dependencies:** Units 1, 2, 3, 4, 5

  **Files:**
  - Create: `src/application/services/review-brief-service.ts`
  - Create: `src/application/services/pr-review-service.ts`
  - Test: `tests/review-brief-service.test.ts`
  - Test: `tests/pr-review-service.test.ts`

  **Approach:**
  - **ReviewBriefService**: Effect Service that depends on `LlmProvider`. Takes diff chunks + risk assessments → calls `buildPrompt()` (domain) to fill template → calls `LlmProvider.complete()` → returns the raw review text. Temperature 0.2, max tokens 4096.
  - **PrReviewService**: Effect Service that orchestrates the full pipeline. Depends on `GitHubClient`, `DeliveryRepository`, `ReviewRepository`, `JobQueue`, `ReviewBriefService`, `AppConfig`.
    - `handleWebhook(payload)`: checks `X-GitHub-Delivery` against DeliveryRepository (dedup) → saves delivery as 'pending' → calls `JobQueue.enqueue()` (which internally cancels stale)
    - `processReview(job)`: fetches diff via GitHubClient → parses with `parseDiff` → classifies with `classifyRisks` → generates brief via ReviewBriefService → saves review to ReviewRepository → posts comment via GitHubClient (or logs if DRY_RUN) → updates delivery to 'completed'
    - On LLM failure (LlmError exhausted): posts error comment ("AI review unavailable for this commit. Will retry on next push.") → marks delivery 'failed' → logs structured error
  - All logging via Effect Logger (structured JSON). No console.log anywhere.

  **Patterns to follow:**
  - `openrouter-layer.ts` — retry with Schedule, error mapping
  - Domain functions (`parseDiff`, `classifyRisks`, `buildPrompt`) called as pure functions, not through Effect Services

  **Test scenarios:**
  - Happy path: ReviewBriefService produces review from valid diff chunks + risk assessments
  - Edge case: ReviewBriefService with empty diff chunks returns meaningful "no changes" review
  - Happy path: handleWebhook saves delivery and enqueues job
  - Happy path: handleWebhook with duplicate X-GitHub-Delivery is skipped (returns early)
  - Happy path: processReview runs full pipeline → saves review → posts comment
  - Happy path: processReview in DRY_RUN mode logs review instead of posting
  - Error path: processReview with LLM failure → posts error comment, marks delivery failed
  - Integration: enqueue for same PR cancels previous pending job, only latest processes

  **Verification:**
  - All tests pass with mock Layers (no real HTTP or DB calls)
  - DRY_RUN flag correctly controls comment posting vs logging
  - Error paths produce structured log output, not unhandled exceptions

- [ ] **Unit 7: Presentation layer and main.ts assembly**

  **Goal:** Create Elysia plugins for webhook and health endpoints, wire everything together in main.ts.

  **Requirements:** R8, R10, R13, R14

  **Dependencies:** Unit 6

  **Files:**
  - Create: `src/presentation/webhook-plugin.ts`
  - Create: `src/presentation/health-plugin.ts`
  - Modify: `src/main.ts` (full rewrite from hello-world)
  - Test: `tests/webhook-hmac.test.ts`

  **Approach:**
  - **webhook-plugin.ts**: Elysia plugin (`new Elysia({ name: 'webhook' })`). POST `/webhook` route.
    - HMAC verification: read `X-Hub-Signature-256` header. Access raw request body before Elysia's JSON parser (use `onParse` hook or `arrayBuffer` body type). Compute `sha256=HMAC(secret, rawBody)`, convert both computed and header values to `Buffer`, verify `a.length === b.length` before calling `crypto.timingSafeEqual(a, b)`. Reject with 401 on mismatch or length difference.
    - Parse webhook payload: extract `action`, `pull_request.number`, `pull_request.title`, `repository.full_name`, `pull_request.head.sha`. Only process `action === 'opened' || action === 'synchronize'`. Thread `pr_title` through to ReviewBriefService for prompt template.
    - Call `PrReviewService.handleWebhook()` via `Effect.runPromise()`.
    - Return 202 Accepted immediately (async processing via queue).
  - **health-plugin.ts**: Elysia plugin. GET `/health`.
    - Returns JSON: `{ status: "ok", queue: { depth: N }, provider: { name, reachable: bool }, disk: { usagePercent: N } }`
    - Provider connectivity: lightweight check (not a full LLM call)
    - Disk usage: `Bun.file("data/").size` or `statfs` equivalent
  - **main.ts**: Compose all Effect Layers into a single live Layer. Create Elysia app, register plugins with decorated Effect runtime. Start bunqueue worker. `Effect.addFinalizer` for server close + queue drain. Log startup with Effect Logger.

  **Patterns to follow:**
  - Elysia plugin pattern: https://elysiajs.com/essential/plugin.html
  - `Effect.runPromise()` at the Elysia↔Effect boundary

  **Test scenarios:**
  - Happy path: valid HMAC + `action: opened` → 202 Accepted
  - Error path: invalid HMAC → 401
  - Error path: missing `X-Hub-Signature-256` header → 401
  - Edge case: `action: closed` (not opened/synchronize) → 200 OK, no processing
  - Happy path: `/health` returns correct JSON shape with queue depth

  **Verification:**
  - Server starts with `bun run dev`, health endpoint responds
  - HMAC verification rejects tampered payloads
  - `bun run check-types` passes

- [ ] **Unit 8: E2E test and final integration**

  **Goal:** End-to-end test proving the full pipeline works, plus final cleanup.

  **Requirements:** R18, R19

  **Dependencies:** Unit 7

  **Files:**
  - Create: `tests/e2e/webhook.e2e.test.ts`
  - Delete: old empty directories (`src/features/`, `src/providers/`, `src/db/`)

  **Approach:**
  - E2E test creates a full application with DRY_RUN=true and mock Layers for LLM and GitHub (but real Drizzle + bunqueue with temp DB files)
  - Sends a POST to `/webhook` with a valid HMAC-signed GitHub payload
  - Waits for job processing (poll delivery status or use bunqueue events)
  - Asserts: delivery saved, review saved with prompt and LLM output, DRY_RUN log produced (no GitHub API call)
  - Second test: send duplicate `X-GitHub-Delivery` → verify dedup (no second review)
  - Third test: send two webhooks for same PR with different SHAs → verify only latest processes
  - Clean up old directories that are now empty

  **Patterns to follow:**
  - Existing test files use `describe`/`test`/`expect` from `bun:test`

  **Test scenarios:**
  - Happy path: webhook POST → delivery saved → review generated → DRY_RUN log (no GitHub comment)
  - Happy path: duplicate X-GitHub-Delivery → second request is deduped, only one review exists
  - Happy path: two pushes to same PR (different SHAs) → only latest SHA review exists, older cancelled
  - Error path: malformed webhook payload → 400 or validation error
  - Error path: LLM failure during processing → delivery marked failed, error comment would be posted (mocked)

  **Verification:**
  - `bun test` — all unit, service, and E2E tests pass
  - `bun run check-types` passes
  - `bun run lint` passes
  - No files remain in old directory structure (`src/features/`, `src/providers/`, `src/db/`)

## System-Wide Impact

- **Interaction graph:** Webhook POST → HMAC verify → PrReviewService.handleWebhook() → DeliveryRepository (dedup) → JobQueue.enqueue() → [async] PrReviewService.processReview() → GitHubClient.fetchDiff() → domain functions → LlmProvider.complete() → GitHubClient.postComment()
- **Error propagation:** LlmError and GithubError propagate through Effect's typed error channel. Exhausted LLM retries → error comment posted to PR. GitHub post failure → logged, delivery marked failed. Queue errors → logged, job retried by bunqueue (up to configured attempts).
- **State lifecycle risks:** Dual-layer idempotency (X-GitHub-Delivery + PR+SHA) prevents duplicate work. Stale cancellation uses deterministic jobId for O(1) removal. Active jobs that can't be cancelled will complete harmlessly (the review is still valid, just not the latest).
- **Unchanged invariants:** Phase 0 test harness (`scripts/phase-0-test.ts`) and test diffs (`test-diffs/`) are unaffected. Prompt template content unchanged — only its file location moves.

## Risks & Dependencies

| Risk                                             | Mitigation                                                                                      |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| bunqueue API doesn't support needed operations   | Research confirmed: removeAsync, deterministic jobId, embedded mode all supported in v2.7.4     |
| drizzle-orm/bun-sqlite PRAGMA support            | Use `drizzle({ client: existingDb })` — PRAGMAs set on raw Database before wrapping             |
| Dual schema.sql + schema.ts drift                | Lightweight — only 3 tables. Phase 2 adds Drizzle Kit for single source of truth                |
| OpenRouter free tier rate limits                 | Stale-commit cancellation prevents wasted calls. Error comment on failure keeps users informed. |
| @effect/platform HttpClient API breaking changes | Pinned at ^0.96.0 in package.json. Effect ecosystem moves fast but minor versions are stable.   |

## Sources & References

- **Origin document:** [docs/brainstorms/phase-1-alignment-and-build-requirements.md](docs/brainstorms/phase-1-alignment-and-build-requirements.md)
- Related code: `src/config.ts`, `src/providers/llm-provider.ts`, `src/providers/openrouter-layer.ts`, `src/features/pr-review/github-client.ts`, `src/db/sqlite-layer.ts`
- Related plan: `docs/plans/2026-04-16-001-feat-phase-0-llm-validation-plan.md`
- Phase 0 decision: `docs/phase-0-results/decision.md`
- Institutional learnings: `docs/solutions/best-practices/llm-service-architecture-and-validation-workflow-2026-04-16.md`
- Elysia plugin docs: https://elysiajs.com/essential/plugin.html
- GitHub webhook HMAC: SHA-256, `X-Hub-Signature-256` header, verify entire raw body
