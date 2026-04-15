import { homedir } from "node:os";
import { relative, sep } from "node:path";

import { z } from "zod";

import { estimateCostUsd } from "./pricing";
import type { ModelPricing, UsageEvent } from "./types";

const assistantEntrySchema = z.object({
  type: z.literal("assistant"),
  timestamp: z.string().optional(),
  message: z.object({
    id: z.string().optional(),
    model: z.string(),
    usage: z.object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
      speed: z.enum(["standard", "fast"]).optional(),
      server_tool_use: z
        .object({
          web_search_requests: z.number().optional(),
        })
        .optional(),
    }),
  }),
});

function defaultRoot(): string {
  return `${homedir()}/.claude/projects`;
}

function getProjectName(root: string, filePath: string): string {
  const rel = relative(root, filePath);
  const parts = rel.split(sep);
  return parts[0] || "unknown-project";
}

function getSessionId(filePath: string): string {
  const lastSegment = filePath.split(sep).at(-1) ?? "unknown";
  return lastSegment.replace(/\.jsonl$/, "");
}

function dedupeKey(event: Omit<UsageEvent, "estimatedCostUsd" | "eventKey">): string {
  return [
    event.messageId ?? "",
    event.timestamp,
    event.model,
    event.sessionId,
    event.inputTokens,
    event.outputTokens,
    event.cacheWriteTokens,
    event.cacheReadTokens,
    event.webSearchRequests,
  ].join("|");
}

export async function parseClaudeUsageFile(
  filePath: string,
  root: string,
  pricingTable: Map<string, ModelPricing>,
): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const seen = new Set<string>();
  const file = Bun.file(filePath);
  const text = await file.text();
  const project = getProjectName(root, filePath);
  const sessionId = getSessionId(filePath);

  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }

    const parsed = assistantEntrySchema.safeParse(raw);
    if (!parsed.success) {
      continue;
    }

    const entry = parsed.data;
    const usage = entry.message.usage;
    const baseEvent = {
      source: "claude-code" as const,
      project,
      sessionId,
      filePath,
      timestamp: entry.timestamp ?? "",
      messageId: entry.message.id,
      model: entry.message.model,
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      webSearchRequests: usage.server_tool_use?.web_search_requests ?? 0,
      totalTokens:
        (usage.input_tokens ?? 0) +
        (usage.output_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0),
      tokenBreakdownKnown: true,
      speed: usage.speed ?? "standard",
    };

    const key = baseEvent.messageId || dedupeKey(baseEvent);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    events.push({
      ...baseEvent,
      eventKey: key,
      estimatedCostUsd: estimateCostUsd(baseEvent.model, baseEvent, pricingTable),
    });
  }

  return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export async function parseClaudeUsage(
  root = defaultRoot(),
  pricingTable: Map<string, ModelPricing>,
): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const glob = new Bun.Glob("**/*.jsonl");

  for await (const relativePath of glob.scan(root)) {
    const filePath = `${root}/${relativePath}`;
    const parsed = await parseClaudeUsageFile(filePath, root, pricingTable);
    events.push(...parsed);
  }

  return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
