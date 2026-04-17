import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform";
import { Effect, Layer, Redacted, Schedule } from "effect";
import { AppConfig } from "../../config";
import {
  type CompletionOptions,
  LlmError,
  LlmProvider,
} from "../../application/ports/llm-provider";

interface OpenRouterResponse {
  choices?: { message?: { content?: string } }[];
  error?: { message?: string; code?: number };
}

const retryPolicy = Schedule.compose(Schedule.exponential("1 second"), Schedule.recurs(2)).pipe(
  Schedule.whileInput(
    (error: LlmError) => error.reason === "rate_limit" || error.reason === "timeout",
  ),
);

export const OpenRouterLayer = Layer.effect(
  LlmProvider,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const client = yield* HttpClient.HttpClient;

    const apiKey = config.openrouterApiKey;
    if (apiKey._tag === "None") {
      return yield* Effect.fail(
        new LlmError({
          reason: "auth",
          message: "OPENROUTER_API_KEY is not set",
        }),
      );
    }

    const key = Redacted.value(apiKey.value);

    return {
      name: "openrouter",
      complete: (prompt: string, options?: CompletionOptions) =>
        Effect.gen(function* () {
          const request = HttpClientRequest.post(
            "https://openrouter.ai/api/v1/chat/completions",
          ).pipe(
            HttpClientRequest.bearerToken(key),
            HttpClientRequest.bodyUnsafeJson({
              model: config.openrouterModel,
              messages: [{ role: "user", content: prompt }],
              max_tokens: options?.maxTokens ?? 4096,
              temperature: options?.temperature ?? config.llmTemperature,
            }),
          );

          const response = yield* client.execute(request).pipe(
            Effect.catchTag("RequestError", (error) =>
              Effect.fail(
                new LlmError({
                  reason: "timeout",
                  message: "Failed to reach OpenRouter API",
                  cause: error,
                }),
              ),
            ),
            Effect.catchTag("ResponseError", (error) =>
              Effect.fail(
                new LlmError({
                  reason: "unknown",
                  message: "Unexpected response error from OpenRouter",
                  cause: error,
                }),
              ),
            ),
          );

          const parseJson = (res: HttpClientResponse.HttpClientResponse) =>
            Effect.gen(function* () {
              const json = (yield* res.json.pipe(
                Effect.catchTag("ResponseError", (error) =>
                  Effect.fail(
                    new LlmError({
                      reason: "parse",
                      message: "Failed to parse OpenRouter response",
                      cause: error,
                    }),
                  ),
                ),
              )) as OpenRouterResponse;

              if (json.error) {
                return yield* Effect.fail(
                  new LlmError({
                    reason: "unknown",
                    message: json.error.message ?? "OpenRouter API error",
                  }),
                );
              }

              const content = json.choices?.[0]?.message?.content;
              if (!content) {
                return yield* Effect.fail(
                  new LlmError({
                    reason: "parse",
                    message: "Empty response from OpenRouter",
                  }),
                );
              }

              return content;
            });

          return yield* HttpClientResponse.matchStatus(response, {
            200: parseJson,
            401: () => Effect.fail(new LlmError({ reason: "auth", message: "Invalid API key" })),
            429: (res) => {
              const retryAfter = res.headers["retry-after"];
              return Effect.fail(
                new LlmError({
                  reason: "rate_limit",
                  message: `Rate limited${retryAfter ? `, retry after ${retryAfter}s` : ""}`,
                }),
              );
            },
            403: () =>
              Effect.fail(
                new LlmError({
                  reason: "rate_limit",
                  message: "Rate limited",
                }),
              ),
            orElse: (res) =>
              Effect.fail(
                new LlmError({
                  reason: "unknown",
                  message: `OpenRouter returned ${res.status}`,
                }),
              ),
          });
        }).pipe(
          Effect.retry(retryPolicy),
          Effect.catchTag("LlmError", (error) =>
            error.reason === "rate_limit" || error.reason === "timeout"
              ? Effect.fail(
                  new LlmError({
                    reason: "exhausted",
                    message: `All retries exhausted: ${error.message}`,
                    cause: error,
                  }),
                )
              : Effect.fail(error),
          ),
        ),
    };
  }),
);
