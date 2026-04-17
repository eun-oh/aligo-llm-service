import { describe, expect, test } from "bun:test";
import type { FileDiff } from "../src/domain/pr-review/diff-parser";
import { classifyRisks } from "../src/domain/pr-review/risk-classifier";

function makeFile(overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    path: "src/app.ts",
    changeType: "modified",
    hunks: ["@@ -1,3 +1,4 @@\n+const x = 1"],
    linesChanged: 10,
    isBinary: false,
    ...overrides,
  };
}

describe("classifyRisks", () => {
  test("flags files matching high-risk path patterns", () => {
    const files = [makeFile({ path: "src/auth/login.ts" })];
    const risks = classifyRisks(files);
    expect(risks).toHaveLength(1);
    expect(risks[0]!.tier).toBe("high");
    expect(risks[0]!.reasons.some((r) => r.includes("sensitive pattern"))).toBe(true);
  });

  test("flags large diffs as high risk", () => {
    const files = [makeFile({ linesChanged: 200 })];
    const risks = classifyRisks(files);
    expect(risks).toHaveLength(1);
    expect(risks[0]!.tier).toBe("high");
    expect(risks[0]!.reasons.some((r) => r.includes("Large diff"))).toBe(true);
  });

  test("flags new files as medium risk", () => {
    const files = [makeFile({ changeType: "added" })];
    const risks = classifyRisks(files);
    expect(risks).toHaveLength(1);
    expect(risks[0]!.tier).toBe("medium");
    expect(risks[0]!.reasons.some((r) => r.includes("New file"))).toBe(true);
  });

  test("classifies safe small changes as low risk", () => {
    const files = [makeFile({ path: "src/utils/format.ts", linesChanged: 5 })];
    const risks = classifyRisks(files);
    expect(risks).toHaveLength(1);
    expect(risks[0]!.tier).toBe("low");
    expect(risks[0]!.reasons).toHaveLength(0);
  });

  test("returns empty array for empty input", () => {
    expect(classifyRisks([])).toEqual([]);
  });

  test("skips binary files", () => {
    const files = [makeFile({ isBinary: true })];
    const risks = classifyRisks(files);
    expect(risks).toHaveLength(0);
  });

  test("sorts by risk tier (high first)", () => {
    const files = [
      makeFile({ path: "src/safe.ts", linesChanged: 2 }),
      makeFile({ path: "src/auth/critical.ts", linesChanged: 200 }),
      makeFile({ path: "src/new.ts", changeType: "added" }),
    ];
    const risks = classifyRisks(files);
    expect(risks[0]!.tier).toBe("high");
    expect(risks.at(-1)!.tier).toBe("low");
  });
});
