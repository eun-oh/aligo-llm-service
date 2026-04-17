import { Context, Effect } from "effect";
import { buildPrompt, type PromptContext } from "../../domain/pr-review/prompt-builder";
import { LlmProvider, type LlmError } from "../ports/llm-provider";

export class ReviewBriefService extends Context.Tag("ReviewBriefService")<
  ReviewBriefService,
  {
    readonly generateReview: (context: PromptContext) => Effect.Effect<string, LlmError>;
  }
>() {}

export function makeReviewBriefService(
  promptTemplate: string,
): Effect.Effect<
  { readonly generateReview: (context: PromptContext) => Effect.Effect<string, LlmError> },
  never,
  LlmProvider
> {
  return Effect.gen(function* () {
    const llm = yield* LlmProvider;
    return {
      generateReview: (context: PromptContext) =>
        Effect.gen(function* () {
          const prompt = buildPrompt(promptTemplate, context);
          return yield* llm.complete(prompt, { temperature: 0.2, maxTokens: 4096 });
        }),
    };
  });
}

export function loadPromptTemplate(templatePath: string): Effect.Effect<string, LlmError> {
  return Effect.tryPromise({
    try: () => Bun.file(templatePath).text(),
    catch: (cause) => ({
      _tag: "LlmError" as const,
      reason: "unknown" as const,
      message: `Failed to load prompt template: ${templatePath}`,
      cause,
    }),
  }) as Effect.Effect<string, LlmError>;
}
