import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect, Layer } from "effect";
import { DeliveryError, DeliveryRepository } from "../src/application/ports/delivery-repository";
import { DeliveryRepositoryLiveLayer } from "../src/infrastructure/db/delivery-repository-layer";
import { DrizzleDb } from "../src/infrastructure/db/drizzle-layer";
import * as schema from "../src/infrastructure/db/schema";

function makeTestLayer() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS deliveries (
      delivery_id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      commit_sha TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_deliveries_pr
      ON deliveries(repo, pr_number, status);
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_id TEXT NOT NULL REFERENCES deliveries(delivery_id),
      pr_url TEXT NOT NULL,
      brief TEXT NOT NULL,
      raw_llm_output TEXT NOT NULL,
      prompt_used TEXT NOT NULL,
      model_name TEXT NOT NULL,
      duration_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const client = drizzle(sqlite, { schema });
  const DrizzleTestLayer = Layer.succeed(DrizzleDb, { client });
  return DeliveryRepositoryLiveLayer.pipe(Layer.provide(DrizzleTestLayer));
}

function run<A, E>(effect: Effect.Effect<A, E, DeliveryRepository>) {
  return Effect.runPromise(effect.pipe(Effect.provide(makeTestLayer())));
}

describe("DeliveryRepository", () => {
  test("save and findByDeliveryId — round trip", async () => {
    const layer = makeTestLayer();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* DeliveryRepository;
        yield* repo.save({
          deliveryId: "del-001",
          repo: "org/repo",
          prNumber: 42,
          commitSha: "abc123",
          status: "pending",
        });
        return yield* repo.findByDeliveryId("del-001");
      }).pipe(Effect.provide(layer)),
    );
    expect(result).not.toBeNull();
    expect(result!.deliveryId).toBe("del-001");
    expect(result!.repo).toBe("org/repo");
    expect(result!.prNumber).toBe(42);
    expect(result!.commitSha).toBe("abc123");
    expect(result!.status).toBe("pending");
    expect(result!.createdAt).toBeTruthy();
  });

  test("duplicate deliveryId insert returns DeliveryError with reason duplicate", async () => {
    const layer = makeTestLayer();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* DeliveryRepository;
        yield* repo.save({
          deliveryId: "del-dup",
          repo: "org/repo",
          prNumber: 1,
          commitSha: "sha1",
          status: "pending",
        });
        return yield* repo
          .save({
            deliveryId: "del-dup",
            repo: "org/repo",
            prNumber: 1,
            commitSha: "sha2",
            status: "pending",
          })
          .pipe(
            Effect.matchEffect({
              onSuccess: () => Effect.succeed("no-error" as const),
              onFailure: (e) => Effect.succeed(e),
            }),
          );
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toBeInstanceOf(DeliveryError);
    if (result instanceof DeliveryError) {
      expect(result.reason).toBe("duplicate");
    }
  });

  test("findPending returns only pending deliveries for a PR", async () => {
    const layer = makeTestLayer();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* DeliveryRepository;
        yield* repo.save({
          deliveryId: "del-p1",
          repo: "org/repo",
          prNumber: 10,
          commitSha: "sha1",
          status: "pending",
        });
        yield* repo.save({
          deliveryId: "del-p2",
          repo: "org/repo",
          prNumber: 10,
          commitSha: "sha2",
          status: "pending",
        });
        yield* repo.save({
          deliveryId: "del-c1",
          repo: "org/repo",
          prNumber: 10,
          commitSha: "sha3",
          status: "completed",
        });
        yield* repo.save({
          deliveryId: "del-other",
          repo: "org/other",
          prNumber: 10,
          commitSha: "sha4",
          status: "pending",
        });
        return yield* repo.findPending("org/repo", 10);
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toHaveLength(2);
    expect(result.map((d) => d.deliveryId).sort()).toEqual(["del-p1", "del-p2"]);
  });

  test("updateStatus transitions pending to completed", async () => {
    const layer = makeTestLayer();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* DeliveryRepository;
        yield* repo.save({
          deliveryId: "del-up",
          repo: "org/repo",
          prNumber: 5,
          commitSha: "sha1",
          status: "pending",
        });
        yield* repo.updateStatus("del-up", "completed");
        return yield* repo.findByDeliveryId("del-up");
      }).pipe(Effect.provide(layer)),
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe("completed");
  });

  test("updateStatus on non-existent delivery returns not_found error", async () => {
    const layer = makeTestLayer();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* DeliveryRepository;
        return yield* repo.updateStatus("non-existent", "completed").pipe(
          Effect.matchEffect({
            onSuccess: () => Effect.succeed("no-error" as const),
            onFailure: (e) => Effect.succeed(e),
          }),
        );
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toBeInstanceOf(DeliveryError);
    if (result instanceof DeliveryError) {
      expect(result.reason).toBe("not_found");
    }
  });

  test("findByDeliveryId with non-existent ID returns null", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* DeliveryRepository;
        return yield* repo.findByDeliveryId("does-not-exist");
      }),
    );
    expect(result).toBeNull();
  });
});
