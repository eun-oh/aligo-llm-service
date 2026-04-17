import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { LlmProvider } from "../src/application/ports/llm-provider";
import {
  ReviewBriefService,
  makeReviewBriefService,
} from "../src/application/services/review-brief-service";
import type { PromptContext } from "../src/domain/pr-review/prompt-builder";

const MOCK_TEMPLATE = `Review for {{repo_name}}
PR: {{pr_title}}
Files: {{file_count}}, Lines: {{lines_changed}}
Diff:
{{diff}}`;

const MockLlmProvider = Layer.succeed(LlmProvider, {
  name: "mock",
  complete: (prompt, _opts) => Effect.succeed(`## Summary\nMock review of: ${prompt.slice(0, 50)}`),
});

function makeTestLayer() {
  const ReviewBriefLayer = Layer.effect(ReviewBriefService, makeReviewBriefService(MOCK_TEMPLATE));
  return ReviewBriefLayer.pipe(Layer.provide(MockLlmProvider));
}

const validContext: PromptContext = {
  repoName: "org/repo",
  prTitle: "Add auth feature",
  fileCount: 3,
  linesChanged: 42,
  diff: "+export function login() {}\n-export function oldLogin() {}",
};

describe("ReviewBriefService", () => {
  test("generateReview produces review from valid context", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ReviewBriefService;
        return yield* service.generateReview(validContext);
      }).pipe(Effect.provide(makeTestLayer())),
    );

    expect(result).toContain("## Summary");
    expect(result).toContain("Mock review of:");
  });

  test("empty diff produces meaningful output", async () => {
    const emptyDiffContext: PromptContext = {
      repoName: "org/repo",
      prTitle: "Empty change",
      fileCount: 0,
      linesChanged: 0,
      diff: "",
    };

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ReviewBriefService;
        return yield* service.generateReview(emptyDiffContext);
      }).pipe(Effect.provide(makeTestLayer())),
    );

    expect(result).toContain("## Summary");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});
