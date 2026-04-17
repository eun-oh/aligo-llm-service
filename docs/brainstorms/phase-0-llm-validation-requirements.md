# Phase 0: LLM Validation Requirements

**Date:** 2026-04-16
**Status:** Active
**Goal:** Validate that LLM-generated code reviews are useful before building the platform.

## Problem

We're about to build an AI PR review platform. The entire project's value depends on one thing: does the LLM produce reviews that actually help a junior dev (6 months experience) understand, evaluate, and make decisions about PRs? If the answer is no, nothing else matters.

Phase 0 answers this question before writing platform code.

## Success Criteria

- At least one model scores 3+ on all 5 evaluation dimensions across 3 out of 5 test PRs
- The review prompt template is iterated to a stable version (no major changes between last 2 runs)
- A default model is selected with documented rationale
- False positive rate is below 30% on the best-performing model

## Scope

**In scope:**

- Prompt template design and iteration
- Model comparison across 4 OpenRouter models
- Evaluation rubric and scoring
- Decision on default model

**Not in scope:**

- Building any platform infrastructure
- Local LLM testing (deferred to Phase 2)
- Automated evaluation (manual scoring only)
- Prompt optimization beyond "good enough" (iterate in production later)

## Test Data

**Source:** 5 recent PRs from Aligo's repos.

**Selection criteria:**

- 1 small PR (< 50 lines changed, 1-3 files)
- 2 medium PRs (50-300 lines changed, 3-10 files)
- 2 large PRs (300+ lines changed, 10+ files, ideally AI-generated)

**For each PR, capture:**

- Full unified diff
- PR title and description (if any)
- Repo name
- Number of files and lines changed
- Your own notes: what do YOU think about this PR? (written before seeing LLM output, to compare against)

## Prompt Template (v1 — iterate from here)

```
You are an experienced senior developer reviewing a pull request. Your audience is a junior developer who needs to understand this PR and decide whether to approve it.

## Context
- Repository: {repo_name}
- PR title: {pr_title}
- Files changed: {file_count}
- Lines changed: {lines_changed}

## Instructions
Produce exactly 4 sections:

### 1. Summary
What does this PR do? Explain the intent in 2-3 sentences. What problem does it solve? What changes were made and why?

### 2. Read These Files First
Rank the changed files by review priority. For each high-priority file, explain in one sentence WHY it needs careful attention.

Risk signals to consider:
- Files touching auth, security, payments, or credentials
- Large diffs (>100 lines changed in a single file)
- New files (need scrutiny for missing tests and pattern compliance)
- Database migrations or schema changes
- Files that handle user input

### 3. Likely Bugs
List specific issues found. For each:
- **File:line** — what the issue is
- **Why** — why this is a problem (not just "looks wrong")
- **Confidence** — score 1-10

Rules:
- Only include findings with confidence >= 6
- For confidence 4-5, write: "[file] — needs human inspection: [brief reason]"
- For confidence 1-3, omit entirely
- Do NOT flag style preferences or formatting issues
- Do NOT fabricate issues to appear thorough — "no significant bugs found" is a valid answer

### 4. Missing Tests
Which changed code paths lack test coverage? For each:
- What function/behavior is untested
- What test case should be written
- Priority: critical (blocks merge) vs nice-to-have

If tests exist and coverage looks adequate, say so.

## Diff
{diff}
```

## Models to Test

| Model            | OpenRouter ID                     | Why                                          | Cost            |
| ---------------- | --------------------------------- | -------------------------------------------- | --------------- |
| Claude Sonnet 4  | `anthropic/claude-sonnet-4`       | Strong code understanding, structured output | ~$3/1M input    |
| GPT-4o           | `openai/gpt-4o`                   | Widely used baseline, good at code review    | ~$2.50/1M input |
| Gemini 2.5 Flash | `google/gemini-2.5-flash-preview` | Fast and cheap, test if quality holds        | ~$0.15/1M input |
| Qwen 3 235B      | `qwen/qwen3-235b`                 | Strong open-weight, potential self-host path | ~$1/1M input    |

