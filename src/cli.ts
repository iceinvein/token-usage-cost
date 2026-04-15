import { homedir } from "node:os";

import { Command } from "commander";
import { render } from "ink";
import React from "react";

import { summarizeDay, summarizeModelsByDay, summarizeProjects, summarizeRange } from "./aggregate";
import { DashboardApp } from "./dashboard-app";
import {
  addDays,
  formatLocalTimestamp,
  loadDashboardData,
  monthStart,
  todayInLocalTimezone,
  type DashboardSourceFilter,
} from "./dashboard-data";
import {
  defaultDatabasePath,
  ensureDatabase,
  readEventCount,
  readEventsForDate,
  readEventsForRange,
} from "./db";
import { renderDashboard } from "./dashboard";
import { ingestClaudeUsage, ingestCodexUsage, ingestCursorUsage } from "./ingest";
import { toCsv } from "./export";
import { loadPricing } from "./pricing";

function formatUsd(amount: number): string {
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  if (amount >= 0.01) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(4)}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function dateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  let current = startDate;

  while (current <= endDate) {
    dates.push(current);
    current = addDays(current, 1);
  }

  return dates;
}

async function maybeSync(
  root: string,
  sync: boolean,
  dbPath: string,
  pricing: Awaited<ReturnType<typeof loadPricing>>,
  codexStatePath: string,
) {
  if (!sync) {
    return;
  }

  const db = await ensureDatabase(dbPath);
  try {
    await ingestClaudeUsage(db, root, pricing);
    await ingestCodexUsage(db, codexStatePath, pricing);
    await ingestCursorUsage(db, undefined, pricing);
  } finally {
    db.close();
  }
}

function printSummary(summary: {
  label: string;
  events: number;
  totalTokens: number;
  estimatedCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalWebSearchRequests: number;
  byModel: Array<{ model: string; estimatedCostUsd: number; events: number }>;
  bySource: Array<{
    source: string;
    estimatedCostUsd: number;
    events: number;
    totalTokens: number;
    tokenBreakdownKnown: boolean;
  }>;
  unknownModels: string[];
}) {
  console.log(`Period: ${summary.label}`);
  console.log(`Events: ${formatNumber(summary.events)}`);
  console.log(`Estimated cost: ${formatUsd(summary.estimatedCostUsd)}`);
  console.log(`Total tokens: ${formatNumber(summary.totalTokens)}`);
  console.log(
    `Detailed tokens: ${formatNumber(summary.totalInputTokens)} in, ${formatNumber(summary.totalOutputTokens)} out, ${formatNumber(summary.totalCacheReadTokens)} cache read, ${formatNumber(summary.totalCacheWriteTokens)} cache write`,
  );
  console.log(`Web searches: ${formatNumber(summary.totalWebSearchRequests)}`);

  if (summary.bySource.length > 0) {
    console.log("\nBy source:");
    for (const source of summary.bySource) {
      const note = source.tokenBreakdownKnown ? "" : " (aggregate-token estimate)";
      console.log(
        `  ${source.source}: ${formatUsd(source.estimatedCostUsd)} across ${formatNumber(source.events)} events and ${formatNumber(source.totalTokens)} tokens${note}`,
      );
    }
  }

  if (summary.byModel.length > 0) {
    console.log("\nBy model:");
    for (const model of summary.byModel) {
      console.log(
        `  ${model.model}: ${formatUsd(model.estimatedCostUsd)} across ${formatNumber(model.events)} events`,
      );
    }
  }

  if (summary.unknownModels.length > 0) {
    console.log("\nUnknown pricing:");
    for (const model of summary.unknownModels) {
      console.log(`  ${model}`);
    }
  }
}

async function loadRangeEvents(args: {
  root: string;
  codexStatePath: string;
  dbPath: string;
  sync: boolean;
  startDate: string;
  endDate: string;
}) {
  const pricing = await loadPricing();
  await maybeSync(args.root, args.sync, args.dbPath, pricing, args.codexStatePath);

  const db = await ensureDatabase(args.dbPath);
  const endExclusive = addDays(args.endDate, 1);

  try {
    const events = readEventsForRange(
      db,
      `${args.startDate}T00:00:00`,
      `${endExclusive}T00:00:00`,
    );
    return { pricing, events };
  } finally {
    db.close();
  }
}

