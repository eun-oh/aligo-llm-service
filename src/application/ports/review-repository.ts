import { Context, Data, Effect } from "effect";

export class ReviewError extends Data.TaggedError("ReviewError")<{
  readonly reason: "not_found" | "unknown";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface Review {
  readonly id: number;
  readonly deliveryId: string;
  readonly prUrl: string;
  readonly brief: string;
  readonly rawLlmOutput: string;
  readonly promptUsed: string;
  readonly modelName: string;
  readonly durationMs: number | null;
  readonly createdAt: string;
}

export class ReviewRepository extends Context.Tag("ReviewRepository")<
  ReviewRepository,
  {
    readonly save: (review: Omit<Review, "id" | "createdAt">) => Effect.Effect<Review, ReviewError>;
    readonly findByDeliveryId: (deliveryId: string) => Effect.Effect<Review | null, ReviewError>;
  }
>() {}
