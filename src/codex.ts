import { stat } from "node:fs/promises";

import { Database } from "bun:sqlite";

import { estimateAggregateTokenCostUsd } from "./pricing";
import type { ModelPricing, UsageEvent } from "./types";

type CodexThreadRow = {
  id: string;
  cwd: string;
  model: string | null;
  created_at: number;
  updated_at: number;
  tokens_used: number;
  source: string;
  archived: number;
};

function toIso(tsSeconds: number): string {
  return new Date(tsSeconds * 1000).toISOString();
}

export async function statCodexStateDb(statePath: string): Promise<{ size: number; mtimeMs: number }> {
  const info = await stat(statePath);
  return { size: info.size, mtimeMs: info.mtimeMs };
}

export function parseCodexThreads(
  statePath: string,
  pricingTable: Map<string, ModelPricing>,
): UsageEvent[] {
  const db = new Database(statePath, { readonly: true });

  try {
    const rows = db
      .query<CodexThreadRow, []>(
        `SELECT id, cwd, model, created_at, updated_at, tokens_used, source, archived
         FROM threads
         WHERE source IN ('cli', 'exec')`,
      )
      .all();

    return rows
      .filter((row) => !row.archived)
      .map((row) => {
        const model = row.model ?? "unknown-model";
        const totalTokens = row.tokens_used ?? 0;

        return {
          source: "codex-cli" as const,
          project: row.cwd || "/",
          sessionId: row.id,
          filePath: statePath,
          eventKey: `codex:${row.id}:${row.updated_at}:${totalTokens}`,
          timestamp: toIso(row.updated_at || row.created_at),
          messageId: row.id,
          model,
          inputTokens: 0,
          outputTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          webSearchRequests: 0,
          totalTokens,
          tokenBreakdownKnown: false,
          speed: "standard" as const,
          estimatedCostUsd: estimateAggregateTokenCostUsd(model, totalTokens, pricingTable),
        };
      })
      .filter((event) => event.totalTokens > 0)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  } finally {
    db.close();
  }
}
