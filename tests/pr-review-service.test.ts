import { describe, expect, test } from "bun:test";
import { Effect, Layer, Option, Redacted } from "effect";
import { GitHubClient } from "../src/application/ports/github-client";
import {
  DeliveryRepository,
  DeliveryError,
  type DeliveryStatus,
} from "../src/application/ports/delivery-repository";
import { ReviewRepository, type Review } from "../src/application/ports/review-repository";
import { JobQueue, type JobData } from "../src/application/ports/job-queue";
import { LlmError } from "../src/application/ports/llm-provider";
import { ReviewBriefService } from "../src/application/services/review-brief-service";
import {
  PrReviewService,
  makePrReviewService,
  type WebhookPayload,
} from "../src/application/services/pr-review-service";
import { AppConfig } from "../src/config";

// --- In-memory mocks ---

interface StoredDelivery {
  deliveryId: string;
  repo: string;
  prNumber: number;
  commitSha: string;
  status: DeliveryStatus;
  createdAt: string;
}

function makeDeliveryStore() {
  const deliveries = new Map<string, StoredDelivery>();
  return {
    deliveries,
    layer: Layer.succeed(DeliveryRepository, {
      save: (d) =>
        Effect.gen(function* () {
          if (deliveries.has(d.deliveryId)) {
            return yield* Effect.fail(
              new DeliveryError({ reason: "duplicate", message: "Duplicate delivery" }),
            );
          }
          deliveries.set(d.deliveryId, { ...d, createdAt: new Date().toISOString() });
        }),
      findByDeliveryId: (id) => Effect.succeed(deliveries.get(id) ?? null),
      findPending: (repo, prNumber) =>
        Effect.succeed(
          [...deliveries.values()].filter(
            (d) => d.repo === repo && d.prNumber === prNumber && d.status === "pending",
          ),
        ),
      updateStatus: (id, status) =>
        Effect.gen(function* () {
          const d = deliveries.get(id);
          if (!d) {
            return yield* Effect.fail(
              new DeliveryError({ reason: "not_found", message: `Delivery ${id} not found` }),
            );
          }
          deliveries.set(id, { ...d, status });
        }),
    }),
  };
}

function makeReviewStore() {
  const reviews: Review[] = [];
  let nextId = 1;
  return {
    reviews,
    layer: Layer.succeed(ReviewRepository, {
      save: (r) =>
        Effect.succeed({
          ...r,
          id: nextId++,
          createdAt: new Date().toISOString(),
        }),
      findByDeliveryId: (deliveryId) =>
        Effect.succeed(reviews.find((r) => r.deliveryId === deliveryId) ?? null),
    }),
  };
}

function makeJobQueueStore() {
  const jobs: JobData[] = [];
  return {
    jobs,
    layer: Layer.succeed(JobQueue, {
      enqueue: (data) =>
        Effect.sync(() => {
          jobs.push(data);
        }),
      cancel: (_id) => Effect.void,
      getQueueDepth: () => Effect.succeed(jobs.length),
      close: () => Effect.void,
    }),
  };
}

function makeGitHubMock(options?: { diffContent?: string; postedComments?: string[] }) {
  const postedComments = options?.postedComments ?? [];
  const diffContent =
    options?.diffContent ??
    `diff --git a/src/index.ts b/src/index.ts
index abc..def 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
 export const x = 1
+export const y = 2
`;
  return {
    postedComments,
    layer: Layer.succeed(GitHubClient, {
      fetchDiff: (_owner, _repo, _prNumber) => Effect.succeed(diffContent),
      postComment: (_owner, _repo, _prNumber, body) =>
        Effect.sync(() => {
          postedComments.push(body);
        }),
    }),
  };
}

function makeReviewBriefMock(options?: { shouldFail?: boolean }) {
  return Layer.succeed(ReviewBriefService, {
    generateReview: (_context) =>
      options?.shouldFail
        ? Effect.fail(
            new LlmError({
              reason: "exhausted",
              message: "All providers exhausted",
            }),
          )
        : Effect.succeed("## Summary\nMock review output"),
  });
}

function makeAppConfigLayer(dryRun = false) {
  return Layer.succeed(
    AppConfig,
    AppConfig.make({
      llmProvider: "openrouter" as const,
      openrouterApiKey: Option.some(Redacted.make("test-key")),
      openrouterModel: "test-model",
      githubToken: Redacted.make("test-token"),
      webhookSecret: "test-secret",
      confidenceThreshold: 6,
      dryRun,
      port: 8080,
      llmTemperature: 0.2,
    }),
  );
}