const program = new Command();
const DASHBOARD_SOURCE_OPTIONS: DashboardSourceFilter[] = ["all", "claude-code", "codex-cli", "cursor"];

program
  .name("claude-cost")
  .description("Parse local AI coding assistant usage, persist activity, and estimate cost when available")
  .version("0.1.0");

program
  .command("sync")
  .description("Ingest local assistant activity into the SQLite database")
  .option("--root <path>", "Claude transcripts root", `${homedir()}/.claude/projects`)
  .option("--codex-state <path>", "Codex state sqlite path", `${homedir()}/.codex/state_5.sqlite`)
  .option("--db <path>", "SQLite database path", defaultDatabasePath())
  .action(async ({ root, codexState, db: dbPath }: { root: string; codexState: string; db: string }) => {
      const pricing = await loadPricing();
      const db = await ensureDatabase(dbPath);

      try {
        const claudeStats = await ingestClaudeUsage(db, root, pricing);
        const codexStats = await ingestCodexUsage(db, codexState, pricing);
        const cursorStats = await ingestCursorUsage(db, undefined, pricing);
        const stats = {
        filesScanned: claudeStats.filesScanned + codexStats.filesScanned + cursorStats.filesScanned,
        filesSkipped: claudeStats.filesSkipped + codexStats.filesSkipped + cursorStats.filesSkipped,
        eventsInserted: claudeStats.eventsInserted + codexStats.eventsInserted + cursorStats.eventsInserted,
        };

      console.log(`Database: ${dbPath}`);
      console.log(`Files scanned: ${formatNumber(stats.filesScanned)}`);
      console.log(`Files skipped: ${formatNumber(stats.filesSkipped)}`);
      console.log(`Events upserted: ${formatNumber(stats.eventsInserted)}`);
      console.log(`Total stored events: ${formatNumber(readEventCount(db))}`);
    } finally {
      db.close();
    }
  });

program
  .command("today")
  .description("Show today's usage and estimated cost from SQLite")
  .option("--root <path>", "Claude transcripts root", `${homedir()}/.claude/projects`)
  .option("--codex-state <path>", "Codex state sqlite path", `${homedir()}/.codex/state_5.sqlite`)
  .option("--db <path>", "SQLite database path", defaultDatabasePath())
  .option("--date <yyyy-mm-dd>", "Override date", todayInLocalTimezone())
  .option("--sync", "Sync transcripts before reading summary", false)
  .action(
    async ({
      root,
      codexState,
      db: dbPath,
      date,
      sync,
    }: {
      root: string;
      codexState: string;
      db: string;
      date: string;
      sync: boolean;
    }) => {
      const pricing = await loadPricing();
      await maybeSync(root, sync, dbPath, pricing, codexState);

      const db = await ensureDatabase(dbPath);
      try {
        const events = readEventsForDate(db, date);
        const summary = summarizeDay(events, date, pricing);

        console.log(`Database: ${dbPath}`);
        printSummary({ ...summary, label: summary.date });
      } finally {
        db.close();
      }
    },
  );

program
  .command("week")
  .description("Show a 7-day usage and estimated cost summary from SQLite")
  .option("--root <path>", "Claude transcripts root", `${homedir()}/.claude/projects`)
  .option("--codex-state <path>", "Codex state sqlite path", `${homedir()}/.codex/state_5.sqlite`)
  .option("--db <path>", "SQLite database path", defaultDatabasePath())
  .option("--date <yyyy-mm-dd>", "End date inclusive", todayInLocalTimezone())
  .option("--sync", "Sync transcripts before reading summary", false)
  .action(
    async ({
      root,
      codexState,
      db: dbPath,
      date,
      sync,
    }: {
      root: string;
      codexState: string;
      db: string;
      date: string;
      sync: boolean;
    }) => {
      const pricing = await loadPricing();
      await maybeSync(root, sync, dbPath, pricing, codexState);

      const startDate = addDays(date, -6);
      const endExclusive = addDays(date, 1);
      const db = await ensureDatabase(dbPath);

      try {
        const events = readEventsForRange(db, `${startDate}T00:00:00`, `${endExclusive}T00:00:00`);
        const summary = summarizeRange(events, `${startDate} to ${date}`, startDate, date, pricing);

        console.log(`Database: ${dbPath}`);
        printSummary(summary);
      } finally {
        db.close();
      }
    },
  );

