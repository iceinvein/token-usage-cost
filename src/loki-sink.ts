import { userInfo } from "node:os";

const ALLOWED_TOOLS = new Set<UsageEvent["source"]>(["claude-code", "codex-cli", "cursor"]);

import type { Database } from "bun:sqlite";

import {
  markEventsSynced,
  markUnsyncedBefore,
  readUnsyncedCount,
  readUnsyncedEvents,
} from "./db";
import type { UsageEvent } from "./types";

export type LokiConfig = {
  url: string;
  username?: string;
  password?: string;
  tenantId?: string;
  team: string;
  env: string;
  user: string;
  batchSize: number;
  maxAgeHours: number;
};

export type LokiPushResult = {
  pushed: number;
  remaining: number;
  batches: number;
  skippedTooOld: number;
  cutoff: string;
  dryRun: boolean;
};

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_AGE_HOURS = 168;

export function lokiConfigFromEnv(overrides: Partial<LokiConfig> = {}): LokiConfig | null {
  const url = overrides.url ?? process.env.LOKI_URL;
  if (!url) {
    return null;
  }

  const batchSize = Number(overrides.batchSize ?? process.env.LOKI_BATCH_SIZE ?? DEFAULT_BATCH_SIZE);
  const maxAgeHours = Number(
    overrides.maxAgeHours ?? process.env.LOKI_MAX_AGE_HOURS ?? DEFAULT_MAX_AGE_HOURS,
  );
  const team = overrides.team ?? process.env.LOKI_TEAM ?? "default";
  const env = overrides.env ?? process.env.LOKI_ENV ?? "prod";
  const user = overrides.user ?? process.env.LOKI_USER_LABEL ?? safeUsername();

  return {
    url: trimTrailingSlash(url),
    username: overrides.username ?? process.env.LOKI_USERNAME ?? undefined,
    password: overrides.password ?? process.env.LOKI_PASSWORD ?? process.env.LOKI_TOKEN ?? undefined,
    tenantId: overrides.tenantId ?? process.env.LOKI_TENANT_ID ?? undefined,
    team,
    env,
    user,
    batchSize: Number.isFinite(batchSize) && batchSize > 0 ? Math.floor(batchSize) : DEFAULT_BATCH_SIZE,
    maxAgeHours:
      Number.isFinite(maxAgeHours) && maxAgeHours > 0 ? maxAgeHours : DEFAULT_MAX_AGE_HOURS,
  };
}

