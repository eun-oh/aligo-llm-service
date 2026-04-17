#!/usr/bin/env bun
/**
 * Phase 0 test harness: runs a PR diff through OpenRouter and saves the review output.
 *
 * Usage:
 *   bun scripts/phase-0-test.ts --model anthropic/claude-sonnet-4 --diff test-diffs/01-small.diff
 *   bun scripts/phase-0-test.ts --model openai/gpt-4o --diff test-diffs/02-medium-a.diff --title "Add auth middleware"
 *
 * Environment:
 *   OPENROUTER_API_KEY - required
 *
 * Output:
 *   Saves review to docs/phase-0-results/{model-short}-{diff-name}-{timestamp}.md
 *   Prints response time and token usage to stdout
 */

import { parseArgs } from "util";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { basename, join } from "path";

const MODELS = [
  "qwen/qwen3-coder:free",
  "google/gemma-4-31b-it:free",
  "nvidia/nemotron-3-super-120b:free",
  "openai/gpt-oss-120b:free",
] as const;

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const RESULTS_DIR = "docs/phase-0-results";
const PROMPT_PATH = "src/features/pr-review/prompts/review-brief.txt";

function parseCliArgs() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      model: { type: "string", short: "m" },
      diff: { type: "string", short: "d" },
      title: { type: "string", short: "t", default: "Untitled PR" },
      temperature: { type: "string", default: "0.2" },
      "max-tokens": { type: "string", default: "4096" },
      "list-models": { type: "boolean", short: "l" },
    },
  });

  if (values["list-models"]) {
    console.log("Available models:");
    for (const m of MODELS) console.log(`  ${m}`);
    process.exit(0);
  }

  if (!values.model || !values.diff) {
    console.error("Usage: bun scripts/phase-0-test.ts --model <model-id> --diff <path-to-diff>");
    console.error("       bun scripts/phase-0-test.ts --list-models");
    process.exit(1);
  }

  return {
    model: values.model,
    diffPath: values.diff,
    title: values.title ?? "Untitled PR",
    temperature: Number.parseFloat(values.temperature ?? "0.2"),
    maxTokens: Number.parseInt(values["max-tokens"] ?? "4096", 10),
  };
}

function buildPrompt(
  templatePath: string,
  diff: string,
  meta: { title: string; fileCount: number; lineCount: number },
): string {
  const template = readFileSync(templatePath, "utf-8");
  return template
    .replace("{{repo_name}}", "aligo")
    .replace("{{pr_title}}", meta.title)
    .replace("{{file_count}}", String(meta.fileCount))
    .replace("{{lines_changed}}", String(meta.lineCount))
    .replace("{{diff}}", diff);
}

function countDiffStats(diff: string): { fileCount: number; lineCount: number } {
  const files = new Set<string>();
  let lineCount = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) {
      const match = line.match(/b\/(.+)$/);
      if (match?.[1]) files.add(match[1]);
    }
    if (
      (line.startsWith("+") && !line.startsWith("+++")) ||
      (line.startsWith("-") && !line.startsWith("---"))
    ) {
      lineCount++;
    }
  }
  return { fileCount: files.size, lineCount };
}

function shortModelName(model: string): string {
  const parts = model.split("/");
  return (parts[1] ?? parts[0] ?? model).replace(/[^a-zA-Z0-9-]/g, "-");
}

async function callOpenRouter(
  prompt: string,
  model: string,
  temperature: number,
  maxTokens: number,
) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("Error: OPENROUTER_API_KEY environment variable is not set");
    process.exit(1);
  }

  const startTime = performance.now();

  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      temperature,
    }),
  });

  const elapsed = performance.now() - startTime;

  if (!response.ok) {
    const body = await response.text();
    console.error(`OpenRouter error (${response.status}): ${body}`);
    process.exit(1);
  }

  const json = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    error?: { message?: string };
  };

  if (json.error) {
    console.error(`OpenRouter API error: ${json.error.message}`);
    process.exit(1);
  }

  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    console.error("Empty response from OpenRouter");
    process.exit(1);
  }

  return {
    content,
    elapsed: Math.round(elapsed),
    usage: json.usage ?? {},
  };
}

async function main() {
  const args = parseCliArgs();

  if (!existsSync(args.diffPath)) {
    console.error(`Diff file not found: ${args.diffPath}`);
    process.exit(1);
  }

  const diff = readFileSync(args.diffPath, "utf-8");
  const stats = countDiffStats(diff);
  const prompt = buildPrompt(PROMPT_PATH, diff, { title: args.title, ...stats });

  console.log(`Model:       ${args.model}`);
  console.log(`Diff:        ${args.diffPath} (${stats.fileCount} files, ${stats.lineCount} lines)`);
  console.log(`Temperature: ${args.temperature}`);
  console.log(`Max tokens:  ${args.maxTokens}`);
  console.log(`Prompt size: ${prompt.length} chars (~${Math.ceil(prompt.length / 4)} tokens)`);
  console.log("---");
  console.log("Calling OpenRouter...");

  const result = await callOpenRouter(prompt, args.model, args.temperature, args.maxTokens);

  console.log(`Done in ${result.elapsed}ms`);
  console.log(
    `Tokens: prompt=${result.usage.prompt_tokens ?? "?"}, completion=${result.usage.completion_tokens ?? "?"}, total=${result.usage.total_tokens ?? "?"}`,
  );

  // Save output
  mkdirSync(RESULTS_DIR, { recursive: true });
  const diffName = basename(args.diffPath, ".diff");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outName = `${shortModelName(args.model)}-${diffName}-${timestamp}.md`;
  const outPath = join(RESULTS_DIR, outName);

  const output = [
    `# Review: ${args.title}`,
    "",
    `**Model:** ${args.model}`,
    `**Diff:** ${args.diffPath}`,
    `**Files:** ${stats.fileCount} | **Lines:** ${stats.lineCount}`,
    `**Temperature:** ${args.temperature}`,
    `**Response time:** ${result.elapsed}ms`,
    `**Tokens:** prompt=${result.usage.prompt_tokens ?? "?"}, completion=${result.usage.completion_tokens ?? "?"}, total=${result.usage.total_tokens ?? "?"}`,
    `**Prompt version:** v1`,
    "",
    "---",
    "",
    result.content,
    "",
    "---",
    "",
    "## Scoring",
    "",
    "| Dimension | Score (1-5) | Notes |",
    "|-----------|-------------|-------|",
    "| Summary accuracy | /5 | |",
    "| File prioritization | /5 | |",
    "| Bug detection | /5 | |",
    "| False positive rate | /5 | |",
    "| Actionability | /5 | |",
    "",
    "**Overall useful?** (3+ on all dimensions): YES / NO",
    "",
    "**Notes:**",
    "",
  ].join("\n");

  writeFileSync(outPath, output);
  console.log(`\nSaved to: ${outPath}`);
}

main();
