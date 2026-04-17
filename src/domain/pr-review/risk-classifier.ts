import type { FileDiff } from "./diff-parser";

export type RiskTier = "high" | "medium" | "low";

export interface RiskAssessment {
  readonly path: string;
  readonly tier: RiskTier;
  readonly reasons: readonly string[];
}

const HIGH_RISK_PATTERNS = [
  /^auth\//,
  /\/auth\//,
  /migration/i,
  /security/i,
  /\.sql$/,
  /payment/i,
  /secret/i,
  /crypt/i,
  /token/i,
  /password/i,
  /credential/i,
];

const LARGE_DIFF_THRESHOLD = 100;

export function classifyRisks(files: readonly FileDiff[]): readonly RiskAssessment[] {
  return files
    .filter((f) => !f.isBinary)
    .map((file) => assessFile(file))
    .sort((a, b) => tierOrder(a.tier) - tierOrder(b.tier));
}

function assessFile(file: FileDiff): RiskAssessment {
  const reasons: string[] = [];

  const matchedPattern = HIGH_RISK_PATTERNS.find((p) => p.test(file.path));
  if (matchedPattern) {
    reasons.push(`Path matches sensitive pattern: ${matchedPattern.source}`);
  }

  if (file.linesChanged > LARGE_DIFF_THRESHOLD) {
    reasons.push(
      `Large diff: ${file.linesChanged} lines changed (threshold: ${LARGE_DIFF_THRESHOLD})`,
    );
  }

  if (file.changeType === "added") {
    reasons.push("New file — needs scrutiny for missing tests and patterns");
  }

  if (file.changeType === "deleted") {
    reasons.push("Deleted file — check for broken references");
  }

  const tier = determineTier(reasons, file);
  return { path: file.path, tier, reasons };
}

function determineTier(reasons: readonly string[], file: FileDiff): RiskTier {
  if (reasons.length === 0) return "low";

  const hasSensitivePath = HIGH_RISK_PATTERNS.some((p) => p.test(file.path));
  const isLargeDiff = file.linesChanged > LARGE_DIFF_THRESHOLD;

  if (hasSensitivePath || isLargeDiff) return "high";
  return "medium";
}

function tierOrder(tier: RiskTier): number {
  switch (tier) {
    case "high":
      return 0;
    case "medium":
      return 1;
    case "low":
      return 2;
  }
}