**Settings for all models:**

- Temperature: 0.2 (consistent, predictable output)
- Max tokens: 4096

## Evaluation Rubric

Score each model's output on 5 dimensions (1-5 scale):

| Dimension               | 1 (Bad)                                    | 3 (Acceptable)                           | 5 (Great)                                                   |
| ----------------------- | ------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------- |
| **Summary accuracy**    | Wrong about what the PR does               | Partially correct, gets the gist         | Nails the intent and explains why                           |
| **File prioritization** | Missed the risky files entirely            | Got the top files right, missed some     | Ranked all files correctly with good reasons                |
| **Bug detection**       | Found nothing real, or all false positives | Found obvious issues, missed subtle ones | Found non-obvious issues a junior would miss                |
| **False positive rate** | >50% of findings are wrong                 | ~30% of findings are wrong               | <20% of findings are wrong                                  |
| **Actionability**       | Vague ("this could be improved")           | Mix of specific and vague findings       | Every finding has file:line, explanation, and fix direction |

**Passing threshold:** 3+ on all 5 dimensions = "useful"

## Execution Process

### Round 1: Baseline (Day 1-2)

1. Collect 5 PRs per the selection criteria above
2. Write your own review notes for each PR BEFORE running any LLM
3. Run each PR through all 4 models using the v1 prompt template
4. Score each output (5 PRs x 4 models = 20 evaluations)
5. Record results in the scoring spreadsheet below

### Round 2: Iterate Prompt (Day 2-3)

1. Analyze Round 1 results: which dimensions scored lowest across all models?
2. Modify the prompt template to address the weakest dimensions
3. Re-run the 2 PRs that scored worst through the top 2 models from Round 1
4. Score again. Did the prompt changes help?

### Round 3: Final Validation (Day 3-4)

1. Take the best prompt + best model combination
2. Run on 2-3 NEW PRs (not the ones used in Rounds 1-2)
3. Score. If still 3+ across all dimensions, Phase 0 passes.
4. If not, iterate prompt one more time or consider a different model.

## Scoring Spreadsheet

For each test run, record:

```
PR: [repo/PR#]
Model: [model name]
Prompt version: [v1/v2/v3]
Response time: [seconds]

Scores:
  Summary accuracy:    _/5
  File prioritization: _/5
  Bug detection:       _/5
  False positive rate:  _/5
  Actionability:       _/5

Notes: [what was good, what was bad, what to fix in the prompt]
```

## Decision Criteria

After Round 3, select the default model based on:

1. **Quality first:** Must score 3+ on all dimensions consistently
2. **Cost second:** If two models tie on quality, pick cheaper
3. **Speed third:** Faster response = better UX for the reviewer

Document the decision:

```
Default model: [name]
Rationale: [why this one]
Fallback model: [name, for high-risk PRs if default is cheap/fast but less thorough]
Final prompt version: [v1/v2/v3]
Average scores: [per dimension]
Cost per review: [estimated]
```

## Exit Criteria

Phase 0 is DONE when:

- [ ] 5 test PRs collected and personally reviewed
- [ ] At least 2 rounds of prompt iteration completed
- [ ] At least one model scores 3+ on all dimensions for 3/5 PRs
- [ ] Default model selected with documented rationale
- [ ] Final prompt template saved to `src/features/pr-review/prompts/review-brief.txt`
- [ ] Scoring data saved to `docs/phase-0-results/`

Phase 0 FAILS when:

- No model achieves 3+ on all dimensions after 3 rounds of iteration
- Action: revisit the approach. Consider simpler output format, different models, or narrower scope (e.g., summary only, skip bug detection)

## Timeline

- Day 1-2: Collect PRs, write personal reviews, run Round 1
- Day 2-3: Analyze, iterate prompt, run Round 2
- Day 3-4: Final validation on new PRs, select model, document
- Day 5: Decision checkpoint with CTO (optional demo)
