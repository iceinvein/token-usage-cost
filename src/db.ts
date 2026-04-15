import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { Database } from "bun:sqlite";

import type { IngestStats, UsageEvent } from "./types";

export function defaultDatabasePath(): string {
  return join(homedir(), ".local", "share", "claude-cost", "usage.sqlite");
}

export async function ensureDatabase(dbPath = defaultDatabasePath()): Promise<Database> {
  await mkdir(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath, { create: true });
  db.exec(`PRAGMA busy_timeout = 5000;`);
  try {
    db.exec(`PRAGMA journal_mode = WAL;`);
  } catch {
    // Another process may already hold the database during recovery.
  }
  db.exec(`

    CREATE TABLE IF NOT EXISTS source_files (
      file_path TEXT PRIMARY KEY,
      file_size INTEGER NOT NULL,
      file_mtime_ms INTEGER NOT NULL,
      scanned_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS usage_events (
      event_key TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      project TEXT NOT NULL,
      session_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      message_id TEXT,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      web_search_requests INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      token_breakdown_known INTEGER NOT NULL DEFAULT 1,
      speed TEXT NOT NULL,
      estimated_cost_usd REAL NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_usage_events_timestamp ON usage_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_events_project ON usage_events(project);
    CREATE INDEX IF NOT EXISTS idx_usage_events_model ON usage_events(model);
  `);

  for (const statement of [
    "ALTER TABLE usage_events ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE usage_events ADD COLUMN token_breakdown_known INTEGER NOT NULL DEFAULT 1",
  ]) {
    try {
      db.exec(statement);
    } catch {
      // Column already exists.
    }
  }

  return db;
}

export function shouldScanFile(
  db: Database,
  filePath: string,
  fileSize: number,
  fileMtimeMs: number,
): boolean {
  const row = db
    .query<{ file_size: number; file_mtime_ms: number }, [string]>(
      "SELECT file_size, file_mtime_ms FROM source_files WHERE file_path = ?",
    )
    .get(filePath);

  if (!row) {
    return true;
  }

  return row.file_size !== fileSize || row.file_mtime_ms !== fileMtimeMs;
}

export function replaceFileEvents(
  db: Database,
  filePath: string,
  fileSize: number,
  fileMtimeMs: number,
  events: UsageEvent[],
): number {
  const deleteEvents = db.query("DELETE FROM usage_events WHERE file_path = ?");
  const upsertFile = db.query(`
    INSERT INTO source_files (file_path, file_size, file_mtime_ms, scanned_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      file_size = excluded.file_size,
      file_mtime_ms = excluded.file_mtime_ms,
      scanned_at = excluded.scanned_at
  `);
  const insertEvent = db.query(`
    INSERT OR REPLACE INTO usage_events (
      event_key,
      source,
      project,
      session_id,
      file_path,
      timestamp,
      message_id,
      model,
      input_tokens,
      output_tokens,
      cache_write_tokens,
      cache_read_tokens,
      web_search_requests,
      total_tokens,
      token_breakdown_known,
      speed,
      estimated_cost_usd
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction(() => {
    deleteEvents.run(filePath);

    for (const event of events) {
      insertEvent.run(
        event.eventKey,
        event.source,
        event.project,
        event.sessionId,
        event.filePath,
        event.timestamp,
        event.messageId ?? null,
        event.model,
        event.inputTokens,
        event.outputTokens,
        event.cacheWriteTokens,
        event.cacheReadTokens,
        event.webSearchRequests,
        event.totalTokens,
        event.tokenBreakdownKnown ? 1 : 0,
        event.speed,
        event.estimatedCostUsd,
      );
    }

    upsertFile.run(filePath, fileSize, fileMtimeMs, new Date().toISOString());
  });

  transaction();
  return events.length;
}

export function replaceSourceEvents(
  db: Database,
  source: UsageEvent["source"],
  artifactPath: string,
  fileSize: number,
  fileMtimeMs: number,
  events: UsageEvent[],
): number {
  const deleteEvents = db.query("DELETE FROM usage_events WHERE source = ?");
  const upsertFile = db.query(`
    INSERT INTO source_files (file_path, file_size, file_mtime_ms, scanned_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      file_size = excluded.file_size,
      file_mtime_ms = excluded.file_mtime_ms,
      scanned_at = excluded.scanned_at
  `);
  const insertEvent = db.query(`
    INSERT OR REPLACE INTO usage_events (
      event_key,
      source,
      project,
      session_id,
      file_path,
      timestamp,
      message_id,
      model,
      input_tokens,
      output_tokens,
      cache_write_tokens,
      cache_read_tokens,
      web_search_requests,
      total_tokens,
      token_breakdown_known,
      speed,
      estimated_cost_usd
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction(() => {
    deleteEvents.run(source);

    for (const event of events) {
      insertEvent.run(
        event.eventKey,
        event.source,
        event.project,
        event.sessionId,
        event.filePath,
        event.timestamp,
        event.messageId ?? null,
        event.model,
        event.inputTokens,
        event.outputTokens,
        event.cacheWriteTokens,
        event.cacheReadTokens,
        event.webSearchRequests,
        event.totalTokens,
        event.tokenBreakdownKnown ? 1 : 0,
        event.speed,
        event.estimatedCostUsd,
      );
    }

    upsertFile.run(artifactPath, fileSize, fileMtimeMs, new Date().toISOString());
  });

  transaction();
  return events.length;
}

export function readEventsForDate(db: Database, date: string): UsageEvent[] {
  return readEventsForRange(db, `${date}T00:00:00`, `${date}T23:59:59.999`);
}

export function readEventsForRange(
  db: Database,
  startTimestamp: string,
  endTimestamp: string,
): UsageEvent[] {
  const rows = db
    .query<
      {
        source: UsageEvent["source"];
        project: string;
        session_id: string;
        file_path: string;
        event_key: string;
        timestamp: string;
        message_id: string | null;
        model: string;
        input_tokens: number;
        output_tokens: number;
        cache_write_tokens: number;
        cache_read_tokens: number;
        web_search_requests: number;
        total_tokens: number;
        token_breakdown_known: number;
        speed: UsageEvent["speed"];
        estimated_cost_usd: number;
      },
      [string, string]
    >(
      `SELECT
        source,
        project,
        session_id,
        file_path,
        event_key,
        timestamp,
        message_id,
        model,
        input_tokens,
        output_tokens,
        cache_write_tokens,
        cache_read_tokens,
        web_search_requests,
        total_tokens,
        token_breakdown_known,
        speed,
        estimated_cost_usd
      FROM usage_events
      WHERE timestamp >= ? AND timestamp < ?
      ORDER BY timestamp ASC`,
    )
    .all(startTimestamp, endTimestamp);

  return rows.map((row) => ({
    source: row.source,
    project: row.project,
    sessionId: row.session_id,
    filePath: row.file_path,
    eventKey: row.event_key,
    timestamp: row.timestamp,
    messageId: row.message_id ?? undefined,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    cacheReadTokens: row.cache_read_tokens,
    webSearchRequests: row.web_search_requests,
    totalTokens: row.total_tokens ?? 0,
    tokenBreakdownKnown: Boolean(row.token_breakdown_known ?? 1),
    speed: row.speed,
    estimatedCostUsd: row.estimated_cost_usd,
  }));
}

export function readEventCount(db: Database): number {
  const row = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM usage_events").get();
  return row?.count ?? 0;
}

export function emptyIngestStats(): IngestStats {
  return { filesScanned: 0, filesSkipped: 0, eventsInserted: 0 };
}
