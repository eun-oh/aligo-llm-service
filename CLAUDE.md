# aligo-llm-service

AI-powered dev automation platform. PR review is the first feature.

## Stack

- **Runtime:** Bun
- **HTTP:** Elysia.js (plugins for modularity)
- **Business logic:** Effect-TS (services, layers, typed errors, retries, DI)
- **Database:** Drizzle ORM + bun:sqlite (WAL mode, busy_timeout)
- **Queue:** bunqueue (SQLite-backed job queue)
- **LLM:** OpenRouter (default model: openai/gpt-oss-120b:free)

## Architecture Rules

This project uses **hexagonal architecture** with feature-based slices.

### Layers

```
src/
  domain/          # Pure business logic. No I/O, no Effect services, no imports from infra.
  application/     # Use cases / orchestration. Depends on domain + port interfaces.
  infrastructure/  # Adapters implementing ports. DB, HTTP clients, LLM providers.
  presentation/    # Elysia plugins (driving adapters). HTTP entry points only.
```

### Rules

1. **Domain is pure.** Functions in `domain/` must have no side effects, no Effect services, no database or HTTP calls. They take data in, return data out. Examples: `diff-parser.ts`, `risk-classifier.ts`.

2. **Ports are Effect Services.** Define capabilities as `Context.Tag` in the application layer. Infrastructure provides the `Layer` implementations.

3. **Infrastructure implements ports.** Each adapter (OpenRouter, GitHub, Drizzle, bunqueue) provides a `Layer` that satisfies a port. Swap layers for testing.

4. **Presentation is Elysia plugins.** Each feature exposes an Elysia plugin that wires HTTP routes to application services via `Effect.runPromise()`. Follow the Elysia plugin pattern: https://elysiajs.com/essential/plugin.html

5. **Dependencies flow inward.** Domain depends on nothing. Application depends on domain. Infrastructure depends on application (implements its ports). Presentation depends on application.

## Effect-TS Conventions

### Required packages

- `effect` — core (Effect, Layer, Context, Schema, Config, Logger, Schedule)
- `@effect/platform` — HttpClient for all outbound HTTP calls (OpenRouter, GitHub API), FileSystem for file reads
- `drizzle-orm` — schema-as-code and typed queries, wrapped in a custom Effect Layer (not `@effect/sql-drizzle`)

### Rules

1. **Use `effect/Schema`** for all request/response validation at system boundaries. No manual JSON parsing.

2. **Use `@effect/platform` HttpClient** for all outbound HTTP calls. No raw `fetch`. This gives typed requests/responses, automatic retries, and testable layers.

3. **Use Effect `Logger`** for all logging. No `console.log` or custom logger. Structured logging is built-in.

4. **Use Effect `Config`** for all environment variable access. No `process.env` reads outside of config.

5. **Use `drizzle-orm` with a custom Effect Layer** for all database access. No raw SQL strings. Schema defined with Drizzle (`drizzle-orm/bun-sqlite`), queries wrapped in Effect via a custom `DrizzleDb` Layer for DI and testability.

6. **Typed errors.** Every service defines its error types with `Data.TaggedError`. No bare `Error` throws.

7. **Retries via `Schedule`.** No manual retry loops. Use `Effect.retry` with `Schedule.exponential`, `Schedule.recurs`, etc.

8. **Graceful shutdown.** Use `Effect.addFinalizer` for cleanup (DB connections, queue drain). The server must finish in-progress work before stopping.

## Elysia Conventions

1. **Each feature is a plugin.** Use `new Elysia({ name: 'feature-name' })` pattern.

2. **Plugins receive dependencies** via Elysia's `decorate` or constructor injection, not global imports.

3. **Route handlers call Effect programs.** The boundary is `Effect.runPromise()` inside the handler. Elysia owns HTTP, Effect owns logic.

4. **Validation at the edge.** Use Elysia's built-in validation (TypeBox) for request shape, Effect Schema for domain validation.

## Database Conventions

1. **Drizzle schema-as-code.** All tables defined in `src/infrastructure/db/schema.ts`. No raw `CREATE TABLE` in application code.

2. **Migrations via Drizzle Kit (Phase 2+).** Tables created from Drizzle schema at startup in Phase 1. Formal migration workflow with `drizzle-kit` deferred.

3. **SQLite pragmas.** Always set: `journal_mode = WAL`, `busy_timeout = 5000`, `synchronous = NORMAL`, `foreign_keys = ON`.

## Commands

```bash
bun run dev          # Start dev server with watch mode
bun run start        # Start production server
bun test             # Run tests (bun:test, not vitest)
bun run check-types  # Type check (tsc)
bun run lint         # Lint (oxlint)
bun run format       # Format (oxfmt)
```

## Docker

Build and run with the `oven/bun` base image. Multi-stage build for smaller images. The Dockerfile lives at the repo root.

## Documented Solutions

`docs/solutions/` — documented solutions to past problems and architecture decisions, organized by category with YAML frontmatter (`module`, `tags`, `problem_type`). Relevant when implementing features, debugging issues, or making architecture decisions in documented areas.

## Environment Variables

See `.env.example` for all required and optional variables. Use Effect `Config` to access them — never read `process.env` directly.
