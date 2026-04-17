---
title: "feat: Phase 0 LLM Validation"
type: feat
status: active
date: 2026-04-16
origin: docs/brainstorms/phase-0-llm-validation-requirements.md
---

# Phase 0: LLM Validation

## Overview

Validate that LLM-generated code reviews are useful before building the platform. Test 4 models against 5 real PRs, iterate the prompt template, select a default model. This is a manual testing and evaluation process, not a code change.

## Problem Frame

The entire AI PR review platform's value depends on one question: does the LLM produce reviews that help a junior dev (6 months experience) make better decisions about PRs? Phase 0 answers this before writing platform code. (see origin: `docs/brainstorms/phase-0-llm-validation-requirements.md`)

## Requirements Trace

- R1. At least one model scores 3+ on all 5 evaluation dimensions across 3/5 test PRs
- R2. Review prompt template reaches stability (no major changes between last 2 runs)
- R3. Default model selected with documented rationale
- R4. False positive rate below 30% on the best model

## Scope Boundaries

- No platform infrastructure built during this phase
- No local LLM testing (deferred to Phase 2)
- Manual scoring only, no automated evaluation
- "Good enough" prompt, not perfection (iterate in production later)

## Key Technical Decisions

- **OpenRouter for all model access**: Single API, swap models by changing model ID string. No per-provider integration needed during validation.
- **Temperature 0.2**: Low temperature for consistent, predictable output across all runs. Configurable later.
- **Manual scoring over automated evals**: Sample size is too small (20 runs) for statistical metrics. Human judgment is the ground truth here.
- **Write personal reviews before LLM output**: Prevents anchoring bias. Your notes are the ground truth for scoring.

## Implementation Units

- [x] **Unit 1: Build the test harness script**

  **Goal:** A simple script that takes a PR diff file and runs it through OpenRouter with the prompt template, saving the output.

  **Requirements:** R1, R2

  **Dependencies:** None

  **Files:**
  - Create: `scripts/phase-0-test.ts`
  - Create: `src/features/pr-review/prompts/review-brief.txt`

  **Approach:**
  - Bun script that reads a diff file, fills in the prompt template, calls OpenRouter, saves the response
  - Accept `--model` flag to switch between the 4 models
  - Accept `--diff` flag pointing to a diff file
  - Output saved to `docs/phase-0-results/{model}-{pr-name}-{timestamp}.md`
  - Print response time and token usage to stdout
  - No Effect-TS needed here — this is a throwaway test script, not platform code

  **Patterns to follow:**
  - OpenRouter API shape from `src/providers/openrouter-layer.ts` (same endpoint, same auth)

  **Test expectation:** none — throwaway test script

  **Verification:**
  - Running `bun scripts/phase-0-test.ts --model anthropic/claude-sonnet-4 --diff test-diffs/sample.diff` produces a markdown file in `docs/phase-0-results/`

- [ ] **Unit 2: Collect and prepare test PR diffs**

  **Goal:** Gather 5 real PR diffs from Aligo repos matching the selection criteria.

  **Requirements:** R1

  **Dependencies:** None (parallel with Unit 1)

  **Files:**
  - Create: `test-diffs/README.md` (index of which PR each diff came from)
  - Create: `test-diffs/01-small.diff`
  - Create: `test-diffs/02-medium-a.diff`
  - Create: `test-diffs/03-medium-b.diff`
  - Create: `test-diffs/04-large-a.diff`
  - Create: `test-diffs/05-large-b.diff`

  **Approach:**
  - Use `gh pr diff <number>` or `git diff` to capture unified diffs
  - Selection: 1 small (<50 lines, 1-3 files), 2 medium (50-300 lines, 3-10 files), 2 large (300+ lines, 10+ files)
  - For each, record in README.md: repo, PR number/title, file count, line count
  - Write personal review notes for each PR BEFORE running any LLM (save as `test-diffs/01-small-notes.md` etc.)

  **Test expectation:** none — data collection

  **Verification:**
  - 5 diff files exist with corresponding personal review notes
  - README.md documents the source and metadata for each

