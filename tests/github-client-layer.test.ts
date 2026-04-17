import { describe, expect, test } from "bun:test";
import { FetchHttpClient } from "@effect/platform";
import { Effect, Layer, Option, Redacted } from "effect";
import { GithubError, GitHubClient } from "../src/application/ports/github-client";
import { AppConfig } from "../src/config";
import { GitHubClientLayer } from "../src/infrastructure/github/github-client-layer";

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
  return GitHubClientLayer.pipe(Layer.provide(makeTestConfig()), Layer.provide(TestHttpClient));
};

describe("GitHubClientLayer with HttpClient", () => {
  test("fetchDiff returns raw diff text", async () => {
    const diffText = "diff --git a/file.ts b/file.ts\n+hello world";

    const result = await Effect.gen(function* () {
      const client = yield* GitHubClient;
      return yield* client.fetchDiff("owner", "repo", 1);
    }).pipe(
      Effect.provide(makeTestLayer(() => Promise.resolve(new Response(diffText, { status: 200 })))),
      Effect.runPromise,
    );

    expect(result).toBe(diffText);
  });

  test("postComment succeeds", async () => {
    await Effect.gen(function* () {
      const client = yield* GitHubClient;
      yield* client.postComment("owner", "repo", 1, "Great PR!");
    }).pipe(
      Effect.provide(
        makeTestLayer(() =>
          Promise.resolve(
            new Response(JSON.stringify({ id: 1 }), {
              status: 201,
              headers: { "Content-Type": "application/json" },
            }),
          ),
        ),
      ),
      Effect.runPromise,
    );
  });

  test("401 response yields GithubError with reason 'auth'", async () => {
    const error = await Effect.gen(function* () {
      const client = yield* GitHubClient;
      return yield* client.fetchDiff("owner", "repo", 1);
    }).pipe(
      Effect.provide(
        makeTestLayer(() => Promise.resolve(new Response("Unauthorized", { status: 401 }))),
      ),
      Effect.flip,
      Effect.runPromise,
    );

    expect(error).toBeInstanceOf(GithubError);
    expect((error as GithubError).reason).toBe("auth");
  });

  test("404 response yields GithubError with reason 'not_found'", async () => {
    const error = await Effect.gen(function* () {
      const client = yield* GitHubClient;
      return yield* client.fetchDiff("owner", "repo", 999);
    }).pipe(
      Effect.provide(
        makeTestLayer(() => Promise.resolve(new Response("Not Found", { status: 404 }))),
      ),
      Effect.flip,
      Effect.runPromise,
    );

    expect(error).toBeInstanceOf(GithubError);
    expect((error as GithubError).reason).toBe("not_found");
  });

  test("postComment truncates body exceeding 65536 chars", async () => {
    let capturedBody = "";
    const decoder = new TextDecoder();

    await Effect.gen(function* () {
      const client = yield* GitHubClient;
      const longBody = "x".repeat(70000);
      yield* client.postComment("owner", "repo", 1, longBody);
    }).pipe(
      Effect.provide(
        makeTestLayer((_url, init) => {
          try {
            const rawBody = init?.body;
            if (rawBody instanceof Uint8Array) {
              const parsed = JSON.parse(decoder.decode(rawBody));
              capturedBody = parsed.body;
            } else if (typeof rawBody === "string") {
              const parsed = JSON.parse(rawBody);
              capturedBody = parsed.body;
            }
          } catch {
            // body format not parseable, ignore
          }
          return Promise.resolve(
            new Response(JSON.stringify({ id: 1 }), {
              status: 201,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }),
      ),
      Effect.runPromise,
    );

    expect(capturedBody.length).toBeLessThanOrEqual(65536);
    expect(capturedBody).toContain("Review truncated due to GitHub comment length limit.");
  });
});