program
  .command("month")
  .description("Show month-to-date usage and estimated cost from SQLite")
  .option("--root <path>", "Claude transcripts root", `${homedir()}/.claude/projects`)
  .option("--codex-state <path>", "Codex state sqlite path", `${homedir()}/.codex/state_5.sqlite`)
  .option("--db <path>", "SQLite database path", defaultDatabasePath())
  .option("--date <yyyy-mm-dd>", "End date inclusive", todayInLocalTimezone())
  .option("--sync", "Sync transcripts before reading summary", false)
  .action(
    async ({
      root,
      codexState,
      db: dbPath,
      date,
      sync,
    }: {
      root: string;
      codexState: string;
      db: string;
      date: string;
      sync: boolean;
    }) => {
      const pricing = await loadPricing();
      await maybeSync(root, sync, dbPath, pricing, codexState);

      const startDate = monthStart(date);
      const endExclusive = addDays(date, 1);
      const db = await ensureDatabase(dbPath);

      try {
        const events = readEventsForRange(db, `${startDate}T00:00:00`, `${endExclusive}T00:00:00`);
        const summary = summarizeRange(events, `${startDate} to ${date}`, startDate, date, pricing);

        console.log(`Database: ${dbPath}`);
        printSummary(summary);
      } finally {
        db.close();
      }
    },
  );

program
  .command("projects")
  .description("Show top projects for a date range from SQLite")
  .option("--root <path>", "Claude transcripts root", `${homedir()}/.claude/projects`)
  .option("--codex-state <path>", "Codex state sqlite path", `${homedir()}/.codex/state_5.sqlite`)
  .option("--db <path>", "SQLite database path", defaultDatabasePath())
  .option("--from <yyyy-mm-dd>", "Range start date", monthStart(todayInLocalTimezone()))
  .option("--to <yyyy-mm-dd>", "Range end date inclusive", todayInLocalTimezone())
  .option("--limit <n>", "Max projects to display", "10")
  .option("--sync", "Sync transcripts before reading summary", false)
  .action(
    async ({
      root,
      codexState,
      db: dbPath,
      from,
      to,
      limit,
      sync,
    }: {
      root: string;
      codexState: string;
      db: string;
      from: string;
      to: string;
      limit: string;
      sync: boolean;
    }) => {
      const pricing = await loadPricing();
      await maybeSync(root, sync, dbPath, pricing, codexState);

      const db = await ensureDatabase(dbPath);
      const endExclusive = addDays(to, 1);

      try {
        const events = readEventsForRange(db, `${from}T00:00:00`, `${endExclusive}T00:00:00`);
        const projects = summarizeProjects(events).slice(0, Number(limit));

        console.log(`Database: ${dbPath}`);
        console.log(`Period: ${from} to ${to}`);

        if (projects.length === 0) {
          console.log("No project usage found.");
          return;
        }

        console.log("\nProjects:");
        for (const project of projects) {
          console.log(
            `  ${project.displayProject}: ${formatUsd(project.estimatedCostUsd)} across ${formatNumber(project.events)} events (${formatNumber(project.totalInputTokens)} in, ${formatNumber(project.totalOutputTokens)} out)`,
          );
        }
      } finally {
        db.close();
      }
    },
  );

