import { Context, Data, Effect } from "effect";

export class DeliveryError extends Data.TaggedError("DeliveryError")<{
  readonly reason: "not_found" | "duplicate" | "unknown";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type DeliveryStatus = "pending" | "completed" | "failed" | "cancelled";

export interface Delivery {
  readonly deliveryId: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly commitSha: string;
  readonly status: DeliveryStatus;
  readonly createdAt: string;
}

export class DeliveryRepository extends Context.Tag("DeliveryRepository")<
  DeliveryRepository,
  {
    readonly save: (delivery: Omit<Delivery, "createdAt">) => Effect.Effect<void, DeliveryError>;
    readonly findByDeliveryId: (
      deliveryId: string,
    ) => Effect.Effect<Delivery | null, DeliveryError>;
    readonly findPending: (
      repo: string,
      prNumber: number,
    ) => Effect.Effect<readonly Delivery[], DeliveryError>;
    readonly updateStatus: (
      deliveryId: string,
      status: DeliveryStatus,
    ) => Effect.Effect<void, DeliveryError>;
  }
>() {}
