---
title: "Architecture and LLM Validation Workflow for AI PR Review Platform"
date: 2026-04-16
category: best-practices
module: aligo-llm-service
problem_type: best_practice
component: development_workflow
severity: medium
applies_when:
  - Starting a new LLM-powered developer tool from scratch
  - Choosing a TypeScript stack for AI/LLM service integrations
  - Deciding whether to validate LLM capabilities before building infrastructure
  - Solo developer or small team building a platform with no senior reviewer
tags:
  - architecture-decision-record
  - effect-ts
  - elysia-js
  - drizzle-orm
  - hexagonal-architecture
  - llm-validation
  - pr-review-bot
  - openrouter
---

# Architecture and LLM Validation Workflow for AI PR Review Platform

## Context

A solo junior developer (6 months experience) at Aligo needed to build an AI-powered PR review platform. The senior developer had left, the team was generating AI code with huge PRs, and nobody had the experience to review them. The CTO greenlit using AI to fill the gap. The project (aligo-llm-service) was conceived as a platform, not a point solution: PR review is the first feature, with Jira ticket creation, test generation, and other dev automation tools planned.

Existing tools like PR-Agent were evaluated and rejected because they can't evolve into a broader platform. The decision to build from scratch was challenged by a Codex second opinion ("platform-first thinking with no proof of the wedge") but defended by the user: the motivation is learning, experimentation, and owning the full stack. (session history)

The core problem was reframed during design: not "reviews are slow" but "attention allocation under overload" — a junior engineer governing an AI-generated codebase with no senior guidance. The LLM's job is to tell the reviewer where to look, not to find every bug. (session history)

## Guidance

### 1. Validate the LLM before building the platform (Phase 0)

Before writing any platform code, build a standalone test harness to evaluate candidate models against real data from your own repositories.

**Process:**

- Collect 5 real PRs covering different sizes (1 small, 2 medium, 2 large)
- Write your own review notes for each PR BEFORE seeing LLM output (prevents anchoring bias)
- Define a 5-dimension evaluation rubric: summary accuracy, file prioritization, bug detection, false positive rate, actionability (each scored 1-5)
- Test candidate models via OpenRouter (swap models by changing one string)
- Passing threshold: 3+ on all 5 dimensions

**What happened:** Tested 4 free OpenRouter models. Three were rate-limited or unavailable. `openai/gpt-oss-120b:free` produced structured, actionable reviews with file:line references and confidence scores across all 5 PRs. Results were "surprisingly good for a free 120B model." Selected as default.

**Why this matters:** If the LLM output is poor, no amount of architecture saves the product. A few hours of upfront validation prevents weeks of wasted platform engineering.

### 2. Design a structured prompt template with confidence gating

Use a 4-section review brief that forces the LLM to organize its output and self-assess confidence:

1. **Summary** — what the PR does, in 2-3 sentences
2. **Read These Files First** — risk-ranked file list with reasons
3. **Likely Bugs** — specific issues with file:line, explanation, and confidence (1-10)
4. **Missing Tests** — untested code paths with priority

**Critical rule:** Suppress findings below confidence 6. Replace with "needs human inspection" instead of fabricating issues. This is the single most important design decision to avoid alert fatigue. If the first few reviews cry wolf, developers will ignore all future reviews.

**Temperature 0.2** for consistent, reproducible reviews. Higher temperatures introduce noise.

### 3. Use hexagonal architecture with Effect-TS at I/O boundaries

Structure the codebase so business rules (diff parsing, risk classification, prompt assembly) live in a pure core. HTTP handling (Elysia.js), database (Drizzle ORM), job queue (bunqueue), and LLM calls sit in outer adapter layers.

```
Domain (pure logic)     → diff-parser, risk-classifier (plain TypeScript)
Application (use cases) → PrReviewService (Effect orchestration)
Infrastructure (ports)  → LlmProvider, GitHubClient (Effect Services)
Adapters (implementations) → OpenRouterLayer, DrizzleLayer (Effect Layers)
Driving adapters        → Elysia plugins (HTTP entry points)
```

**Key rule:** Pure functions do NOT use Effect-TS. Only I/O-bound code (LLM calls, database, queue) becomes Effect Services. This prevents over-abstracting simple transformations.

**Provider swap via env var:** The LLM provider Layer is selected at startup based on `LLM_PROVIDER=openrouter|local`. The core business logic never changes.

### 4. Build webhook idempotency from day one

GitHub will send duplicate webhook deliveries. Handle this with two layers:

- **X-GitHub-Delivery header:** Reject replay of the same webhook event
- **PR number + commit SHA:** When someone pushes 3 times to the same PR, cancel stale review jobs and only review the latest commit