program
  .command("models")
  .description("Show daily model trend rows for a date range from SQLite")
  .option("--root <path>", "Claude transcripts root", `${homedir()}/.claude/projects`)
  .option("--codex-state <path>", "Codex state sqlite path", `${homedir()}/.codex/state_5.sqlite`)
  .option("--db <path>", "SQLite database path", defaultDatabasePath())
  .option("--from <yyyy-mm-dd>", "Range start date", addDays(todayInLocalTimezone(), -6))
  .option("--to <yyyy-mm-dd>", "Range end date inclusive", todayInLocalTimezone())
  .option("--limit <n>", "Max models per day", "3")
  .option("--sync", "Sync transcripts before reading summary", false)
  .action(
    async ({
      root,
      codexState,
      db: dbPath,
      from,
      to,
      limit,
      sync,
    }: {
      root: string;
      codexState: string;
      db: string;
      from: string;
      to: string;
      limit: string;
      sync: boolean;
    }) => {
      const { events } = await loadRangeEvents({
        root,
        codexStatePath: codexState,
        dbPath,
        sync,
        startDate: from,
        endDate: to,
      });

      const rows = summarizeModelsByDay(events, from, to);
      const maxModels = Number(limit);

      console.log(`Database: ${dbPath}`);
      console.log(`Period: ${from} to ${to}`);
      console.log("\nModels:");

      for (const row of rows) {
        console.log(`  ${row.date}:`);
        if (row.models.length === 0) {
          console.log("    no usage");
          continue;
        }

        for (const model of row.models.slice(0, maxModels)) {
          console.log(
            `    ${model.model}: ${formatUsd(model.estimatedCostUsd)} across ${formatNumber(model.events)} events (${formatNumber(model.inputTokens)} in, ${formatNumber(model.outputTokens)} out)`,
          );
        }
      }
    },
  );

program
  .command("dashboard")
  .description("Show a terminal dashboard from SQLite")
  .option("--root <path>", "Claude transcripts root", `${homedir()}/.claude/projects`)
  .option("--codex-state <path>", "Codex state sqlite path", `${homedir()}/.codex/state_5.sqlite`)
  .option("--db <path>", "SQLite database path", defaultDatabasePath())
  .option("--date <yyyy-mm-dd>", "End date inclusive", todayInLocalTimezone())
  .option("--plain", "Use the plain text renderer", false)
  .option("--no-watch", "Disable automatic refresh")
  .option("--interval <seconds>", "Watch refresh interval", "10")
  .option("--source <all|claude-code|codex-cli|cursor>", "Filter dashboard to a single tool", "all")
  .option("--no-sync", "Disable syncing transcripts before reading dashboard")
  .action(
    async ({
      root,
      codexState,
      db: dbPath,
      date,
      plain,
      watch,
      interval,
      source,
      sync,
    }: {
      root: string;
      codexState: string;
      db: string;
      date: string;
      plain: boolean;
      watch: boolean;
      interval: string;
      source: string;
      sync: boolean;
    }) => {
      if (!DASHBOARD_SOURCE_OPTIONS.includes(source as DashboardSourceFilter)) {
        throw new Error(`Invalid dashboard source filter: ${source}`);
      }

      const sourceFilter = source as DashboardSourceFilter;
      const usePlain = plain || !process.stdin.isTTY || !process.stdout.isTTY;

      if (!usePlain) {
        render(
          React.createElement(DashboardApp, {
            root,
            dbPath,
            codexStatePath: codexState,
            date,
            sync,
            watch,
            intervalSeconds: Math.max(1, Number(interval)),
            source: sourceFilter,
          }),
        );
        return;
      }

      if (!plain && (!process.stdin.isTTY || !process.stdout.isTTY)) {
        console.log("Falling back to plain dashboard because this terminal session is not interactive.");
      }

      const drawPlain = async () => {
        const { monthBegin, date: dashboardDate } = await loadDashboardData({
          root,
          dbPath,
          codexStatePath: codexState,
          date,
          sync,
          source: sourceFilter,
        });
        const { events } = await loadRangeEvents({
          root,
          codexStatePath: codexState,
          dbPath,
          sync: false,
          startDate: monthBegin,
          endDate: dashboardDate,
        });
        const pricing = await loadPricing();

        if (watch) {
          process.stdout.write("\x1bc");
        }

        console.log(`Database: ${dbPath}`);
        console.log(`Refreshed: ${formatLocalTimestamp()}`);
        process.stdout.write(renderDashboard(events, pricing, date, sourceFilter));
      };

      await drawPlain();

      if (!watch) {
        return;
      }

      const intervalMs = Math.max(1, Number(interval)) * 1000;
      setInterval(() => {
        void drawPlain();
      }, intervalMs);

      await new Promise(() => {});
    },
  );

