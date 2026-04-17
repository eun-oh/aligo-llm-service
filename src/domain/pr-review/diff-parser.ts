export interface FileDiff {
  readonly path: string;
  readonly changeType: "added" | "modified" | "deleted" | "renamed";
  readonly hunks: readonly string[];
  readonly linesChanged: number;
  readonly isBinary: boolean;
}

export interface DiffChunk {
  readonly path: string;
  readonly content: string;
  readonly tokenEstimate: number;
  readonly changeType: FileDiff["changeType"];
}

const MAX_TOKENS_PER_CHUNK = 4000;
const CHARS_PER_TOKEN = 4;

export function parseDiff(rawDiff: string): readonly FileDiff[] {
  if (!rawDiff.trim()) return [];

  const files: FileDiff[] = [];
  const fileSections = rawDiff.split(/^diff --git /m).filter(Boolean);

  for (const section of fileSections) {
    const lines = section.split("\n");
    const headerLine = lines[0] ?? "";

    const pathMatch = headerLine.match(/b\/(.+)$/);
    const path = pathMatch?.[1];
    if (!path) continue;

    const isBinary = section.includes("Binary files") || section.includes("GIT binary patch");
    if (isBinary) {
      files.push({ path, changeType: "modified", hunks: [], linesChanged: 0, isBinary: true });
      continue;
    }

    const changeType = detectChangeType(section);
    const hunks = extractHunks(section);
    const linesChanged = countChangedLines(hunks);

    files.push({ path, changeType, hunks, linesChanged, isBinary: false });
  }

  return files;
}

export function chunkDiffs(
  files: readonly FileDiff[],
  maxTokens: number = MAX_TOKENS_PER_CHUNK,
): readonly DiffChunk[] {
  const chunks: DiffChunk[] = [];

  for (const file of files) {
    if (file.isBinary) continue;

    const fullContent = file.hunks.join("\n");
    const tokenEstimate = estimateTokens(fullContent);

    if (tokenEstimate <= maxTokens) {
      chunks.push({
        path: file.path,
        content: fullContent,
        tokenEstimate,
        changeType: file.changeType,
      });
    } else {
      for (const hunk of file.hunks) {
        const hunkTokens = estimateTokens(hunk);
        chunks.push({
          path: file.path,
          content: hunk,
          tokenEstimate: hunkTokens,
          changeType: file.changeType,
        });
      }
    }
  }

  return chunks;
}

function detectChangeType(section: string): FileDiff["changeType"] {
  if (section.includes("new file mode")) return "added";
  if (section.includes("deleted file mode")) return "deleted";
  if (section.includes("rename from")) return "renamed";
  return "modified";
}

function extractHunks(section: string): string[] {
  const hunks: string[] = [];
  const hunkStarts = [...section.matchAll(/^@@[^@]+@@/gm)];

  for (let i = 0; i < hunkStarts.length; i++) {
    const match = hunkStarts[i];
    if (!match || match.index === undefined) continue;
    const start = match.index;
    const nextMatch = hunkStarts[i + 1];
    const end = nextMatch?.index ?? section.length;
    hunks.push(section.slice(start, end).trim());
  }

  return hunks;
}

function countChangedLines(hunks: readonly string[]): number {
  let count = 0;
  for (const hunk of hunks) {
    for (const line of hunk.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) count++;
      if (line.startsWith("-") && !line.startsWith("---")) count++;
    }
  }
  return count;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
