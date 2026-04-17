import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConfigProvider, Context, Effect, Exit, Layer, Scope } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type JobData, JobQueue } from "../src/application/ports/job-queue";
import { BunqueueLayer } from "../src/infrastructure/queue/bunqueue-layer";

const sampleJob: JobData = {
  owner: "aligo-ai",
  repo: "aligo-llm-service",
  prNumber: 42,
  commitSha: "abc123",
  deliveryId: "delivery-1",
  prTitle: "feat: add queue",
};

let tmpDir: string;
let scope: Scope.CloseableScope;
let svc: Context.Tag.Service<typeof JobQueue>;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bunqueue-test-"));
  const dataPath = join(tmpDir, "test-queue.db");

  const configLayer = Layer.setConfigProvider(
    ConfigProvider.fromMap(new Map([["BUNQUEUE_DATA_PATH", dataPath]])),
  );
  const testLayer = Layer.provide(BunqueueLayer, configLayer);

  scope = Effect.runSync(Scope.make());

  const ctx = await Effect.runPromise(Layer.buildWithScope(testLayer, scope));
  svc = Context.get(ctx, JobQueue);
});

afterEach(async () => {
  if (scope) {
    await Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => {});
  }
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("BunqueueLayer", () => {
  test("enqueue a job increases queue depth", async () => {
    const depthBefore = await Effect.runPromise(svc.getQueueDepth());
    expect(depthBefore).toBe(0);

    await Effect.runPromise(svc.enqueue(sampleJob));

    const depthAfter = await Effect.runPromise(svc.getQueueDepth());
    expect(depthAfter).toBeGreaterThanOrEqual(1);
  });

  test("enqueue replaces existing job for same PR (depth stays 1)", async () => {
    await Effect.runPromise(svc.enqueue(sampleJob));

    const updatedJob: JobData = { ...sampleJob, commitSha: "def456" };
    await Effect.runPromise(svc.enqueue(updatedJob));

    const depth = await Effect.runPromise(svc.getQueueDepth());
    expect(depth).toBeLessThanOrEqual(1);
  });

  test("cancel removes a pending job", async () => {
    await Effect.runPromise(svc.enqueue(sampleJob));
    const jobId = `pr-review:${sampleJob.owner}/${sampleJob.repo}#${sampleJob.prNumber}`;

    await Effect.runPromise(svc.cancel(jobId));

    const depth = await Effect.runPromise(svc.getQueueDepth());
    expect(depth).toBe(0);
  });

  test("cancel non-existent jobId is a no-op", async () => {
    await Effect.runPromise(svc.cancel("non-existent-job-id"));
    // No error thrown = success
  });

  test("getQueueDepth returns correct count", async () => {
    expect(await Effect.runPromise(svc.getQueueDepth())).toBe(0);

    await Effect.runPromise(svc.enqueue(sampleJob));
    const depthAfterOne = await Effect.runPromise(svc.getQueueDepth());
    expect(depthAfterOne).toBeGreaterThanOrEqual(1);

    const job2: JobData = { ...sampleJob, prNumber: 99 };
    await Effect.runPromise(svc.enqueue(job2));
    const depthAfterTwo = await Effect.runPromise(svc.getQueueDepth());
    expect(depthAfterTwo).toBeGreaterThanOrEqual(2);
  });

  test("close shuts down gracefully", async () => {
    await Effect.runPromise(svc.close());
    // No error thrown = success
  });
});
