import { Context, Data, Effect } from "effect";

export class GithubError extends Data.TaggedError("GithubError")<{
  readonly reason: "auth" | "rate_limit" | "not_found" | "unknown";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class GitHubClient extends Context.Tag("GitHubClient")<
  GitHubClient,
  {
    readonly fetchDiff: (
      owner: string,
      repo: string,
      prNumber: number,
    ) => Effect.Effect<string, GithubError>;
    readonly postComment: (
      owner: string,
      repo: string,
      prNumber: number,
      body: string,
    ) => Effect.Effect<void, GithubError>;
  }
>() {}
