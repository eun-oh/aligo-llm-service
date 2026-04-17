import { Context, Effect } from "effect";
import { parseDiff, chunkDiffs } from "../../domain/pr-review/diff-parser";
import { classifyRisks } from "../../domain/pr-review/risk-classifier";
import { GitHubClient, type GithubError } from "../ports/github-client";
import { DeliveryRepository, type DeliveryError } from "../ports/delivery-repository";
import { ReviewRepository, type ReviewError } from "../ports/review-repository";
import { JobQueue, type QueueError, type JobData } from "../ports/job-queue";
import { LlmError } from "../ports/llm-provider";
import { ReviewBriefService } from "./review-brief-service";
import { AppConfig } from "../../config";

export interface WebhookPayload {
  readonly deliveryId: string;
  readonly action: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly prTitle: string;
  readonly commitSha: string;
}

export class PrReviewService extends Context.Tag("PrReviewService")<
  PrReviewService,
  {
    readonly handleWebhook: (
      payload: WebhookPayload,
    ) => Effect.Effect<void, DeliveryError | QueueError>;
    readonly processReview: (
      jobData: JobData,
    ) => Effect.Effect<void, LlmError | GithubError | DeliveryError | ReviewError>;
  }
>() {}

export const makePrReviewService = Effect.gen(function* () {
  const github = yield* GitHubClient;
  const deliveryRepo = yield* DeliveryRepository;
  const reviewRepo = yield* ReviewRepository;
  const jobQueue = yield* JobQueue;
  const reviewBrief = yield* ReviewBriefService;
  const config = yield* AppConfig;

  const handleWebhook = (
    payload: WebhookPayload,
  ): Effect.Effect<void, DeliveryError | QueueError> =>
    Effect.gen(function* () {
      const existing = yield* deliveryRepo.findByDeliveryId(payload.deliveryId);
      if (existing) {
        yield* Effect.log(`Duplicate delivery ${payload.deliveryId}, skipping`);
        return;
      }

      yield* deliveryRepo.save({
        deliveryId: payload.deliveryId,
        repo: `${payload.owner}/${payload.repo}`,
        prNumber: payload.prNumber,
        commitSha: payload.commitSha,
        status: "pending",
      });

      yield* jobQueue.enqueue({
        owner: payload.owner,
        repo: payload.repo,
        prNumber: payload.prNumber,
        commitSha: payload.commitSha,
        deliveryId: payload.deliveryId,
        prTitle: payload.prTitle,
      });

      yield* Effect.log(
        `Enqueued review job for ${payload.owner}/${payload.repo}#${payload.prNumber}`,
      );
    });

  const processReview = (
    jobData: JobData,
  ): Effect.Effect<void, LlmError | GithubError | DeliveryError | ReviewError> =>
    Effect.gen(function* () {
      const rawDiff = yield* github.fetchDiff(jobData.owner, jobData.repo, jobData.prNumber);
      const files = parseDiff(rawDiff);
      const _risks = classifyRisks(files);
      const chunks = chunkDiffs(files);

      const diff = chunks.map((c) => c.content).join("\n");
      const linesChanged = files.reduce((sum, f) => sum + f.linesChanged, 0);

      const start = Date.now();
      const reviewText = yield* reviewBrief
        .generateReview({
          repoName: `${jobData.owner}/${jobData.repo}`,
          prTitle: jobData.prTitle,
          fileCount: files.length,
          linesChanged,
          diff,
        })
        .pipe(
          Effect.catchTag("LlmError", (err) =>
            err.reason === "exhausted"
              ? Effect.gen(function* () {
                  if (!config.dryRun) {
                    yield* github.postComment(
                      jobData.owner,
                      jobData.repo,
                      jobData.prNumber,
                      "AI review unavailable for this commit. Will retry on next push.",
                    );
                  }
                  yield* deliveryRepo.updateStatus(jobData.deliveryId, "failed");
                  yield* Effect.logError(
                    `LLM exhausted for ${jobData.owner}/${jobData.repo}#${jobData.prNumber}: ${err.message}`,
                  );
                  return yield* Effect.fail(err);
                })
              : Effect.fail(err),
          ),
        );
      const durationMs = Date.now() - start;

      const prompt = `[template filled for ${jobData.owner}/${jobData.repo}#${jobData.prNumber}]`;

      yield* reviewRepo.save({
        deliveryId: jobData.deliveryId,
        prUrl: `https://github.com/${jobData.owner}/${jobData.repo}/pull/${jobData.prNumber}`,
        brief: reviewText,
        rawLlmOutput: reviewText,
        promptUsed: prompt,
        modelName: config.openrouterModel,
        durationMs,
      });

      if (config.dryRun) {
        yield* Effect.log(
          `[DRY_RUN] Review for ${jobData.owner}/${jobData.repo}#${jobData.prNumber}:\n${reviewText}`,
        );
      } else {
        yield* github.postComment(jobData.owner, jobData.repo, jobData.prNumber, reviewText);
      }

      yield* deliveryRepo.updateStatus(jobData.deliveryId, "completed");

      yield* Effect.log(
        `Review completed for ${jobData.owner}/${jobData.repo}#${jobData.prNumber} in ${durationMs}ms`,
      );
    });

  return { handleWebhook, processReview };
});
