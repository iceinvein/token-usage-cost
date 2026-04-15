import type { Database } from "bun:sqlite";
import { homedir } from "node:os";

import { parseCodexThreads, statCodexStateDb } from "./codex";
import { cursorWorkspaceExists, defaultCursorWorkspaceRoot, parseCursorUsageFile } from "./cursor";
import { emptyIngestStats, replaceFileEvents, replaceSourceEvents, shouldScanFile } from "./db";
import { parseClaudeUsageFile } from "./parser";
import type { IngestStats, ModelPricing } from "./types";

export async function ingestClaudeUsage(
  db: Database,
  root: string,
  pricingTable: Map<string, ModelPricing>,
): Promise<IngestStats> {
  const stats = emptyIngestStats();
  const glob = new Bun.Glob("**/*.jsonl");

  for await (const relativePath of glob.scan(root)) {
    const filePath = `${root}/${relativePath}`;
    const file = Bun.file(filePath);
    const stat = await file.stat();

    if (!shouldScanFile(db, filePath, stat.size, stat.mtimeMs)) {
      stats.filesSkipped += 1;
      continue;
    }

    const events = await parseClaudeUsageFile(filePath, root, pricingTable);
    const inserted = replaceFileEvents(db, filePath, stat.size, stat.mtimeMs, events);

    stats.filesScanned += 1;
    stats.eventsInserted += inserted;
  }

  return stats;
}

export async function ingestCodexUsage(
  db: Database,
  statePath = `${homedir()}/.codex/state_5.sqlite`,
  pricingTable: Map<string, ModelPricing>,
): Promise<IngestStats> {
  const stats = emptyIngestStats();
  const artifact = await statCodexStateDb(statePath);

  if (!shouldScanFile(db, statePath, artifact.size, artifact.mtimeMs)) {
    stats.filesSkipped += 1;
    return stats;
  }

  const events = parseCodexThreads(statePath, pricingTable);
  const inserted = replaceSourceEvents(
    db,
    "codex-cli",
    statePath,
    artifact.size,
    artifact.mtimeMs,
    events,
  );

  stats.filesScanned += 1;
  stats.eventsInserted += inserted;
  return stats;
}

export async function ingestCursorUsage(
  db: Database,
  root = defaultCursorWorkspaceRoot(),
  _pricingTable: Map<string, ModelPricing>,
): Promise<IngestStats> {
  const stats = emptyIngestStats();

  if (!(await cursorWorkspaceExists(root))) {
    return stats;
  }

  const glob = new Bun.Glob("*/state.vscdb");

  for await (const relativePath of glob.scan(root)) {
    const filePath = `${root}/${relativePath}`;
    try {
      const file = Bun.file(filePath);
      const fileStat = await file.stat();

      if (!shouldScanFile(db, filePath, fileStat.size, fileStat.mtimeMs)) {
        stats.filesSkipped += 1;
        continue;
      }

      const events = await parseCursorUsageFile(filePath);
      const inserted = replaceFileEvents(db, filePath, fileStat.size, fileStat.mtimeMs, events);

      stats.filesScanned += 1;
      stats.eventsInserted += inserted;
    } catch {
      stats.filesSkipped += 1;
    }
  }

  return stats;
}
