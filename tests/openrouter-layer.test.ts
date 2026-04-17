import { describe, expect, test } from "bun:test";
import { FetchHttpClient } from "@effect/platform";
import { Effect, Layer, Option, Redacted } from "effect";
import { LlmError, LlmProvider } from "../src/application/ports/llm-provider";
import { AppConfig } from "../src/config";
import { OpenRouterLayer } from "../src/infrastructure/llm/openrouter-layer";

const makeTestConfig = () =>
  Layer.succeed(
    AppConfig,
    AppConfig.make({
      llmProvider: "openrouter" as const,
      openrouterApiKey: Option.some(Redacted.make("test-key")),
      openrouterModel: "test-model",
      githubToken: Redacted.make("gh-token"),
      webhookSecret: "secret",
      confidenceThreshold: 6,
      dryRun: false,
      port: 8080,
      llmTemperature: 0.2,
    }),
  );

const makeMockFetch = (handler: (url: string, init?: RequestInit) => Promise<Response>) =>
  Layer.succeed(FetchHttpClient.Fetch, handler as typeof globalThis.fetch);

const makeTestLayer = (handler: (url: string, init?: RequestInit) => Promise<Response>) => {
  const MockFetch = makeMockFetch(handler);
  const TestHttpClient = FetchHttpClient.layer.pipe(Layer.provide(MockFetch));
  return OpenRouterLayer.pipe(Layer.provide(makeTestConfig()), Layer.provide(TestHttpClient));
};

const runWithProvider = <A, E>(
  effect: (provider: Effect.Effect.Success<typeof LlmProvider>) => Effect.Effect<A, E>,
  handler: (url: string, init?: RequestInit) => Promise<Response>,
) => {
  const layer = makeTestLayer(handler);
  return Effect.gen(function* () {
    const provider = yield* LlmProvider;
    return yield* effect(provider);
  }).pipe(Effect.provide(layer), Effect.runPromise);
};

describe("OpenRouterLayer with HttpClient", () => {
  test("complete() returns parsed content from 200 response", async () => {
    const result = await runWithProvider(
      (provider) => provider.complete("hello"),
      () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: "Hello back!" } }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
    );

    expect(result).toBe("Hello back!");
  });

  test("401 response yields LlmError with reason 'auth'", async () => {
    const error = await Effect.gen(function* () {
      const provider = yield* LlmProvider;
      return yield* provider.complete("hello");
    }).pipe(
      Effect.provide(
        makeTestLayer(() => Promise.resolve(new Response("Unauthorized", { status: 401 }))),
      ),
      Effect.flip,
      Effect.runPromise,
    );

    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).reason).toBe("auth");
  });

  test("429 response yields LlmError with reason 'exhausted' after retries", async () => {
    const error = await Effect.gen(function* () {
      const provider = yield* LlmProvider;
      return yield* provider.complete("hello");
    }).pipe(
      Effect.provide(
        makeTestLayer(() => Promise.resolve(new Response("Too Many Requests", { status: 429 }))),
      ),
      Effect.flip,
      Effect.runPromise,
    );

    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).reason).toBe("exhausted");
  });

  test("empty response body yields LlmError with reason 'parse'", async () => {
    const error = await Effect.gen(function* () {
      const provider = yield* LlmProvider;
      return yield* provider.complete("hello");
    }).pipe(
      Effect.provide(
        makeTestLayer(() =>
          Promise.resolve(
            new Response(JSON.stringify({ choices: [] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          ),
        ),
      ),
      Effect.flip,
      Effect.runPromise,
    );

    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).reason).toBe("parse");
  });
});
