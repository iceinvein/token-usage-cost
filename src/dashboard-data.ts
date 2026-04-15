import { summarizeDay, summarizeModelsByDay, summarizeProjects, summarizeRange } from "./aggregate";
import { defaultDatabasePath, ensureDatabase, readEventsForRange } from "./db";
import { ingestClaudeUsage, ingestCodexUsage, ingestCursorUsage } from "./ingest";
import { loadPricing } from "./pricing";

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
};

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
      await ingestClaudeUsage(db, args.root, pricing);
      await ingestCodexUsage(db, args.codexStatePath, pricing);
      await ingestCursorUsage(db, undefined, pricing);
    } finally {
      db.close();
    }
  }

  const db = await ensureDatabase(dbPath);
  const monthBegin = monthStart(args.date);
  const weekStart = addDays(args.date, -6);
  const endExclusive = addDays(args.date, 1);

  try {
    const rawEvents = readEventsForRange(db, `${monthBegin}T00:00:00`, `${endExclusive}T00:00:00`);
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
    const todayProjects = summarizeProjects(
      events.filter((event) => event.timestamp.startsWith(args.date)),
    );
    const monthProjects = summarizeProjects(events);
    const dailyRows = [];
    for (let current = weekStart; current <= args.date; current = addDays(current, 1)) {
      dailyRows.push(summarizeDay(events, current, pricing));
    }
    dailyRows.reverse();

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
    };
  } finally {
    db.close();
  }
}
