import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import type { Review } from "../../application/ports/review-repository";
import { ReviewError, ReviewRepository } from "../../application/ports/review-repository";
import { DrizzleDb } from "./drizzle-layer";
import { reviews } from "./schema";

export const ReviewRepositoryLiveLayer = Layer.effect(
  ReviewRepository,
  Effect.gen(function* () {
    const { client } = yield* DrizzleDb;

    return {
      save: (review: Omit<Review, "id" | "createdAt">) =>
        Effect.try({
          try: () => {
            const row = client.insert(reviews).values(review).returning().get();
            return {
              id: row.id,
              deliveryId: row.deliveryId,
              prUrl: row.prUrl,
              brief: row.brief,
              rawLlmOutput: row.rawLlmOutput,
              promptUsed: row.promptUsed,
              modelName: row.modelName,
              durationMs: row.durationMs,
              createdAt: row.createdAt,
            } satisfies Review;
          },
          catch: (cause) =>
            new ReviewError({
              reason: "unknown",
              message: `Failed to save review: ${cause instanceof Error ? cause.message : String(cause)}`,
              cause,
            }),
        }),

      findByDeliveryId: (deliveryId: string) =>
        Effect.try({
          try: () => {
            const row = client
              .select()
              .from(reviews)
              .where(eq(reviews.deliveryId, deliveryId))
              .get();
            if (!row) return null;
            return {
              id: row.id,
              deliveryId: row.deliveryId,
              prUrl: row.prUrl,
              brief: row.brief,
              rawLlmOutput: row.rawLlmOutput,
              promptUsed: row.promptUsed,
              modelName: row.modelName,
              durationMs: row.durationMs,
              createdAt: row.createdAt,
            } satisfies Review;
          },
          catch: (cause) =>
            new ReviewError({
              reason: "unknown",
              message: `Failed to find review: ${cause instanceof Error ? cause.message : String(cause)}`,
              cause,
            }),
        }),
    };
  }),
);
