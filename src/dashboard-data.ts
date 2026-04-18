import { summarizeDay, summarizeModelsByDay, summarizeProjects, summarizeRange } from "./aggregate";
import { defaultDatabasePath, ensureDatabase, readClaudeUsageSamples, readEventsForRange } from "./db";
import { ingestClaudeUsage, ingestCodexUsage, ingestCursorUsage } from "./ingest";
import { loadPricing } from "./pricing";
import type {
  ClaudeFiveHourEstimate,
  ClaudeFiveHourEstimateHistory,
  ClaudeMonthCapacityEstimate,
  ClaudeUsageSample,
  ClaudeWindowCapacityEstimate,
} from "./types";

export type DashboardSourceFilter = "all" | "claude-code" | "codex-cli" | "cursor";

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function todayInLocalTimezone(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatLocalTimestamp(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const timezone = Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value ?? "";

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}${timezone ? ` ${timezone}` : ""}`;
}

export type DashboardData = {
  date: string;
  weekStart: string;
  monthBegin: string;
  today: ReturnType<typeof summarizeDay>;
  week: ReturnType<typeof summarizeRange>;
  month: ReturnType<typeof summarizeRange>;
  todayProjects: ReturnType<typeof summarizeProjects>;
  monthProjects: ReturnType<typeof summarizeProjects>;
  todayModels: ReturnType<typeof summarizeDay>["byModel"];
  monthModels: ReturnType<typeof summarizeRange>["byModel"];
  dailyRows: Array<ReturnType<typeof summarizeDay>>;
  modelRows: ReturnType<typeof summarizeModelsByDay>;
  claudeFiveHourEstimate: ClaudeFiveHourEstimate | null;
  claudeFiveHourHistory: ClaudeFiveHourEstimateHistory;
  claudeWeeklyEstimate: ClaudeWindowCapacityEstimate | null;
  claudeMonthEstimate: ClaudeMonthCapacityEstimate | null;
};

async function safeIngest<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch {
    // Transient failures (e.g. Codex/Cursor DBs locked by their owning app) must
    // not take down the dashboard. We rely on previously ingested data instead.
    return null;
  }
}

function subtractHours(timestamp: string, hours: number): string {
  const value = new Date(timestamp);
  value.setHours(value.getHours() - hours);
  return value.toISOString().slice(0, 19);
}

function subtractDays(timestamp: string, days: number): string {
  const value = new Date(timestamp);
  value.setDate(value.getDate() - days);
  return value.toISOString().slice(0, 19);
}

function buildClaudeWindowEstimate(
  samples: ClaudeUsageSample[],
  events: ReturnType<typeof readEventsForRange>,
  windowKind: ClaudeUsageSample["windowKind"],
  windowStartAtForSample: (sample: ClaudeUsageSample) => string,
): ClaudeWindowCapacityEstimate | null {
  const latestSample = [...samples]
    .filter((sample) => sample.windowKind === windowKind && sample.resetAt && sample.percentUsed > 0)
    .sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt))
    .at(-1);

  if (!latestSample?.resetAt) {
    return null;
  }

  const windowStartAt = windowStartAtForSample(latestSample);
  const observedEvents = events.filter((event) =>
    event.source === "claude-code"
    && event.timestamp >= windowStartAt
    && event.timestamp <= latestSample.fetchedAt,
  );
  const observedTokens = observedEvents.reduce((sum, event) => sum + event.totalTokens, 0);
  const observedCostUsd = observedEvents.reduce((sum, event) => sum + event.estimatedCostUsd, 0);
  const observedEventCount = observedEvents.length;

  if (latestSample.percentUsed <= 0) {
    return null;
  }

  const estimatedFullWindowTokens = Math.round((observedTokens / latestSample.percentUsed) * 100);
  const estimatedFullWindowCostUsd = observedCostUsd / latestSample.percentUsed * 100;
  const estimatedRemainingTokens = Math.max(0, estimatedFullWindowTokens - observedTokens);
  const estimatedRemainingCostUsd = Math.max(0, estimatedFullWindowCostUsd - observedCostUsd);

  return {
    fetchedAt: latestSample.fetchedAt,
    resetAt: latestSample.resetAt,
    windowStartAt,
    percentLeft: latestSample.percentLeft,
    percentUsed: latestSample.percentUsed,
    observedTokens,
    observedCostUsd,
    observedEvents: observedEventCount,
    estimatedFullWindowTokens,
    estimatedFullWindowCostUsd,
    estimatedRemainingTokens,
    estimatedRemainingCostUsd,
  };
}

function buildClaudeFiveHourEstimate(
  samples: ClaudeUsageSample[],
  events: ReturnType<typeof readEventsForRange>,
): ClaudeFiveHourEstimate | null {
  const estimate = buildClaudeWindowEstimate(samples, events, "fiveHour", (sample) => subtractHours(sample.resetAt!, 5));
  if (!estimate) {
    return null;
  }

  return {
    ...estimate,
    resetAt: roundToNearestHour(estimate.resetAt),
  };
}

function buildClaudeWeeklyEstimate(
  samples: ClaudeUsageSample[],
  events: ReturnType<typeof readEventsForRange>,
): ClaudeWindowCapacityEstimate | null {
  return buildClaudeWindowEstimate(samples, events, "weeklyAllModels", (sample) => subtractDays(sample.resetAt!, 7));
}

function buildClaudeMonthEstimate(
  weeklyEstimate: ClaudeWindowCapacityEstimate | null,
  month: ReturnType<typeof summarizeRange>,
  date: string,
): ClaudeMonthCapacityEstimate | null {
  if (!weeklyEstimate) {
    return null;
  }

  const elapsedMonthDays = Math.max(1, Number.parseInt(date.slice(8, 10), 10) || 1);
  const daysInMonth = new Date(
    Number.parseInt(date.slice(0, 4), 10),
    Number.parseInt(date.slice(5, 7), 10),
    0,
  ).getDate();
  const estimatedFullMonthTokens = Math.round((weeklyEstimate.estimatedFullWindowTokens / 7) * daysInMonth);
  const estimatedFullMonthCostUsd = (weeklyEstimate.estimatedFullWindowCostUsd / 7) * daysInMonth;

  return {
    basedOnLabel: "weekly capacity pace",
    estimatedFullMonthTokens,
    estimatedFullMonthCostUsd,
    estimatedRemainingMonthTokens: Math.max(0, estimatedFullMonthTokens - month.totalTokens),
    estimatedRemainingMonthCostUsd: Math.max(0, estimatedFullMonthCostUsd - month.estimatedCostUsd),
    currentMonthTokens: month.totalTokens,
    currentMonthCostUsd: month.estimatedCostUsd,
    elapsedMonthDays,
    daysInMonth,
  };
}

function roundToNearestHour(timestamp: string): string {
  const date = new Date(timestamp);
  if (date.getMinutes() >= 30) {
    date.setHours(date.getHours() + 1);
  }
  date.setMinutes(0, 0, 0);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:00:00`;
}

