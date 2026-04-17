---
title: "Implementation Patterns for Hexagonal Effect-TS PR Review Pipeline"
date: 2026-04-17
category: best-practices
module: aligo-llm-service
problem_type: best_practice
component: service_object
severity: high
applies_when:
  - Building a new feature slice in hexagonal architecture with Effect-TS
  - Migrating existing code from raw I/O to Effect Layers and ports
  - Wiring a multi-step async pipeline (webhook to queue to LLM to external API)
  - Integrating callback-based libraries (bunqueue, job queues) with Effect runtime
tags:
  - hexagonal-architecture
  - effect-ts
  - layer-composition
  - pr-review-pipeline
  - bunqueue
  - drizzle-orm
  - webhook-hmac
  - dependency-injection
---

# Implementation Patterns for Hexagonal Effect-TS PR Review Pipeline

## Context

Phase 1 of aligo-llm-service built an AI-powered PR review platform from scratch: Bun + Elysia.js + Effect-TS + Drizzle ORM + bunqueue. The work had two parts: (1) aligning 10 existing source files to hexagonal architecture conventions, and (2) building the complete webhook-to-comment review pipeline. This doc captures the implementation patterns and gotchas discovered during the build. For the high-level architecture decisions and _why_ these technologies were chosen, see the companion ADR: `docs/solutions/best-practices/llm-service-architecture-and-validation-workflow-2026-04-16.md`. (auto memory [claude]: junior dev, 6 months experience, sole reviewer on a team generating AI code with no senior guidance)

## Guidance

### 1. Drizzle ORM + custom Effect Layer (not @effect/sql-drizzle)

The original plan specified `@effect/sql-drizzle` for database access. During brainstorm review, this was flagged as a P0 blocker: `@effect/sql-drizzle` had unverified `bun:sqlite` support, and the package wasn't installed or tested. (session history: this was caught before implementation began, saving hours of debugging)

**Pattern:** Wrap `drizzle-orm/bun-sqlite` directly in a custom Effect Layer. Define the `DrizzleDb` Context.Tag in infrastructure (it's an internal dependency, not a port). Pass an existing `bun:sqlite` Database instance to retain PRAGMA control.

```typescript
// src/infrastructure/db/drizzle-layer.ts
const sqlite = new Database("data/aligo-llm.db");
sqlite.exec("PRAGMA journal_mode = WAL");
sqlite.exec("PRAGMA busy_timeout = 5000");
const client = drizzle(sqlite, { schema });
```

Use `drizzle({ client: existingSqliteDb })` — never let Drizzle create the Database internally, or you lose PRAGMA control.

### 2. bunqueue integration via mutable callback ref

bunqueue requires its processor callback at construction time, but the Effect `ManagedRuntime` that the processor needs isn't available until the full Layer graph is built. This is a lifecycle mismatch. (session history: this pattern emerged during Unit 5/7 implementation)

**Pattern:** Create a mutable function ref. The Layer initializes bunqueue with a delegating processor. `main.ts` wires the ref to the runtime after startup.

```typescript
// bunqueue-layer.ts
let jobProcessor: ((data: JobData) => Promise<void>) | null = null;
export function setJobProcessor(fn: (data: JobData) => Promise<void>) {
  jobProcessor = fn;
}
// processor delegates to ref
processor: async (job) => {
  if (jobProcessor) await jobProcessor(job.data);
};

// main.ts — after ManagedRuntime is built
setJobProcessor(async (data) => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const service = yield* PrReviewService;
      yield* service.processReview(data);
    }),
  );
});
```

**Critical:** Use a separate SQLite file for bunqueue (`data/bunqueue.db`) from the app database (`data/aligo-llm.db`). Both use WAL mode; sharing a file causes locking contention.

### 3. Stale-commit cancellation via deterministic job IDs

When a developer pushes multiple commits to a PR, each push triggers a webhook. Without cancellation, stale commits get reviewed, wasting LLM calls on a free-tier model with rate limits.

**Pattern:** Deterministic jobId keyed on PR identity (not commit SHA): `pr-review:${owner}/${repo}#${prNumber}`. Call `removeAsync(jobId)` before `add()` — O(1) cancellation, no queue scan.

```typescript
const jobId = `pr-review:${data.owner}/${data.repo}#${data.prNumber}`;
await queue.removeAsync(jobId); // cancel pending, no-op if not found
await queue.add("review-pr", data, { jobId });
```

Each PR can only have one pending review job. The commit SHA travels inside the job data.

### 4. HMAC webhook verification with Elysia

GitHub signs webhooks with HMAC-SHA256. Verification requires the raw body before Elysia's JSON parser, and a length check before `timingSafeEqual` (which throws on unequal lengths instead of returning false).

**Pattern:** Clone the request to access raw bytes, then parse JSON separately.

```typescript
const rawBody = new Uint8Array(await request.clone().arrayBuffer());
const computed = new Bun.CryptoHasher("sha256", key).update(rawBody).digest("hex");
const a = Buffer.from(computed, "utf8");
const b = Buffer.from(headerSignature, "utf8");
if (a.length !== b.length) return 401;
if (!timingSafeEqual(a, b)) return 401;
```

Delivery dedup via `X-GitHub-Delivery` header prevents processing replayed events.

### 5. HttpClient.mapRequest for pre-configured API clients

`@effect/platform` HttpClient replaces raw `fetch` with typed requests and testable Layers.

**Pattern:** Use `HttpClient.mapRequest` to bake in auth headers, then pass the configured client around.

```typescript
const baseClient = (yield * HttpClient.HttpClient).pipe(
  HttpClient.mapRequest((req) =>
    req.pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.setHeader("X-GitHub-Api-Version", "2022-11-28"),
    ),
  ),
);
```

Use `HttpClientResponse.matchStatus` for status code routing (401 -> auth error, 429 -> rate limit, etc.). For tests, mock `FetchHttpClient.Fetch` with a `Layer.succeed` — this tests the full adapter stack including `mapRequest` transforms.

### 6. Port/adapter file organization

The signal to split a file: it contains both a `Context.Tag` and a `Layer`. Ports go in `application/ports/`, adapters go in `infrastructure/`.

```
src/
  domain/pr-review/           # Pure functions only, no Effect
  application/ports/          # Context.Tag + error types
  application/services/       # Orchestration (depends on ports)
  infrastructure/db/          # Drizzle Layer, repository Layers
  infrastructure/llm/         # OpenRouter Layer
  infrastructure/github/      # GitHub client Layer
  infrastructure/queue/       # bunqueue Layer
  presentation/               # Elysia plugins (HTTP entry points)