- [ ] **Unit 3: Run Round 1 baseline**

  **Goal:** Run all 5 diffs through all 4 models. Score each output. Identify weakest dimensions.

  **Requirements:** R1, R4

  **Dependencies:** Unit 1, Unit 2

  **Files:**
  - Create: `docs/phase-0-results/round-1-scores.md`

  **Approach:**
  - 5 PRs x 4 models = 20 runs
  - For each run: save the LLM output, score against the 5-dimension rubric, record in the scoring template from the requirements doc
  - Aggregate: which model performed best? Which dimensions were weakest across all models?
  - Compare LLM findings against personal review notes — did it catch what you caught? Did it find things you missed?

  **Test expectation:** none — evaluation process

  **Verification:**
  - `round-1-scores.md` contains 20 scored evaluations
  - Weakest dimensions identified with specific examples

- [ ] **Unit 4: Iterate prompt and run Round 2**

  **Goal:** Fix the weakest dimensions from Round 1 by modifying the prompt template. Re-test.

  **Requirements:** R2

  **Dependencies:** Unit 3

  **Files:**
  - Modify: `src/features/pr-review/prompts/review-brief.txt` (v2)
  - Create: `docs/phase-0-results/round-2-scores.md`

  **Approach:**
  - Analyze Round 1: what specific instructions would fix the weakest dimension?
  - Common fixes: more explicit examples, stronger constraints on output format, better guidance on confidence calibration
  - Re-run the 2 worst-scoring PRs through the top 2 models from Round 1
  - Score again. Compare v1 vs v2 output on the same PR.

  **Test expectation:** none — evaluation process

  **Verification:**
  - Prompt v2 shows measurable improvement on the weakest dimensions
  - If no improvement: document what was tried and why it didn't work

- [ ] **Unit 5: Final validation and model selection**

  **Goal:** Validate the best prompt + model on new PRs. Select default model. Document everything.

  **Requirements:** R1, R2, R3, R4

  **Dependencies:** Unit 4

  **Files:**
  - Create: `docs/phase-0-results/round-3-scores.md`
  - Create: `docs/phase-0-results/decision.md`
  - Modify: `src/features/pr-review/prompts/review-brief.txt` (final version)

  **Approach:**
  - Collect 2-3 NEW PRs (not used in Rounds 1-2)
  - Run through best prompt + best model
  - Score. If 3+ on all dimensions for majority of PRs, Phase 0 passes.
  - Write `decision.md` with: default model, rationale, fallback model, final prompt version, average scores, estimated cost per review

  **Test expectation:** none — evaluation and decision

  **Verification:**
  - `decision.md` exists with all required fields filled
  - Final prompt template saved to `src/features/pr-review/prompts/review-brief.txt`
  - At least one model achieves 3+ on all 5 dimensions for 3/5 test PRs

## Risks & Dependencies

| Risk                                          | Mitigation                                                                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| No model produces useful reviews              | Fall back to simpler output (summary only). Consider more expensive models. Revisit product approach. |
| OpenRouter API access issues from Naver Cloud | Test API connectivity on Day 1 before collecting all PRs                                              |
| Too few real PRs available                    | Supplement with open source PRs if team repos have < 5 recent PRs                                     |
| Scoring is subjective (just one person)       | Write personal review notes first as ground truth. Be honest about uncertainty in scores.             |

## Deferred to Implementation

- Exact prompt wording will evolve through Rounds 1-3. The v1 template in the requirements doc is the starting point, not the final version.
- Which specific model IDs are available on OpenRouter may change. Check current availability on Day 1.

## Sources & References

- **Origin document:** [docs/brainstorms/phase-0-llm-validation-requirements.md](docs/brainstorms/phase-0-llm-validation-requirements.md)
- Related code: `src/providers/openrouter-layer.ts` (OpenRouter API shape reference)
- Design doc: `~/.gstack/projects/aligo-llm-service/thinline20-main-design-20260416-100519.md`