function buildTestLayer(options?: {
  dryRun?: boolean;
  llmShouldFail?: boolean;
  diffContent?: string;
  postedComments?: string[];
  deliveryStore?: ReturnType<typeof makeDeliveryStore>;
  jobQueueStore?: ReturnType<typeof makeJobQueueStore>;
}) {
  const deliveryStore = options?.deliveryStore ?? makeDeliveryStore();
  const reviewStore = makeReviewStore();
  const jobQueueStore = options?.jobQueueStore ?? makeJobQueueStore();
  const githubMock = makeGitHubMock({
    diffContent: options?.diffContent,
    postedComments: options?.postedComments,
  });
  const reviewBriefMock = makeReviewBriefMock({ shouldFail: options?.llmShouldFail });
  const appConfigLayer = makeAppConfigLayer(options?.dryRun ?? false);

  const PrReviewLayer = Layer.effect(PrReviewService, makePrReviewService);

  return {
    deliveryStore,
    reviewStore,
    jobQueueStore,
    githubMock,
    layer: PrReviewLayer.pipe(
      Layer.provide(deliveryStore.layer),
      Layer.provide(reviewStore.layer),
      Layer.provide(jobQueueStore.layer),
      Layer.provide(githubMock.layer),
      Layer.provide(reviewBriefMock),
      Layer.provide(appConfigLayer),
    ),
  };
}

const samplePayload: WebhookPayload = {
  deliveryId: "del-001",
  action: "opened",
  owner: "org",
  repo: "repo",
  prNumber: 42,
  prTitle: "Add feature",
  commitSha: "abc123",
};

const sampleJobData: JobData = {
  owner: "org",
  repo: "repo",
  prNumber: 42,
  commitSha: "abc123",
  deliveryId: "del-001",
  prTitle: "Add feature",
};

describe("PrReviewService", () => {
  describe("handleWebhook", () => {
    test("saves delivery and enqueues job", async () => {
      const { deliveryStore, jobQueueStore, layer } = buildTestLayer();

      await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* PrReviewService;
          yield* service.handleWebhook(samplePayload);
        }).pipe(Effect.provide(layer)),
      );

      expect(deliveryStore.deliveries.has("del-001")).toBe(true);
      expect(deliveryStore.deliveries.get("del-001")!.status).toBe("pending");
      expect(jobQueueStore.jobs).toHaveLength(1);
      expect(jobQueueStore.jobs[0]!.deliveryId).toBe("del-001");
    });

    test("duplicate X-GitHub-Delivery is skipped", async () => {
      const deliveryStore = makeDeliveryStore();
      const jobQueueStore = makeJobQueueStore();
      const { layer } = buildTestLayer({ deliveryStore, jobQueueStore });

      await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* PrReviewService;
          yield* service.handleWebhook(samplePayload);
          yield* service.handleWebhook(samplePayload);
        }).pipe(Effect.provide(layer)),
      );

      expect(jobQueueStore.jobs).toHaveLength(1);
    });
  });

  describe("processReview", () => {
    test("runs full pipeline and saves review", async () => {
      const postedComments: string[] = [];
      const deliveryStore = makeDeliveryStore();
      const { layer } = buildTestLayer({ postedComments, deliveryStore });

      await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* PrReviewService;
          yield* service.handleWebhook(samplePayload);
          yield* service.processReview(sampleJobData);
        }).pipe(Effect.provide(layer)),
      );

      expect(postedComments).toHaveLength(1);
      expect(postedComments[0]).toContain("## Summary");
      expect(deliveryStore.deliveries.get("del-001")!.status).toBe("completed");
    });

    test("DRY_RUN logs instead of posting comment", async () => {
      const postedComments: string[] = [];
      const deliveryStore = makeDeliveryStore();
      const { layer } = buildTestLayer({ dryRun: true, postedComments, deliveryStore });

      await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* PrReviewService;
          yield* service.handleWebhook(samplePayload);
          yield* service.processReview(sampleJobData);
        }).pipe(Effect.provide(layer)),
      );

      expect(postedComments).toHaveLength(0);
      expect(deliveryStore.deliveries.get("del-001")!.status).toBe("completed");
    });

    test("LLM failure posts error comment and marks delivery failed", async () => {
      const postedComments: string[] = [];
      const deliveryStore = makeDeliveryStore();
      const { layer } = buildTestLayer({
        llmShouldFail: true,
        postedComments,
        deliveryStore,
      });

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* PrReviewService;
          yield* service.handleWebhook(samplePayload);
          return yield* service.processReview(sampleJobData).pipe(
            Effect.matchEffect({
              onSuccess: () => Effect.succeed("no-error" as const),
              onFailure: (e) => Effect.succeed(e),
            }),
          );
        }).pipe(Effect.provide(layer)),
      );

      expect(result).toBeInstanceOf(LlmError);
      expect(postedComments).toHaveLength(1);
      expect(postedComments[0]).toContain("AI review unavailable");
      expect(deliveryStore.deliveries.get("del-001")!.status).toBe("failed");
    });
  });
});