This was identified during the eng review after a Codex outside voice flagged that X-GitHub-Delivery alone is insufficient for rapid-push scenarios. (session history)

### 5. Use DRY_RUN mode for safe rollout

`DRY_RUN=true` env var runs the full review pipeline but logs the output instead of posting to GitHub. This was added as a day-1 requirement after the Codex eng review critique: "You need dry-run mode, shadow mode, kill switch. Those are day-1 requirements, not phase-2 polish." (session history)

### 6. Adopt Effect ecosystem packages strategically

The following packages were selected for specific reasons:

| Package                                        | Replaces            | Why                                                                                                                                                      |
| ---------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `effect/Schema`                                | Manual JSON parsing | Type-safe validation at system boundaries                                                                                                                |
| `@effect/platform` HttpClient                  | Raw `fetch`         | Typed requests/responses, testable via Layer swap                                                                                                        |
| `drizzle-orm/bun-sqlite` + custom Effect Layer | Raw `bun:sqlite`    | Drizzle schema-as-code with typed queries, wrapped in Effect Layer for DI. `@effect/sql-drizzle` evaluated but deferred — unverified bun:sqlite support. |
| Effect `Logger`                                | `console.log`       | Structured logging, built-in                                                                                                                             |
| Effect `Config`                                | `process.env`       | Typed env var access with validation                                                                                                                     |

### 7. Use Elysia plugins for feature modularity

Each feature (webhook, health, feedback) becomes an Elysia plugin using `new Elysia({ name: 'feature-name' })`. Plugins receive dependencies via Elysia's `decorate` pattern. Route handlers call `Effect.runPromise()` to execute Effect programs. Elysia owns HTTP, Effect owns logic.

## Why This Matters

- **Phase 0 validation** saved potentially weeks of building around a model that produces poor reviews. The test harness took hours; rebuilding around a different model would take days.
- **Hexagonal architecture** means the HTTP framework, database, and LLM provider can each be replaced independently. When the team wants to move from OpenRouter to local Gemma 4, only one adapter Layer changes.
- **Strategic Effect-TS adoption** (I/O boundaries only) avoids wrapping every function in Effect, which adds complexity without benefit for pure transformations.
- **Confidence-gated output** directly addresses the biggest risk of LLM code review: false positives that erode developer trust.
- **DRY_RUN mode** is essential for a solo developer who cannot afford to break production while iterating on prompt quality.
- **Architecture conventions in CLAUDE.md** enforce these decisions across future sessions and contributors (see `CLAUDE.md` for the full rule set).

## When to Apply

- Starting a new LLM-powered developer tool: always validate the model first (Phase 0)
- Solo developer or small team with no dedicated reviewer: the architecture patterns here are designed for high autonomy with low risk
- Any system receiving GitHub webhooks: idempotency and DRY_RUN are table stakes
- Considering Effect-TS: apply it at I/O boundaries for retry, typed errors, and DI; keep pure logic as plain TypeScript
- Choosing between LLM providers: the provider abstraction pattern (Effect Service + swappable Layers + env var selection) applies any time you want provider portability

## Examples

**Before (no Phase 0 validation):**
Team spends 3 weeks building the platform, discovers the model hallucinates line numbers and invents nonexistent variables. Must re-evaluate models and rework the prompt pipeline.

**After (Phase 0 validation):**
A single test script evaluates 4 models against 5 real PRs in one afternoon. The team enters platform development with confidence in model quality and a baseline rubric to measure prompt improvements.

---

**Before (no confidence gating):**
The LLM review posts 12 findings on a 3-file config change. 9 are speculative or wrong. The developer learns to ignore automated reviews.

**After (confidence threshold at 6):**
The same review surfaces 3 high-confidence findings. All three are actionable. The developer trusts the tool and checks its output on every PR.

## Related

- `CLAUDE.md` — architecture conventions and enforcement rules (the _what_)
- `docs/brainstorms/phase-0-llm-validation-requirements.md` — Phase 0 requirements
- `docs/plans/2026-04-16-001-feat-phase-0-llm-validation-plan.md` — Phase 0 execution plan
- `docs/phase-0-results/decision.md` — model selection decision
- `src/domain/pr-review/prompts/review-brief.txt` — the prompt template (v1)
- `docs/solutions/best-practices/hexagonal-effect-ts-pr-review-pipeline-2026-04-17.md` — Phase 1 implementation patterns (companion to this ADR)
- Design doc: `~/.gstack/projects/aligo-llm-service/thinline20-main-design-20260416-100519.md`
