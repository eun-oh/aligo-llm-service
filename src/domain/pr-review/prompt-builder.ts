export interface PromptContext {
  readonly repoName: string;
  readonly prTitle: string;
  readonly fileCount: number;
  readonly linesChanged: number;
  readonly diff: string;
}

export function buildPrompt(template: string, context: PromptContext): string {
  return template
    .replace("{{repo_name}}", context.repoName)
    .replace("{{pr_title}}", context.prTitle)
    .replace("{{file_count}}", String(context.fileCount))
    .replace("{{lines_changed}}", String(context.linesChanged))
    .replace("{{diff}}", context.diff);
}
