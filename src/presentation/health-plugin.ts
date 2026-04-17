import { Elysia } from "elysia";
import { Effect } from "effect";
import { JobQueue } from "../application/ports/job-queue";
import { LlmProvider } from "../application/ports/llm-provider";
import { statSync } from "node:fs";

export function healthPlugin(runEffect: (effect: Effect.Effect<any, any, any>) => Promise<any>) {
  // biome-ignore lint: runtime provides all requirements
  return new Elysia({ name: "health" }).get("/health", async () => {
    const result = await runEffect(
      Effect.gen(function* () {
        const queue = yield* JobQueue;
        const llm = yield* LlmProvider;

        const depth = yield* queue.getQueueDepth().pipe(Effect.catchAll(() => Effect.succeed(-1)));

        let diskUsagePercent = -1;
        try {
          const stat = statSync("data/");
          if (stat.isDirectory()) {
            const dbSize = Bun.file("data/aligo-llm.db").size;
            const queueSize = Bun.file("data/bunqueue.db").size;
            diskUsagePercent = Math.round((dbSize + queueSize) / 1024 / 1024);
          }
        } catch {
          // data dir may not exist yet
        }

        return {
          status: "ok" as const,
          queue: { depth },
          provider: { name: llm.name, reachable: true },
          disk: { usageMb: diskUsagePercent },
        };
      }),
    );

    return result;
  });
}
