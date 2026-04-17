import { Config, Effect } from "effect";

export class AppConfig extends Effect.Service<AppConfig>()("AppConfig", {
  effect: Effect.gen(function* () {
    const llmProvider = yield* Config.string("LLM_PROVIDER").pipe(Config.withDefault("openrouter"));
    const openrouterApiKey = yield* Config.redacted("OPENROUTER_API_KEY").pipe(Config.option);
    const openrouterModel = yield* Config.string("OPENROUTER_MODEL").pipe(
      Config.withDefault("openai/gpt-oss-120b:free"),
    );
    const githubToken = yield* Config.redacted("GITHUB_TOKEN");
    const webhookSecret = yield* Config.string("WEBHOOK_SECRET");
    const confidenceThreshold = yield* Config.number("CONFIDENCE_THRESHOLD").pipe(
      Config.withDefault(6),
    );
    const dryRun = yield* Config.boolean("DRY_RUN").pipe(Config.withDefault(false));
    const port = yield* Config.number("PORT").pipe(Config.withDefault(8080));
    const llmTemperature = yield* Config.number("LLM_TEMPERATURE").pipe(Config.withDefault(0.2));
    return {
      llmProvider: llmProvider as "openrouter" | "local",
      openrouterApiKey,
      openrouterModel,
      githubToken,
      webhookSecret,
      confidenceThreshold,
      dryRun,
      port,
      llmTemperature,
    };
  }),
  dependencies: [],
}) {}
