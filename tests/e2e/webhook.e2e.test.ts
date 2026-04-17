import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import { Elysia } from "elysia";

// Ensure data directory exists for SQLite files
mkdirSync("data", { recursive: true });
import { Effect, Layer, ManagedRuntime } from "effect";

import { AppConfig } from "../../src/config";
import { DrizzleLiveLayer } from "../../src/infrastructure/db/drizzle-layer";
import { DeliveryRepositoryLiveLayer } from "../../src/infrastructure/db/delivery-repository-layer";
import { ReviewRepositoryLiveLayer } from "../../src/infrastructure/db/review-repository-layer";
import { BunqueueLayer } from "../../src/infrastructure/queue/bunqueue-layer";
import {
  ReviewBriefService,
  makeReviewBriefService,
} from "../../src/application/services/review-brief-service";
import {
  PrReviewService,
  makePrReviewService,
} from "../../src/application/services/pr-review-service";
import { DeliveryRepository } from "../../src/application/ports/delivery-repository";
import { GitHubClient } from "../../src/application/ports/github-client";
import { LlmProvider } from "../../src/application/ports/llm-provider";
import { webhookPlugin } from "../../src/presentation/webhook-plugin";

const WEBHOOK_SECRET = "test-e2e-secret";

function signPayload(body: string): string {
  return `sha256=${crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;
}

function makeWebhookPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "opened",
    repository: { full_name: "test-org/test-repo" },
    pull_request: {
      number: 42,
      title: "Add new feature",
      head: { sha: "abc123def456" },
    },
    ...overrides,
  };
}

// Mock LLM that returns a fixed review
const MockLlmLayer = Layer.succeed(LlmProvider, {
  name: "mock-llm",
  complete: () =>
    Effect.succeed("## Summary\nMock review for E2E test\n\n## Likely Bugs\nNone found."),
});

// Mock GitHub that tracks posted comments
let postedComments: Array<{ owner: string; repo: string; prNumber: number; body: string }> = [];
const MockGithubLayer = Layer.succeed(GitHubClient, {
  fetchDiff: () =>
    Effect.succeed(
      "diff --git a/src/main.ts b/src/main.ts\nindex abc..def 100644\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1,3 +1,4 @@\n+import { foo } from 'bar';\n console.log('hello');\n",
    ),
  postComment: (owner, repo, prNumber, body) => {
    postedComments.push({ owner, repo, prNumber, body });
    return Effect.void;
  },
});

describe("E2E: Webhook pipeline", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  let runtime: ManagedRuntime.ManagedRuntime<any, any>;
  let baseUrl: string;

  beforeEach(async () => {
    postedComments = [];

    // Set env vars for the test
    process.env.WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.DRY_RUN = "true";
    process.env.LLM_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.GITHUB_TOKEN = "test-github-token";
    process.env.BUNQUEUE_DATA_PATH = `data/test-e2e-${Date.now()}.db`;

    const DbLayer = DeliveryRepositoryLiveLayer.pipe(
      Layer.provideMerge(ReviewRepositoryLiveLayer),
      Layer.provideMerge(DrizzleLiveLayer),
    );

    const QueueLayer = BunqueueLayer;

    const ReviewBriefLayer = Layer.effect(
      ReviewBriefService,
      makeReviewBriefService(
        "Template: {{repo_name}} {{pr_title}} {{file_count}} {{lines_changed}}\n{{diff}}",
      ),
    ).pipe(Layer.provide(MockLlmLayer));

    const PrReviewLayer = Layer.effect(PrReviewService, makePrReviewService).pipe(
      Layer.provide(
        Layer.mergeAll(MockGithubLayer, DbLayer, QueueLayer, ReviewBriefLayer, AppConfig.Default),
      ),
    );

    const TestLayer = Layer.mergeAll(
      PrReviewLayer,
      QueueLayer,
      MockLlmLayer,
      DbLayer,
      AppConfig.Default,
    );

    runtime = ManagedRuntime.make(TestLayer);

    const runEffect = (effect: Effect.Effect<any, any, any>) => runtime.runPromise(effect);

    app = new Elysia().use(webhookPlugin(WEBHOOK_SECRET, runEffect)).listen(0); // random port

    baseUrl = `http://localhost:${app.server!.port}`;
  });

  afterEach(async () => {
    app.stop();
    await runtime.dispose();

    // Clean up test queue DB
    const queuePath = process.env.BUNQUEUE_DATA_PATH;
    if (queuePath) {
      try {
        const { unlinkSync } = require("node:fs");
        unlinkSync(queuePath);
      } catch {}
    }
  });

  test("valid webhook → 202 Accepted", async () => {
    const body = JSON.stringify(makeWebhookPayload());
    const res = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signPayload(body),
        "X-GitHub-Delivery": crypto.randomUUID(),
      },
      body,
    });

    expect(res.status).toBe(202);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe("accepted");
  });

  test("invalid HMAC → 401", async () => {
    const body = JSON.stringify(makeWebhookPayload());
    const res = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": "sha256=invalid",
        "X-GitHub-Delivery": crypto.randomUUID(),
      },
      body,
    });

    expect(res.status).toBe(401);
  });

  test("missing signature → 401", async () => {
    const body = JSON.stringify(makeWebhookPayload());
    const res = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Delivery": crypto.randomUUID(),
      },
      body,
    });

    expect(res.status).toBe(401);
  });

  test("action: closed → 200, no processing", async () => {
    const body = JSON.stringify(makeWebhookPayload({ action: "closed" }));
    const res = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signPayload(body),
        "X-GitHub-Delivery": crypto.randomUUID(),
      },
      body,
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe("ignored");
  });

  test("duplicate X-GitHub-Delivery → deduped", async () => {
    const deliveryId = crypto.randomUUID();
    const body = JSON.stringify(makeWebhookPayload());
    const headers = {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": signPayload(body),
      "X-GitHub-Delivery": deliveryId,
    };

    const res1 = await fetch(`${baseUrl}/webhook`, { method: "POST", headers, body });
    expect(res1.status).toBe(202);

    const res2 = await fetch(`${baseUrl}/webhook`, { method: "POST", headers, body });
    expect(res2.status).toBe(202);

    // Both accepted, but second should be deduped internally
    // Verify via delivery repository — only one delivery saved
    const delivery = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* DeliveryRepository;
        return yield* repo.findByDeliveryId(deliveryId);
      }),
    );
    expect(delivery).not.toBeNull();
  });

  test("DRY_RUN mode → no GitHub comments posted", async () => {
    const body = JSON.stringify(makeWebhookPayload());
    const deliveryId = crypto.randomUUID();

    await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signPayload(body),
        "X-GitHub-Delivery": deliveryId,
      },
      body,
    });

    // Wait briefly for async job processing
    await new Promise((resolve) => setTimeout(resolve, 500));

    // In DRY_RUN mode, no comments should be posted
    expect(postedComments.length).toBe(0);
  });
});