function buildClaudeFiveHourEstimateHistory(
  samples: ClaudeUsageSample[],
  events: ReturnType<typeof readEventsForRange>,
  limit = 6,
): ClaudeFiveHourEstimateHistory {
  const latestSamplesByReset = new Map<string, ClaudeUsageSample>();

  for (const sample of samples
    .filter((candidate) => candidate.windowKind === "fiveHour" && candidate.resetAt && candidate.percentUsed > 0)
    .sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt))) {
    const key = roundToNearestHour(sample.resetAt!);
    latestSamplesByReset.set(key, sample);
  }

  return [...latestSamplesByReset.values()]
    .sort((a, b) => b.resetAt!.localeCompare(a.resetAt!))
    .slice(0, limit)
    .map((sample) => buildClaudeFiveHourEstimate([sample], events))
    .filter((estimate): estimate is ClaudeFiveHourEstimate => estimate !== null);
}

export async function loadClaudeFiveHourEstimate(dbPath = defaultDatabasePath()): Promise<ClaudeFiveHourEstimate | null> {
  const db = await ensureDatabase(dbPath);
  try {
    const samples = readClaudeUsageSamples(db, "fiveHour");
    const latestSample = [...samples]
      .filter((sample) => sample.resetAt)
      .sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt))
      .at(-1);
    if (!latestSample?.resetAt) {
      return null;
    }

    const windowStartAt = subtractHours(latestSample.resetAt, 5);
    const events = readEventsForRange(db, windowStartAt, addDays(todayInLocalTimezone(), 1) + "T00:00:00");
    return buildClaudeFiveHourEstimate(samples, events);
  } finally {
    db.close();
  }
}

