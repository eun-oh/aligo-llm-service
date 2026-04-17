import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform";
import { Effect, Layer, Redacted, Schedule } from "effect";
import { AppConfig } from "../../config";
import { GithubError, GitHubClient } from "../../application/ports/github-client";

const GITHUB_COMMENT_LIMIT = 65536;

const rateLimitRetry = Schedule.compose(Schedule.exponential("2 seconds"), Schedule.recurs(2)).pipe(
  Schedule.whileInput((error: GithubError) => error.reason === "rate_limit"),
);

export const GitHubClientLayer = Layer.effect(
  GitHubClient,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const token = Redacted.value(config.githubToken);

    const baseClient = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest((req) =>
        req.pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.setHeader("X-GitHub-Api-Version", "2022-11-28"),
        ),
      ),
    );

    const executeRequest = (request: HttpClientRequest.HttpClientRequest) =>
      baseClient.execute(request).pipe(
        Effect.catchTag("RequestError", (error) =>
          Effect.fail(
            new GithubError({
              reason: "unknown",
              message: "Failed to reach GitHub API",
              cause: error,
            }),
          ),
        ),
        Effect.catchTag("ResponseError", (error) =>
          Effect.fail(
            new GithubError({
              reason: "unknown",
              message: "Unexpected response error from GitHub",
              cause: error,
            }),
          ),
        ),
      );

    const handleStatus = <A>(
      response: HttpClientResponse.HttpClientResponse,
      onOk: (res: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, GithubError>,
    ): Effect.Effect<A, GithubError> =>
      HttpClientResponse.matchStatus(response, {
        200: onOk,
        201: onOk,
        401: () =>
          Effect.fail(
            new GithubError({ reason: "auth", message: "GitHub token expired or invalid" }),
          ),
        403: () =>
          Effect.fail(
            new GithubError({ reason: "rate_limit", message: "GitHub API rate limited" }),
          ),
        429: () =>
          Effect.fail(
            new GithubError({ reason: "rate_limit", message: "GitHub API rate limited" }),
          ),
        404: () => Effect.fail(new GithubError({ reason: "not_found", message: "PR not found" })),
        orElse: (res) =>
          Effect.fail(
            new GithubError({ reason: "unknown", message: `GitHub returned ${res.status}` }),
          ),
      });

    return {
      fetchDiff: (owner, repo, prNumber) =>
        Effect.gen(function* () {
          const request = HttpClientRequest.get(
            `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
          ).pipe(HttpClientRequest.accept("application/vnd.github.v3.diff"));

          const response = yield* executeRequest(request);

          return yield* handleStatus(response, (res) =>
            res.text.pipe(
              Effect.catchTag("ResponseError", (error) =>
                Effect.fail(
                  new GithubError({
                    reason: "unknown",
                    message: "Failed to read diff body",
                    cause: error,
                  }),
                ),
              ),
            ),
          );
        }).pipe(Effect.retry(rateLimitRetry)),

      postComment: (owner, repo, prNumber, body) =>
        Effect.gen(function* () {
          let commentBody = body;
          if (commentBody.length > GITHUB_COMMENT_LIMIT) {
            commentBody =
              commentBody.slice(0, GITHUB_COMMENT_LIMIT - 100) +
              "\n\n---\n*Review truncated due to GitHub comment length limit.*";
          }

          const request = HttpClientRequest.post(
            `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
          ).pipe(
            HttpClientRequest.accept("application/vnd.github.v3+json"),
            HttpClientRequest.bodyUnsafeJson({ body: commentBody }),
          );

          const response = yield* executeRequest(request);
          yield* handleStatus(response, () => Effect.void);
        }).pipe(Effect.retry(rateLimitRetry)),
    };
  }),
);