function safeUsername(): string {
  try {
    return userInfo().username || "unknown";
  } catch {
    return "unknown";
  }
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function pushEndpoint(config: LokiConfig): string {
  return `${config.url}/loki/api/v1/push`;
}

function authHeader(config: LokiConfig): string | null {
  if (!config.username && !config.password) {
    return null;
  }
  const token = `${config.username ?? ""}:${config.password ?? ""}`;
  return `Basic ${Buffer.from(token).toString("base64")}`;
}

function isoToNanos(timestamp: string): string {
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid timestamp: ${timestamp}`);
  }
  return (BigInt(ms) * 1_000_000n).toString();
}

type LokiEntry = [string, string] | [string, string, Record<string, string>];

type LokiStream = {
  stream: Record<string, string>;
  values: LokiEntry[];
};

export function buildPushPayload(events: UsageEvent[], config: LokiConfig): { streams: LokiStream[] } {
  const grouped = new Map<string, LokiStream>();

  for (const event of events) {
    const labels: Record<string, string> = {
      service: "claude-cost",
      team: config.team,
      env: config.env,
      tool: ALLOWED_TOOLS.has(event.source) ? event.source : "unknown",
    };
    const key = JSON.stringify(labels);

    let stream = grouped.get(key);
    if (!stream) {
      stream = { stream: labels, values: [] };
      grouped.set(key, stream);
    }

    const line = JSON.stringify({
      user: config.user,
      session_id: event.sessionId,
      event_key: event.eventKey,
      message_id: event.messageId,
      model: event.model,
      speed: event.speed,
      input_tokens: event.inputTokens,
      output_tokens: event.outputTokens,
      cache_write_tokens: event.cacheWriteTokens,
      cache_read_tokens: event.cacheReadTokens,
      web_search_requests: event.webSearchRequests,
      total_tokens: event.totalTokens,
      cost_usd: event.estimatedCostUsd,
      ts: event.timestamp,
    });

    const metadata: Record<string, string> = {
      model: event.model,
      speed: event.speed,
      user: config.user,
    };

    stream.values.push([isoToNanos(event.timestamp), line, metadata]);
  }

  return { streams: [...grouped.values()] };
}

async function postBatch(events: UsageEvent[], config: LokiConfig): Promise<void> {
  const payload = buildPushPayload(events, config);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const auth = authHeader(config);
  if (auth) headers.Authorization = auth;
  if (config.tenantId) headers["X-Scope-OrgID"] = config.tenantId;

  const maxAttempts = 3;
  let attempt = 0;
  let lastError: unknown;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const response = await fetch(pushEndpoint(config), {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      if (response.status === 204 || response.status === 200) {
        return;
      }

      const body = await response.text().catch(() => "");
      const retriable = response.status === 429 || response.status >= 500;
      const error = new Error(`Loki push failed (${response.status}): ${body.slice(0, 500)}`);
      if (!retriable) {
        throw error;
      }
      lastError = error;
    } catch (error) {
      lastError = error;
    }

    if (attempt < maxAttempts) {
      const backoffMs = 2 ** (attempt - 1) * 1000;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Loki push failed");
}

export async function probeLoki(config: LokiConfig): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {};
  const auth = authHeader(config);
  if (auth) headers.Authorization = auth;
  if (config.tenantId) headers["X-Scope-OrgID"] = config.tenantId;

  const response = await fetch(`${config.url}/loki/api/v1/labels`, { headers });
  const body = await response.text().catch(() => "");
  return { status: response.status, body };
}

function authedHeaders(config: LokiConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  const auth = authHeader(config);
  if (auth) headers.Authorization = auth;
  if (config.tenantId) headers["X-Scope-OrgID"] = config.tenantId;
  return headers;
}

export type LokiDeleteRequest = {
  request_id: string;
  start_time: number;
  end_time: number;
  query: string;
  status: string;
  created_at?: number;
};

export async function requestLokiDelete(
  config: LokiConfig,
  options: { query: string; startSec: number; endSec: number },
): Promise<{ status: number; body: string }> {
  const params = new URLSearchParams({
    query: options.query,
    start: new Date(options.startSec * 1000).toISOString(),
    end: new Date(options.endSec * 1000).toISOString(),
  });
  const response = await fetch(`${config.url}/loki/api/v1/delete?${params.toString()}`, {
    method: "POST",
    headers: authedHeaders(config),
  });
  const body = await response.text().catch(() => "");
  return { status: response.status, body };
}

export async function listLokiDeleteRequests(
  config: LokiConfig,
): Promise<{ status: number; body: string; requests: LokiDeleteRequest[] }> {
  const response = await fetch(`${config.url}/loki/api/v1/delete`, {
    headers: authedHeaders(config),
  });
  const body = await response.text().catch(() => "");
  let requests: LokiDeleteRequest[] = [];
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) requests = parsed as LokiDeleteRequest[];
  } catch {
    // leave requests empty
  }
  return { status: response.status, body, requests };
}

export async function cancelLokiDelete(
  config: LokiConfig,
  requestId: string,
): Promise<{ status: number; body: string }> {
  const params = new URLSearchParams({ request_id: requestId });
  const response = await fetch(`${config.url}/loki/api/v1/delete?${params.toString()}`, {
    method: "DELETE",
    headers: authedHeaders(config),
  });
  const body = await response.text().catch(() => "");
  return { status: response.status, body };
}

export async function pushUnsyncedToLoki(
  db: Database,
  config: LokiConfig,
  options: { dryRun?: boolean } = {},
): Promise<LokiPushResult> {
  const dryRun = options.dryRun ?? false;
  const cutoffMs = Date.now() - config.maxAgeHours * 60 * 60 * 1000;
  const cutoff = new Date(cutoffMs).toISOString();

  const skippedTooOld = dryRun ? 0 : markUnsyncedBefore(db, cutoff, "claude-code");

  let pushed = 0;
  let batches = 0;

  while (true) {
    const events = readUnsyncedEvents(db, config.batchSize, cutoff, "claude-code");
    if (events.length === 0) {
      break;
    }

    if (dryRun) {
      batches += 1;
      pushed += events.length;
      if (batches === 1) {
        process.stdout.write(`${JSON.stringify(buildPushPayload(events, config), null, 2)}\n`);
      }
      break;
    }

    await postBatch(events, config);
    markEventsSynced(
      db,
      events.map((event) => event.eventKey),
    );
    pushed += events.length;
    batches += 1;
  }

  return {
    pushed,
    remaining: dryRun
      ? readUnsyncedCount(db, cutoff, "claude-code") - pushed
      : readUnsyncedCount(db, cutoff, "claude-code"),
    batches,
    skippedTooOld,
    cutoff,
    dryRun,
  };
}