export async function loadClaudeFiveHourHistory(
  dbPath = defaultDatabasePath(),
): Promise<ClaudeFiveHourEstimateHistory> {
  const db = await ensureDatabase(dbPath);
  try {
    const samples = readClaudeUsageSamples(db, "fiveHour");
    const earliestResetAt = [...samples]
      .filter((sample) => sample.resetAt)
      .sort((a, b) => a.resetAt!.localeCompare(b.resetAt!))
      .at(0)?.resetAt;
    if (!earliestResetAt) {
      return [];
    }

    const events = readEventsForRange(db, subtractHours(earliestResetAt, 5), addDays(todayInLocalTimezone(), 1) + "T00:00:00");
    return buildClaudeFiveHourEstimateHistory(samples, events);
  } finally {
    db.close();
  }
}

export async function loadDashboardData(args: {
  root: string;
  codexStatePath: string;
  dbPath?: string;
  date: string;
  sync: boolean;
  source: DashboardSourceFilter;
}): Promise<DashboardData> {
  const dbPath = args.dbPath ?? defaultDatabasePath();
  const pricing = await loadPricing();

  if (args.sync) {
    const db = await ensureDatabase(dbPath);
    try {
      await safeIngest(() => ingestClaudeUsage(db, args.root, pricing));
      await safeIngest(() => ingestCodexUsage(db, args.codexStatePath, pricing));
      await safeIngest(() => ingestCursorUsage(db, undefined, pricing));
    } finally {
      db.close();
    }
  }

  const db = await ensureDatabase(dbPath);
  const monthBegin = monthStart(args.date);
  const weekStart = addDays(args.date, -6);
  const estimateStart = addDays(args.date, -7);
  const rangeStart = estimateStart < monthBegin ? estimateStart : monthBegin;
  const endExclusive = addDays(args.date, 1);

  try {
    const estimateEvents = readEventsForRange(db, `${rangeStart}T00:00:00`, `${endExclusive}T00:00:00`);
    const rawEvents = estimateEvents.filter((event) => event.timestamp >= `${monthBegin}T00:00:00`);
    const events = args.source === "all"
      ? rawEvents
      : rawEvents.filter((event) => event.source === args.source);
    const today = summarizeDay(events, args.date, pricing);
    const week = summarizeRange(
      events.filter((event) => event.timestamp.slice(0, 10) >= weekStart),
      `${weekStart} to ${args.date}`,
      weekStart,
      args.date,
      pricing,
    );
    const month = summarizeRange(
      events,
      `${monthBegin} to ${args.date}`,
      monthBegin,
      args.date,
      pricing,
    );
    const claudeMonth = summarizeRange(
      rawEvents.filter((event) => event.source === "claude-code"),
      `${monthBegin} to ${args.date}`,
      monthBegin,
      args.date,
      pricing,
    );
    const todayProjects = summarizeProjects(
      events.filter((event) => event.timestamp.startsWith(args.date)),
    );
    const monthProjects = summarizeProjects(events);
    const dailyRows = [];
    for (let current = weekStart; current <= args.date; current = addDays(current, 1)) {
      dailyRows.push(summarizeDay(events, current, pricing));
    }
    dailyRows.reverse();
    const claudeUsageSamples = readClaudeUsageSamples(db);
    const claudeFiveHourHistory = buildClaudeFiveHourEstimateHistory(claudeUsageSamples, estimateEvents);
    const claudeWeeklyEstimate = buildClaudeWeeklyEstimate(claudeUsageSamples, estimateEvents);

    return {
      date: args.date,
      weekStart,
      monthBegin,
      today,
      week,
      month,
      todayProjects,
      monthProjects,
      todayModels: today.byModel,
      monthModels: month.byModel,
      dailyRows,
      modelRows: summarizeModelsByDay(events, weekStart, args.date),
      claudeFiveHourEstimate: buildClaudeFiveHourEstimate(claudeUsageSamples, estimateEvents),
      claudeFiveHourHistory,
      claudeWeeklyEstimate,
      claudeMonthEstimate: buildClaudeMonthEstimate(claudeWeeklyEstimate, claudeMonth, args.date),
    };
  } finally {
    db.close();
  }
}
