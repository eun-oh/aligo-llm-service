import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect, Layer } from "effect";
import { ReviewRepository } from "../src/application/ports/review-repository";
import { DrizzleDb } from "../src/infrastructure/db/drizzle-layer";
import { ReviewRepositoryLiveLayer } from "../src/infrastructure/db/review-repository-layer";
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
  return ReviewRepositoryLiveLayer.pipe(Layer.provide(DrizzleTestLayer));
}

function seedDelivery(sqlite: Database, deliveryId: string) {
  sqlite.exec(
    `INSERT INTO deliveries (delivery_id, repo, pr_number, commit_sha, status)
     VALUES ('${deliveryId}', 'org/repo', 1, 'sha1', 'pending')`,
  );
}

function makeTestLayerWithDelivery(deliveryId: string) {
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
  seedDelivery(sqlite, deliveryId);
  const client = drizzle(sqlite, { schema });
  const DrizzleTestLayer = Layer.succeed(DrizzleDb, { client });
  return ReviewRepositoryLiveLayer.pipe(Layer.provide(DrizzleTestLayer));
}

const sampleReview = {
  deliveryId: "del-001",
  prUrl: "https://github.com/org/repo/pull/1",
  brief: "Looks good",
  rawLlmOutput: '{"findings": []}',
  promptUsed: "Review this PR",
  modelName: "gpt-4",
  durationMs: 1500,
};

describe("ReviewRepository", () => {
  test("save and retrieve review with correct fields", async () => {
    const layer = makeTestLayerWithDelivery("del-001");
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* ReviewRepository;
        const saved = yield* repo.save(sampleReview);
        return saved;
      }).pipe(Effect.provide(layer)),
    );
    expect(result.id).toBeGreaterThan(0);
    expect(result.deliveryId).toBe("del-001");
    expect(result.prUrl).toBe("https://github.com/org/repo/pull/1");
    expect(result.brief).toBe("Looks good");
    expect(result.rawLlmOutput).toBe('{"findings": []}');
    expect(result.promptUsed).toBe("Review this PR");
    expect(result.modelName).toBe("gpt-4");
    expect(result.durationMs).toBe(1500);
    expect(result.createdAt).toBeTruthy();
  });

  test("findByDeliveryId returns the correct review", async () => {
    const layer = makeTestLayerWithDelivery("del-002");
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* ReviewRepository;
        yield* repo.save({ ...sampleReview, deliveryId: "del-002" });
        return yield* repo.findByDeliveryId("del-002");
      }).pipe(Effect.provide(layer)),
    );
    expect(result).not.toBeNull();
    expect(result!.deliveryId).toBe("del-002");
    expect(result!.brief).toBe("Looks good");
  });

  test("findByDeliveryId returns null for non-existent delivery", async () => {
    const layer = makeTestLayer();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* ReviewRepository;
        return yield* repo.findByDeliveryId("non-existent");
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toBeNull();
  });

  test("save review with null durationMs", async () => {
    const layer = makeTestLayerWithDelivery("del-003");
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* ReviewRepository;
        return yield* repo.save({
          ...sampleReview,
          deliveryId: "del-003",
          durationMs: null,
        });
      }).pipe(Effect.provide(layer)),
    );
    expect(result.durationMs).toBeNull();
  });
});
