import { Context, Data, Effect } from "effect";

export class LlmError extends Data.TaggedError("LlmError")<{
  readonly reason: "auth" | "rate_limit" | "timeout" | "parse" | "exhausted" | "unknown";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface CompletionOptions {
  readonly maxTokens?: number;
  readonly temperature?: number;
}

export class LlmProvider extends Context.Tag("LlmProvider")<
  LlmProvider,
  {
    readonly complete: (
      prompt: string,
      options?: CompletionOptions,
    ) => Effect.Effect<string, LlmError>;
    readonly name: string;
  }
>() {}