```

Establish this structure at project setup. Retrofitting 10 files cost a full implementation unit.

### 7. LLM failure: post error comment, don't fail silently

When the LLM provider exhausts retries, post an error comment on the PR instead of silently dropping the review. This keeps developers informed and maintains trust in the tool.

```typescript
Effect.catchTag("LlmError", (err) =>
  err.reason === "exhausted"
    ? github
        .postComment(
          owner,
          repo,
          prNumber,
          "AI review unavailable for this commit. Will retry on next push.",
        )
        .pipe(Effect.flatMap(() => deliveryRepo.updateStatus(deliveryId, "failed")))
    : Effect.fail(err),
);
```

## Why This Matters

- **Custom Effect Layer over @effect/sql-drizzle** saved hours of debugging an unverified dependency chain. The custom Layer is ~20 lines and gives full control.
- **Mutable ref for bunqueue** bridges callback-based and Effect-based lifecycles without complex abstractions.
- **Deterministic jobId** prevents wasting LLM calls on a free-tier model — each PR only gets one pending review.
- **HMAC length check** prevents a subtle timing attack where unequal Buffer lengths throw instead of returning false.
- **Hexagonal structure from day 1** makes every Layer swappable for testing. All 58 tests use mock Layers — zero real HTTP or LLM calls in the test suite.
- **Error comments instead of silence** maintain developer trust. The first impression of an AI review tool determines whether developers ignore it forever.

## When to Apply

- Building a new feature slice in hexagonal architecture with Effect-TS
- Integrating callback-based libraries (bunqueue, bull, or any job queue) with Effect's managed runtime
- Implementing webhook-driven async pipelines where "latest wins" semantics apply
- Migrating raw `fetch`/`bun:sqlite` code to `@effect/platform` HttpClient / Drizzle ORM
- Any LLM-powered automation that posts results to an external system

## Examples

**Before (mixed port+adapter, raw fetch):**

```typescript
// github-client.ts — mixed Context.Tag AND Layer in one file
export class GitHubClient extends Context.Tag("GitHubClient")<...>() {}
export const GitHubClientLayer = Layer.effect(GitHubClient,
  Effect.gen(function* () {
    // raw fetch calls inline
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  })
);
```

**After (separated, HttpClient):**

```typescript
// application/ports/github-client.ts — port only
export class GitHubClient extends Context.Tag("GitHubClient")<...>() {}

// infrastructure/github/github-client-layer.ts — adapter only
export const GitHubClientLayer = Layer.effect(GitHubClient,
  Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
    );
    // typed requests via client.execute()
  })
);
```

## Related

- **Companion ADR:** `docs/solutions/best-practices/llm-service-architecture-and-validation-workflow-2026-04-16.md` — covers _what and why_ (technology selection, Phase 0 validation, architecture rationale)
- **Requirements:** `docs/brainstorms/phase-1-alignment-and-build-requirements.md`
- **Plan:** `docs/plans/2026-04-16-002-feat-phase-1-alignment-and-build-plan.md`
- **Phase 0 decision:** `docs/phase-0-results/decision.md`
