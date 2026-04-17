import { Elysia } from "elysia";
import { Effect, Layer, Logger, LogLevel, ManagedRuntime } from "effect";
import { FetchHttpClient } from "@effect/platform";

import { AppConfig } from "./config";
import { DrizzleLiveLayer } from "./infrastructure/db/drizzle-layer";
import { DeliveryRepositoryLiveLayer } from "./infrastructure/db/delivery-repository-layer";
import { ReviewRepositoryLiveLayer } from "./infrastructure/db/review-repository-layer";
import { OpenRouterLayer } from "./infrastructure/llm/openrouter-layer";
import { GitHubClientLayer } from "./infrastructure/github/github-client-layer";
import { BunqueueLayer } from "./infrastructure/queue/bunqueue-layer";
import {
  ReviewBriefService,
  makeReviewBriefService,
  loadPromptTemplate,
} from "./application/services/review-brief-service";
import { PrReviewService, makePrReviewService } from "./application/services/pr-review-service";

import { webhookPlugin } from "./presentation/webhook-plugin";
import { healthPlugin } from "./presentation/health-plugin";

// --- Layer composition ---

const DbLayer = DeliveryRepositoryLiveLayer.pipe(
  Layer.provideMerge(ReviewRepositoryLiveLayer),
  Layer.provideMerge(DrizzleLiveLayer),
);

const HttpLayer = FetchHttpClient.layer;

const GithubLayer = GitHubClientLayer.pipe(
  Layer.provide(Layer.merge(AppConfig.Default, HttpLayer)),
);

const LlmLayer = OpenRouterLayer.pipe(Layer.provide(Layer.merge(AppConfig.Default, HttpLayer)));

const QueueLayer = BunqueueLayer;

const ReviewBriefLayer = Layer.effect(
  ReviewBriefService,
  Effect.gen(function* () {
    const template = yield* loadPromptTemplate("src/domain/pr-review/prompts/review-brief.txt");
    return yield* makeReviewBriefService(template);
  }),
).pipe(Layer.provide(LlmLayer));

const PrReviewLayer = Layer.effect(PrReviewService, makePrReviewService).pipe(
  Layer.provide(
    Layer.mergeAll(GithubLayer, DbLayer, QueueLayer, ReviewBriefLayer, AppConfig.Default),
  ),
);

const LiveLayer = Layer.mergeAll(
  PrReviewLayer,
  QueueLayer,
  LlmLayer,
  DbLayer,
  AppConfig.Default,
).pipe(Layer.provide(Logger.structured));

// --- Server startup ---

const main = Effect.gen(function* () {
  const config = yield* AppConfig;

  const runtime = ManagedRuntime.make(LiveLayer);

  const runEffect = (effect: Effect.Effect<any, any, any>) => runtime.runPromise(effect);

  const app = new Elysia()
    .use(webhookPlugin(config.webhookSecret, runEffect))
    .use(healthPlugin(runEffect))
    .listen(config.port);

  yield* Effect.log(`Server listening on port ${config.port}`);
  if (config.dryRun) {
    yield* Effect.log("[DRY_RUN] Reviews will be logged, not posted to GitHub");
  }

  // Keep process alive, clean up on signal
  yield* Effect.async<never>(() => {
    const shutdown = () => {
      app.stop();
      runtime.dispose().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
});

Effect.runFork(
  main.pipe(
    Effect.provide(AppConfig.Default),
    Effect.provide(Logger.minimumLogLevel(LogLevel.Info)),
    Effect.provide(Logger.structured),
  ),
);
