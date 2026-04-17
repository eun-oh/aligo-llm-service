import { Context, Data, Effect } from "effect";

export class QueueError extends Data.TaggedError("QueueError")<{
  readonly reason: "enqueue_failed" | "cancel_failed" | "unknown";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface JobData {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly commitSha: string;
  readonly deliveryId: string;
  readonly prTitle: string;
}

export class JobQueue extends Context.Tag("JobQueue")<
  JobQueue,
  {
    readonly enqueue: (data: JobData) => Effect.Effect<void, QueueError>;
    readonly cancel: (jobId: string) => Effect.Effect<void, QueueError>;
    readonly getQueueDepth: () => Effect.Effect<number, QueueError>;
    readonly close: () => Effect.Effect<void, QueueError>;
  }
>() {}
