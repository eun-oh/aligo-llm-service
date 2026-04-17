import { describe, expect, test } from "bun:test";
import { chunkDiffs, parseDiff } from "../src/domain/pr-review/diff-parser";

const SAMPLE_DIFF = `diff --git a/src/auth.ts b/src/auth.ts
index abc1234..def5678 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,6 +10,8 @@ export function login(user: string) {
   const token = createToken(user)
+  validateInput(user)
+  logAccess(user)
   return token
 }
@@ -20,3 +22,4 @@ export function logout() {
   clearSession()
+  auditLog("logout")
 }
diff --git a/src/utils.ts b/src/utils.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/utils.ts
@@ -0,0 +1,5 @@
+export function validateInput(input: string) {
+  if (!input) throw new Error("empty input")
+  return input.trim()
+}
+`;

describe("parseDiff", () => {
  test("parses a normal diff with multiple files", () => {
    const files = parseDiff(SAMPLE_DIFF);
    expect(files).toHaveLength(2);
    expect(files[0]!.path).toBe("src/auth.ts");
    expect(files[0]!.changeType).toBe("modified");
    expect(files[0]!.hunks).toHaveLength(2);
    expect(files[0]!.linesChanged).toBeGreaterThan(0);
    expect(files[0]!.isBinary).toBe(false);

    expect(files[1]!.path).toBe("src/utils.ts");
    expect(files[1]!.changeType).toBe("added");
  });

  test("returns empty array for empty diff", () => {
    expect(parseDiff("")).toEqual([]);
    expect(parseDiff("   ")).toEqual([]);
  });

  test("handles binary files", () => {
    const binaryDiff = `diff --git a/image.png b/image.png
Binary files /dev/null and b/image.png differ
`;
    const files = parseDiff(binaryDiff);
    expect(files).toHaveLength(1);
    expect(files[0]!.isBinary).toBe(true);
    expect(files[0]!.hunks).toHaveLength(0);
    expect(files[0]!.linesChanged).toBe(0);
  });

  test("detects deleted files", () => {
    const deletedDiff = `diff --git a/old.ts b/old.ts
deleted file mode 100644
index abc1234..0000000
--- a/old.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export const x = 1
-export const y = 2
-export const z = 3
`;
    const files = parseDiff(deletedDiff);
    expect(files).toHaveLength(1);
    expect(files[0]!.changeType).toBe("deleted");
    expect(files[0]!.linesChanged).toBe(3);
  });

  test("detects renamed files", () => {
    const renamedDiff = `diff --git a/old-name.ts b/new-name.ts
rename from old-name.ts
rename to new-name.ts
index abc1234..def5678 100644
--- a/old-name.ts
+++ b/new-name.ts
@@ -1,3 +1,3 @@
-export const name = "old"
+export const name = "new"
`;
    const files = parseDiff(renamedDiff);
    expect(files).toHaveLength(1);
    expect(files[0]!.changeType).toBe("renamed");
  });
});

describe("chunkDiffs", () => {
  test("returns chunks for each non-binary file", () => {
    const files = parseDiff(SAMPLE_DIFF);
    const chunks = chunkDiffs(files);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.tokenEstimate > 0)).toBe(true);
    expect(chunks.every((c) => c.path.length > 0)).toBe(true);
  });

  test("skips binary files", () => {
    const binaryDiff = `diff --git a/image.png b/image.png
Binary files /dev/null and b/image.png differ
`;
    const files = parseDiff(binaryDiff);
    const chunks = chunkDiffs(files);
    expect(chunks).toHaveLength(0);
  });

  test("splits large files at hunk boundaries", () => {
    const files = parseDiff(SAMPLE_DIFF);
    // Force a very small max to trigger splitting
    const chunks = chunkDiffs(files, 10);
    // auth.ts has 2 hunks, so it should split into 2 chunks
    const authChunks = chunks.filter((c) => c.path === "src/auth.ts");
    expect(authChunks.length).toBe(2);
  });
});
