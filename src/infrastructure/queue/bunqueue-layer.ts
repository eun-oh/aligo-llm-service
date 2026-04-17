import { Config, Effect, Layer } from "effect";
import { Bunqueue } from "bunqueue/client";
import { type JobData, JobQueue, QueueError } from "../../application/ports/job-queue";

const makeJobId = (data: JobData): string =>
  `pr-review:${data.owner}/${data.repo}#${data.prNumber}`;

let jobProcessor: ((data: JobData) => Promise<void>) | null = null;

export function setJobProcessor(fn: (data: JobData) => Promise<void>): void {
  jobProcessor = fn;
}

export const BunqueueLayer = Layer.scoped(
  JobQueue,
  Effect.gen(function* () {
    const dataPath = yield* Config.string("BUNQUEUE_DATA_PATH").pipe(
      Config.withDefault("data/bunqueue.db"),
    );

    const app = new Bunqueue<JobData>("pr-reviews", {
      embedded: true,
      dataPath,
      processor: async (job) => {
        if (jobProcessor) {
          await jobProcessor(job.data);
        } else {
          console.log(`[bunqueue] No processor set, job ${job.id} ignored`);
        }
      },
    });

    yield* Effect.addFinalizer(() =>
      Effect.tryPromise({
        try: () => app.close(),
        catch: (cause) =>
          new QueueError({
            reason: "unknown",
            message: "Failed to close bunqueue",
            cause,
          }),
      }).pipe(Effect.orDie),
    );

    return {
      enqueue: (data: JobData) =>
        Effect.gen(function* () {
          const jobId = makeJobId(data);

          yield* Effect.tryPromise({
            try: () => app.queue.removeAsync(jobId),
            catch: () => undefined,
          }).pipe(Effect.ignore);

          yield* Effect.tryPromise({
            try: () => app.add("review-pr", data, { jobId }),
            catch: (cause) =>
              new QueueError({
                reason: "enqueue_failed",
                message: `Failed to enqueue job ${jobId}`,
                cause,
              }),
          });

          yield* Effect.logInfo(`Enqueued job ${jobId}`);
        }),

      cancel: (jobId: string) =>
        Effect.tryPromise({
          try: () => app.queue.removeAsync(jobId),
          catch: () => undefined,
        }).pipe(Effect.ignore, Effect.as(undefined)),

      getQueueDepth: () =>
        Effect.tryPromise({
          try: () => app.queue.getWaitingCount(),
          catch: (cause) =>
            new QueueError({
              reason: "unknown",
              message: "Failed to get queue depth",
              cause,
            }),
        }),

      close: () =>
        Effect.tryPromise({
          try: () => app.close(),
          catch: (cause) =>
            new QueueError({
              reason: "unknown",
              message: "Failed to close bunqueue",
              cause,
            }),
        }),
    };
  }),
);
