import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

type ClaudeUsageWindowId = "fiveHour" | "weeklyAllModels" | "weeklySonnet";

export type ClaudeUsageWindow = {
  id: ClaudeUsageWindowId;
  label: string;
  percentLeft: number;
  usedText?: string;
  totalText?: string;
  resetText?: string;
  detailText: string;
};

export type ClaudeUsageSnapshot = {
  status: "available" | "unavailable" | "error";
  fetchedAt: string;
  windows: ClaudeUsageWindow[];
  message?: string;
};

const EXPECT_SCRIPT = `
log_user 1
set timeout 40
spawn claude
expect {
  "Yes, I trust this folder" { send "\\r"; exp_continue }
  -re {❯|>} { }
  timeout { exit 11 }
}
sleep 1
send "/usage\\r"
expect {
  "Loading usage data" { }
  "Failed to load usage data" { }
  -re {[0-9]+% used} { }
  timeout { }
}
expect {
  "Failed to load usage data" { }
  -re {[0-9]+% used} { }
  timeout { }
}
sleep 1
send "\\033"
sleep 1
close
catch wait result
exit 0
`;

const execFileAsync = promisify(execFile);

export function defaultClaudeUsageSnapshotPath(): string {
  return join(homedir(), ".local", "share", "claude-cost", "claude-usage.json");
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B[@-_]/g, "");
}

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function labelForWindow(id: ClaudeUsageWindowId): string {
  switch (id) {
    case "fiveHour":
      return "5-hour";
    case "weeklyAllModels":
      return "Weekly";
    case "weeklySonnet":
      return "Weekly Sonnet";
  }
}

function inferWindowId(line: string): ClaudeUsageWindowId | null {
  if (/current session/i.test(line)) {
    return "fiveHour";
  }

  if (/current week \(all models\)/i.test(line)) {
    return "weeklyAllModels";
  }

  if (/current week \(sonnet only\)/i.test(line)) {
    return "weeklySonnet";
  }

  if (/\bweekly\b|\bweek\b/i.test(line)) {
    return "weeklyAllModels";
  }

  if (/\b5\s*[- ]?\s*h(?:our)?\b|\b5hr\b|\bsession\b/i.test(line)) {
    return "fiveHour";
  }

  return null;
}

function normalizeResetText(line: string): string {
  return line
    .replace(/(Current week|Esc to cancel).*$/i, "")
    .replace(/^resetsts/i, "Resets ")
    .replace(/^rese\s*s?/i, "Resets ")
    .replace(/^resets?/i, "Resets ")
    .replace(/^Resets\s*/i, "Resets ")
    .replace(/^Resets\s+ts\b/i, "Resets")
    .trim();
}

function parseUsageLines(output: string): ClaudeUsageSnapshot {
  const cleaned = stripAnsi(output);
  const lines = cleaned
    .split(/\r?\n/)
    .map(normalizeLine)
    .filter(Boolean);

  const fetchedAt = new Date().toISOString();

  const errorLine = lines.find((line) => /failed to load usage data/i.test(line));
  if (errorLine) {
    return {
      status: "error",
      fetchedAt,
      windows: [],
      message: errorLine,
    };
  }

  const uniqueLines = [...new Set(lines)];
  const windows: ClaudeUsageWindow[] = [];
  const collapsed = uniqueLines.join("\n");

  const blockPatterns: Array<{ id: ClaudeUsageWindowId; pattern: RegExp }> = [
    {
      id: "fiveHour",
      pattern: /Current\s+session[\s\S]{0,240}?(\d{1,3})%\s*used[\s\S]{0,120}?(Rese\s*s?[^\n\r]*|Resets?[^\n\r]*)?(?=\n(?:Current week|Esc to cancel)|$)/i,
    },
    {
      id: "weeklyAllModels",
      pattern: /Current\s+week\s+\(all\s+models\)[\s\S]{0,240}?(\d{1,3})%\s*used[\s\S]{0,120}?(Rese\s*s?[^\n\r]*|Resets?[^\n\r]*)?(?=\n(?:Current week|Esc to cancel)|$)/i,
    },
    {
      id: "weeklySonnet",
      pattern: /Current\s+week\s+\(Sonnet\s+only\)[\s\S]{0,240}?(\d{1,3})%\s*used[\s\S]{0,120}?(Rese\s*s?[^\n\r]*|Resets?[^\n\r]*)?(?=\n(?:Current week|Esc to cancel)|$)/i,
    },
  ];

  for (const { id, pattern } of blockPatterns) {
    const match = collapsed.match(pattern);
    if (!match) {
      continue;
    }

    const percentLeft = Math.max(0, 100 - Number.parseInt(match[1]!, 10));
    const resetText = match[2] ? normalizeResetText(normalizeLine(match[2])) : undefined;

    windows.push({
      id,
      label: labelForWindow(id),
      percentLeft,
      resetText,
      detailText: `${100 - percentLeft}% used`,
    });
  }

  if (windows.length === 0) {
    for (let index = 0; index < uniqueLines.length; index += 1) {
      const line = uniqueLines[index]!;
      const id = inferWindowId(line);
      if (!id) {
        continue;
      }

      const detailLines = uniqueLines.slice(index + 1, index + 5);
      const percentUsedLine = detailLines.find((candidate) => /\b\d{1,3}%\s*used\b/i.test(candidate));
      const percentLeftLine = detailLines.find((candidate) => /\b\d{1,3}%\s+left\b/i.test(candidate));
      const resetLine = detailLines.find((candidate) => /^rese\s*s?|^resets?/i.test(candidate));

      const percentUsedMatch = percentUsedLine?.match(/(\d{1,3})%\s*used/i);
      const percentLeftMatch = percentLeftLine?.match(/(\d{1,3})%\s+left/i);
      const percentLeft = percentLeftMatch
        ? Number.parseInt(percentLeftMatch[1]!, 10)
        : percentUsedMatch
          ? Math.max(0, 100 - Number.parseInt(percentUsedMatch[1]!, 10))
          : undefined;

      if (typeof percentLeft !== "number") {
        continue;
      }

      windows.push({
        id,
        label: labelForWindow(id),
        percentLeft,
        resetText: resetLine ? normalizeResetText(resetLine) : undefined,
        detailText: percentUsedLine ?? percentLeftLine ?? line,
      });
    }
  }

  if (windows.length > 0) {
    return {
      status: "available",
      fetchedAt,
      windows,
    };
  }

  return {
    status: "unavailable",
    fetchedAt,
    windows: [],
    message: "Claude CLI did not return recognizable /usage data.",
  };
}

