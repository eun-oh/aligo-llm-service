import { and, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import {
  type Delivery,
  DeliveryError,
  DeliveryRepository,
  type DeliveryStatus,
} from "../../application/ports/delivery-repository";
import { DrizzleDb } from "./drizzle-layer";
import { deliveries } from "./schema";

export const DeliveryRepositoryLiveLayer = Layer.effect(
  DeliveryRepository,
  Effect.gen(function* () {
    const { client } = yield* DrizzleDb;

    return {
      save: (delivery: Omit<Delivery, "createdAt">) =>
        Effect.try({
          try: () => {
            client.insert(deliveries).values(delivery).run();
          },
          catch: (cause) => {
            const msg = cause instanceof Error ? cause.message : String(cause);
            if (msg.includes("UNIQUE constraint failed")) {
              return new DeliveryError({
                reason: "duplicate",
                message: `Delivery ${delivery.deliveryId} already exists`,
                cause,
              });
            }
            return new DeliveryError({
              reason: "unknown",
              message: `Failed to save delivery: ${msg}`,
              cause,
            });
          },
        }),

      findByDeliveryId: (deliveryId: string) =>
        Effect.try({
          try: () => {
            const row = client
              .select()
              .from(deliveries)
              .where(eq(deliveries.deliveryId, deliveryId))
              .get();
            if (!row) return null;
            return {
              deliveryId: row.deliveryId,
              repo: row.repo,
              prNumber: row.prNumber,
              commitSha: row.commitSha,
              status: row.status as DeliveryStatus,
              createdAt: row.createdAt,
            } satisfies Delivery;
          },
          catch: (cause) =>
            new DeliveryError({
              reason: "unknown",
              message: `Failed to find delivery: ${cause instanceof Error ? cause.message : String(cause)}`,
              cause,
            }),
        }),

      findPending: (repo: string, prNumber: number) =>
        Effect.try({
          try: () => {
            const rows = client
              .select()
              .from(deliveries)
              .where(
                and(
                  eq(deliveries.repo, repo),
                  eq(deliveries.prNumber, prNumber),
                  eq(deliveries.status, "pending"),
                ),
              )
              .all();
            return rows.map(
              (row) =>
                ({
                  deliveryId: row.deliveryId,
                  repo: row.repo,
                  prNumber: row.prNumber,
                  commitSha: row.commitSha,
                  status: row.status as DeliveryStatus,
                  createdAt: row.createdAt,
                }) satisfies Delivery,
            );
          },
          catch: (cause) =>
            new DeliveryError({
              reason: "unknown",
              message: `Failed to find pending deliveries: ${cause instanceof Error ? cause.message : String(cause)}`,
              cause,
            }),
        }),

      updateStatus: (deliveryId: string, status: DeliveryStatus) =>
        Effect.gen(function* () {
          const existing = yield* Effect.try({
            try: () =>
              client
                .select({ deliveryId: deliveries.deliveryId })
                .from(deliveries)
                .where(eq(deliveries.deliveryId, deliveryId))
                .get(),
            catch: (cause) =>
              new DeliveryError({
                reason: "unknown",
                message: `Failed to check delivery existence: ${cause instanceof Error ? cause.message : String(cause)}`,
                cause,
              }),
          });
          if (!existing) {
            return yield* Effect.fail(
              new DeliveryError({
                reason: "not_found",
                message: `Delivery ${deliveryId} not found`,
              }),
            );
          }
          yield* Effect.try({
            try: () =>
              client
                .update(deliveries)
                .set({ status })
                .where(eq(deliveries.deliveryId, deliveryId))
                .run(),
            catch: (cause) =>
              new DeliveryError({
                reason: "unknown",
                message: `Failed to update delivery status: ${cause instanceof Error ? cause.message : String(cause)}`,
                cause,
              }),
          });
        }),
    };
  }),
);