program
  .command("daily")
  .description("Show daily trend rows for a date range from SQLite")
  .option("--root <path>", "Claude transcripts root", `${homedir()}/.claude/projects`)
  .option("--codex-state <path>", "Codex state sqlite path", `${homedir()}/.codex/state_5.sqlite`)
  .option("--db <path>", "SQLite database path", defaultDatabasePath())
  .option("--from <yyyy-mm-dd>", "Range start date", addDays(todayInLocalTimezone(), -6))
  .option("--to <yyyy-mm-dd>", "Range end date inclusive", todayInLocalTimezone())
  .option("--sync", "Sync transcripts before reading summary", false)
  .action(
    async ({
      root,
      codexState,
      db: dbPath,
      from,
      to,
      sync,
    }: {
      root: string;
      codexState: string;
      db: string;
      from: string;
      to: string;
      sync: boolean;
    }) => {
      const { pricing, events } = await loadRangeEvents({
        root,
        codexStatePath: codexState,
        dbPath,
        sync,
        startDate: from,
        endDate: to,
      });

      console.log(`Database: ${dbPath}`);
      console.log(`Period: ${from} to ${to}`);
      console.log("\nDaily:");

      for (const date of dateRange(from, to)) {
        const summary = summarizeDay(events, date, pricing);
        console.log(
          `  ${date}: ${formatUsd(summary.estimatedCostUsd)} across ${formatNumber(summary.events)} events (${formatNumber(summary.totalInputTokens)} in, ${formatNumber(summary.totalOutputTokens)} out)`,
        );
      }
    },
  );

program
  .command("export")
  .description("Export range data from SQLite as JSON or CSV")
  .option("--root <path>", "Claude transcripts root", `${homedir()}/.claude/projects`)
  .option("--codex-state <path>", "Codex state sqlite path", `${homedir()}/.codex/state_5.sqlite`)
  .option("--db <path>", "SQLite database path", defaultDatabasePath())
  .option("--from <yyyy-mm-dd>", "Range start date", monthStart(todayInLocalTimezone()))
  .option("--to <yyyy-mm-dd>", "Range end date inclusive", todayInLocalTimezone())
  .option("--format <json|csv>", "Export format", "json")
  .option("--type <daily|projects>", "Export record type", "daily")
  .option("--out <path>", "Output file path")
  .option("--sync", "Sync transcripts before reading summary", false)
  .action(
    async ({
      root,
      codexState,
      db: dbPath,
      from,
      to,
      format,
      type,
      out,
      sync,
    }: {
      root: string;
      codexState: string;
      db: string;
      from: string;
      to: string;
      format: "json" | "csv";
      type: "daily" | "projects";
      out?: string;
      sync: boolean;
    }) => {
      const { pricing, events } = await loadRangeEvents({
        root,
        codexStatePath: codexState,
        dbPath,
        sync,
        startDate: from,
        endDate: to,
      });

      let payload: string;

      if (type === "daily") {
        const rows = dateRange(from, to).map((date) => {
          const summary = summarizeDay(events, date, pricing);
          return {
            date,
            events: summary.events,
            estimatedCostUsd: Number(summary.estimatedCostUsd.toFixed(6)),
            inputTokens: summary.totalInputTokens,
            outputTokens: summary.totalOutputTokens,
            cacheReadTokens: summary.totalCacheReadTokens,
            cacheWriteTokens: summary.totalCacheWriteTokens,
            webSearchRequests: summary.totalWebSearchRequests,
          };
        });

        payload = format === "csv" ? toCsv(rows) : `${JSON.stringify(rows, null, 2)}\n`;
      } else {
        const rows = summarizeProjects(events).map((project) => ({
          project: project.displayProject,
          rawProjects: project.rawProjects.join(" | "),
          events: project.events,
          estimatedCostUsd: Number(project.estimatedCostUsd.toFixed(6)),
          inputTokens: project.totalInputTokens,
          outputTokens: project.totalOutputTokens,
        }));

        payload = format === "csv" ? toCsv(rows) : `${JSON.stringify(rows, null, 2)}\n`;
      }

      if (out) {
        await Bun.write(out, payload);
        console.log(`Wrote ${type} ${format} export to ${out}`);
      } else {
        process.stdout.write(payload);
      }
    },
  );

await program.parseAsync(process.argv);