function isClaudeUsageWindow(value: unknown): value is ClaudeUsageWindow {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<ClaudeUsageWindow>;
  return typeof candidate.id === "string"
    && typeof candidate.label === "string"
    && typeof candidate.percentLeft === "number"
    && typeof candidate.detailText === "string"
    && (candidate.resetText === undefined || typeof candidate.resetText === "string");
}

function isClaudeUsageSnapshot(value: unknown): value is ClaudeUsageSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<ClaudeUsageSnapshot>;
  return (candidate.status === "available" || candidate.status === "unavailable" || candidate.status === "error")
    && typeof candidate.fetchedAt === "string"
    && Array.isArray(candidate.windows)
    && candidate.windows.every(isClaudeUsageWindow)
    && (candidate.message === undefined || typeof candidate.message === "string");
}

export async function readClaudeUsageSnapshot(
  snapshotPath = defaultClaudeUsageSnapshotPath(),
): Promise<ClaudeUsageSnapshot | null> {
  try {
    const raw = await readFile(snapshotPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isClaudeUsageSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function persistClaudeUsageSnapshot(
  snapshot: ClaudeUsageSnapshot,
  snapshotPath = defaultClaudeUsageSnapshotPath(),
): Promise<void> {
  await mkdir(dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

export async function fetchClaudeUsageSnapshot(): Promise<ClaudeUsageSnapshot> {
  if (!Bun.which("expect") || !Bun.which("claude")) {
    return {
      status: "unavailable",
      fetchedAt: new Date().toISOString(),
      windows: [],
      message: "Claude CLI or expect is not installed.",
    };
  }

  let stdoutText = "";
  let stderrText = "";
  let exitCode = 0;

  try {
    const result = await execFileAsync("expect", ["-c", EXPECT_SCRIPT], {
      timeout: 35_000,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        TERM: process.env.TERM ?? "xterm-256color",
      },
    });
    stdoutText = result.stdout;
    stderrText = result.stderr;
  } catch (error) {
    const execError = error as Error & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    stdoutText = execError.stdout ?? "";
    stderrText = execError.stderr ?? "";
    exitCode = typeof execError.code === "number" ? execError.code : 1;
  }

  const combined = `${stdoutText}\n${stderrText}`.trim();
  const snapshot = parseUsageLines(combined);

  if (snapshot.status !== "available" && exitCode !== 0 && !snapshot.message) {
    return {
      ...snapshot,
      message: `Claude /usage command exited with status ${exitCode}.`,
    };
  }

  return snapshot;
}

export async function refreshPersistedClaudeUsageSnapshot(
  snapshotPath = defaultClaudeUsageSnapshotPath(),
): Promise<ClaudeUsageSnapshot> {
  const snapshot = await fetchClaudeUsageSnapshot();
  await persistClaudeUsageSnapshot(snapshot, snapshotPath);
  return snapshot;
}
