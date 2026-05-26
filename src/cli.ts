#!/usr/bin/env bun
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
  resolveDashboardDate,
  todayInLocalTimezone,
  type DashboardSourceFilter,
} from "./dashboard-data";
import {
  clearSyncStatus,
  defaultDatabasePath,
  ensureDatabase,
  readEventCount,
  readEventsForDate,
  readEventsForRange,
  readSyncedCount,
  readUnsyncedCount,
} from "./db";
import { renderDashboard } from "./dashboard";
import { ingestClaudeUsage, ingestCodexUsage, ingestCursorUsage } from "./ingest";
import { toCsv } from "./export";
import {
  cancelLokiDelete,
  listLokiDeleteRequests,
  lokiConfigFromEnv,
  probeLoki,
  pushUnsyncedToLoki,
  requestLokiDelete,
} from "./loki-sink";
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
    for (const { label, run } of [
      { label: "claude", run: () => ingestClaudeUsage(db, root, pricing) },
      { label: "codex", run: () => ingestCodexUsage(db, codexStatePath, pricing) },
      { label: "cursor", run: () => ingestCursorUsage(db, undefined, pricing) },
    ]) {
      try {
        await run();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Skipped ${label} ingest: ${message}`);
      }
    }
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
  .option("--push-loki", "Push new events to Grafana Loki after ingest", false)
  .action(
    async ({
      root,
      codexState,
      db: dbPath,
      pushLoki,
    }: {
      root: string;
      codexState: string;
      db: string;
      pushLoki: boolean;
    }) => {
      const pricing = await loadPricing();
      const db = await ensureDatabase(dbPath);

      try {
        const claudeStats = await ingestClaudeUsage(db, root, pricing);
        const codexStats = await ingestCodexUsage(db, codexState, pricing);
        const cursorStats = await ingestCursorUsage(db, undefined, pricing);
        const stats = {
          filesScanned: claudeStats.filesScanned + codexStats.filesScanned + cursorStats.filesScanned,
          filesSkipped: claudeStats.filesSkipped + codexStats.filesSkipped + cursorStats.filesSkipped,
          eventsInserted:
            claudeStats.eventsInserted + codexStats.eventsInserted + cursorStats.eventsInserted,
        };

        console.log(`Database: ${dbPath}`);
        console.log(`Files scanned: ${formatNumber(stats.filesScanned)}`);
        console.log(`Files skipped: ${formatNumber(stats.filesSkipped)}`);
        console.log(`Events upserted: ${formatNumber(stats.eventsInserted)}`);
        console.log(`Total stored events: ${formatNumber(readEventCount(db))}`);

        if (pushLoki) {
          const config = lokiConfigFromEnv();
          if (!config) {
            console.error("LOKI_URL not set; skipping Loki push.");
          } else {
            const result = await pushUnsyncedToLoki(db, config);
            console.log(
              `Loki: pushed ${formatNumber(result.pushed)} events in ${formatNumber(result.batches)} batches (${formatNumber(result.remaining)} remaining).`,
            );
          }
        }
      } finally {
        db.close();
      }
    },
  );

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
    }, command: Command) => {
      if (!DASHBOARD_SOURCE_OPTIONS.includes(source as DashboardSourceFilter)) {
        throw new Error(`Invalid dashboard source filter: ${source}`);
      }

      const sourceFilter = source as DashboardSourceFilter;
      const usePlain = plain || !process.stdin.isTTY || !process.stdout.isTTY;
      const autoDate = command.getOptionValueSource("date") === "default";

      if (!usePlain) {
        render(
          React.createElement(DashboardApp, {
            root,
            dbPath,
            codexStatePath: codexState,
            date,
            autoDate,
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
        const requestedDate = resolveDashboardDate(date, autoDate);
        const { monthBegin, date: dashboardDate } = await loadDashboardData({
          root,
          dbPath,
          codexStatePath: codexState,
          date: requestedDate,
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
        process.stdout.write(renderDashboard(events, pricing, dashboardDate, sourceFilter));
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

program
  .command("loki-test")
  .description("Probe Grafana Loki credentials by querying the labels API")
  .action(async () => {
    const config = lokiConfigFromEnv();
    if (!config) {
      console.error("LOKI_URL is not set. Add it to .env / .env.local or your shell.");
      process.exitCode = 1;
      return;
    }

    console.log(`URL:      ${config.url}`);
    console.log(`User:     ${config.username ?? "(none)"}`);
    console.log(`Token:    ${config.password ? `${config.password.slice(0, 6)}... (${config.password.length} chars)` : "(none)"}`);
    console.log(`Tenant:   ${config.tenantId ?? "(none)"}`);
    console.log(`Team/Env: ${config.team} / ${config.env}`);

    try {
      const { status, body } = await probeLoki(config);
      console.log(`\nGET /loki/api/v1/labels -> ${status}`);
      const trimmed = body.length > 400 ? `${body.slice(0, 400)}...` : body;
      console.log(trimmed || "(empty body)");

      if (status === 200) {
        console.log("\nOK: credentials accepted by Loki.");
      } else if (status === 401 || status === 403) {
        console.log("\nAuth rejected. Check LOKI_USERNAME (instance id) and LOKI_PASSWORD/LOKI_TOKEN.");
        process.exitCode = 1;
      } else {
        console.log("\nUnexpected response. URL host or tenant likely wrong.");
        process.exitCode = 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\nRequest failed: ${message}`);
      process.exitCode = 1;
    }
  });

program
  .command("loki-push")
  .description("Push unsynced usage events to Grafana Loki")
  .option("--db <path>", "SQLite database path", defaultDatabasePath())
  .option("--url <url>", "Override LOKI_URL")
  .option("--team <name>", "Override LOKI_TEAM label")
  .option("--env <name>", "Override LOKI_ENV label")
  .option("--user <name>", "Override LOKI_USER_LABEL (logged in JSON, not as a label)")
  .option("--tenant <id>", "Override LOKI_TENANT_ID (X-Scope-OrgID header)")
  .option("--batch-size <n>", "Override batch size", "500")
  .option(
    "--max-age-hours <n>",
    "Skip events older than this (Loki rejects > reject_old_samples_max_age, default 168h)",
  )
  .option("--dry-run", "Print the first batch payload without sending", false)
  .action(
    async ({
      db: dbPath,
      url,
      team,
      env,
      user,
      tenant,
      batchSize,
      maxAgeHours,
      dryRun,
    }: {
      db: string;
      url?: string;
      team?: string;
      env?: string;
      user?: string;
      tenant?: string;
      batchSize: string;
      maxAgeHours?: string;
      dryRun: boolean;
    }) => {
      const config = lokiConfigFromEnv({
        url,
        team,
        env,
        user,
        tenantId: tenant,
        batchSize: Number(batchSize),
        maxAgeHours: maxAgeHours ? Number(maxAgeHours) : undefined,
      });

      if (!config) {
        console.error("LOKI_URL is not set. Provide it via env or --url.");
        process.exitCode = 1;
        return;
      }

      const db = await ensureDatabase(dbPath);
      try {
        const pending = readUnsyncedCount(db, undefined, "claude-code");
        console.log(`Database: ${dbPath}`);
        console.log(`Loki target: ${config.url} (tenant: ${config.tenantId ?? "-"})`);
        console.log(
          `Labels: service=claude-cost team=${config.team} env=${config.env} (per-event tool, user=${config.user})`,
        );
        console.log(`Window: last ${config.maxAgeHours}h`);
        console.log(`Unsynced events: ${formatNumber(pending)}`);

        if (pending === 0) {
          return;
        }

        const result = await pushUnsyncedToLoki(db, config, { dryRun });
        if (result.skippedTooOld > 0) {
          console.log(
            `Marked ${formatNumber(result.skippedTooOld)} events older than ${result.cutoff} as synced (outside Loki retention window).`,
          );
        }
        if (dryRun) {
          console.log(
            `Dry run: built ${formatNumber(result.pushed)} events into ${formatNumber(result.batches)} batch(es); nothing sent.`,
          );
        } else {
          console.log(
            `Pushed ${formatNumber(result.pushed)} events in ${formatNumber(result.batches)} batches; ${formatNumber(result.remaining)} remaining.`,
          );
        }
      } finally {
        db.close();
      }
    },
  );

program
  .command("loki-delete")
  .description("Submit, list, or cancel Loki log deletion requests")
  .option(
    "--query <logql>",
    "LogQL stream selector to delete",
    '{service="claude-cost"}',
  )
  .option(
    "--start <iso>",
    "Start time (ISO 8601 or unix seconds). Defaults to 30 days ago.",
  )
  .option("--end <iso>", "End time (ISO 8601 or unix seconds). Defaults to now.")
  .option(
    "--days <n>",
    "Convenience: delete last N days of data (overrides --start)",
  )
  .option("--list", "List pending delete requests instead of submitting", false)
  .option("--cancel <id>", "Cancel a pending delete request by id")
  .option("--yes", "Skip confirmation prompt", false)
  .action(
    async ({
      query,
      start,
      end,
      days,
      list,
      cancel,
      yes,
    }: {
      query: string;
      start?: string;
      end?: string;
      days?: string;
      list: boolean;
      cancel?: string;
      yes: boolean;
    }) => {
      const config = lokiConfigFromEnv();
      if (!config) {
        console.error("LOKI_URL is not set. Provide it via env or .env.");
        process.exitCode = 1;
        return;
      }

      if (list) {
        const result = await listLokiDeleteRequests(config);
        console.log(`GET /loki/api/v1/delete -> ${result.status}`);
        if (result.requests.length === 0) {
          console.log(result.body || "(no pending delete requests)");
          return;
        }
        for (const req of result.requests) {
          const startIso = new Date(req.start_time * 1000).toISOString();
          const endIso = new Date(req.end_time * 1000).toISOString();
          console.log(
            `${req.request_id}  ${req.status}  ${startIso} -> ${endIso}  ${req.query}`,
          );
        }
        return;
      }

      if (cancel) {
        const result = await cancelLokiDelete(config, cancel);
        console.log(`DELETE /loki/api/v1/delete?request_id=${cancel} -> ${result.status}`);
        if (result.body) console.log(result.body);
        if (result.status !== 204 && result.status !== 200) process.exitCode = 1;
        return;
      }

      const nowSec = Math.floor(Date.now() / 1000);
      const endSec = end ? parseTimeArg(end) : nowSec;
      const defaultDays = days ? Number(days) : 30;
      if (!Number.isFinite(defaultDays) || defaultDays <= 0) {
        console.error("Invalid --days. Must be a positive number.");
        process.exitCode = 1;
        return;
      }
      const startSec = start
        ? parseTimeArg(start)
        : endSec - Math.floor(defaultDays * 24 * 60 * 60);
      if (Number.isNaN(startSec) || Number.isNaN(endSec)) {
        console.error("Invalid --start or --end. Use ISO 8601 or unix seconds.");
        process.exitCode = 1;
        return;
      }
      if (startSec >= endSec) {
        console.error("--start must be before --end.");
        process.exitCode = 1;
        return;
      }

      const startIso = new Date(startSec * 1000).toISOString();
      const endIso = new Date(endSec * 1000).toISOString();
      console.log(`Loki target: ${config.url} (tenant: ${config.tenantId ?? "-"})`);
      console.log(`Query:       ${query}`);
      console.log(`Start:       ${startIso}`);
      console.log(`End:         ${endIso}`);

      if (!yes) {
        const answer = prompt("\nSubmit delete request? [y/N] ") ?? "";
        if (answer.trim().toLowerCase() !== "y") {
          console.log("Aborted.");
          return;
        }
      }

      const result = await requestLokiDelete(config, { query, startSec, endSec });
      console.log(`POST /loki/api/v1/delete -> ${result.status}`);
      if (result.body) console.log(result.body);
      if (result.status === 204 || result.status === 200) {
        console.log("\nQueued. Run with --list to track status (deletion is asynchronous).");
      } else {
        if (result.status === 404) {
          console.log("\n404: deletion may not be enabled on this Loki stack.");
        }
        process.exitCode = 1;
      }
    },
  );

function parseTimeArg(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? Number.NaN : Math.floor(ms / 1000);
}

const ALLOWED_RESET_SOURCES = new Set(["claude-code", "codex-cli", "cursor"] as const);
type ResetSource = "claude-code" | "codex-cli" | "cursor";

program
  .command("loki-reset-sync")
  .description(
    "Clear synced_at on local events so they can be re-pushed to Loki. Requires an explicit time range.",
  )
  .option("--db <path>", "SQLite database path", defaultDatabasePath())
  .option("--since <iso>", "Only clear events with timestamp >= this (ISO 8601 or unix seconds)")
  .option("--until <iso>", "Only clear events with timestamp < this (ISO 8601 or unix seconds)")
  .option(
    "--days <n>",
    "Convenience: clear last N days of events (sets --since to now-Nd, --until to now)",
  )
  .option("--source <name>", "Filter by source: claude-code | codex-cli | cursor", "claude-code")
  .option(
    "--all-sources",
    "Clear across all sources (overrides --source)",
    false,
  )
  .option("--yes", "Skip confirmation prompt", false)
  .action(
    async ({
      db: dbPath,
      since,
      until,
      days,
      source,
      allSources,
      yes,
    }: {
      db: string;
      since?: string;
      until?: string;
      days?: string;
      source: string;
      allSources: boolean;
      yes: boolean;
    }) => {
      let sinceIso: string | undefined;
      let untilIso: string | undefined;

      if (days) {
        const n = Number(days);
        if (!Number.isFinite(n) || n <= 0) {
          console.error("Invalid --days. Must be a positive number.");
          process.exitCode = 1;
          return;
        }
        const nowSec = Math.floor(Date.now() / 1000);
        sinceIso = new Date((nowSec - Math.floor(n * 24 * 60 * 60)) * 1000).toISOString();
        untilIso = new Date(nowSec * 1000).toISOString();
      } else {
        if (since) {
          const sec = parseTimeArg(since);
          if (Number.isNaN(sec)) {
            console.error("Invalid --since. Use ISO 8601 or unix seconds.");
            process.exitCode = 1;
            return;
          }
          sinceIso = new Date(sec * 1000).toISOString();
        }
        if (until) {
          const sec = parseTimeArg(until);
          if (Number.isNaN(sec)) {
            console.error("Invalid --until. Use ISO 8601 or unix seconds.");
            process.exitCode = 1;
            return;
          }
          untilIso = new Date(sec * 1000).toISOString();
        }
      }

      if (!sinceIso && !untilIso) {
        console.error(
          "Refusing to clear without a time range. Pass --since/--until or --days.",
        );
        process.exitCode = 1;
        return;
      }

      let sourceFilter: ResetSource | undefined;
      if (!allSources) {
        if (!ALLOWED_RESET_SOURCES.has(source as ResetSource)) {
          console.error(
            `Invalid --source '${source}'. Expected one of: claude-code, codex-cli, cursor.`,
          );
          process.exitCode = 1;
          return;
        }
        sourceFilter = source as ResetSource;
      }

      const db = await ensureDatabase(dbPath);
      try {
        const filter = { since: sinceIso, until: untilIso, source: sourceFilter };
        const matched = readSyncedCount(db, filter);

        console.log(`Database:    ${dbPath}`);
        console.log(`Source:      ${sourceFilter ?? "(all)"}`);
        console.log(`Since:       ${sinceIso ?? "(beginning of time)"}`);
        console.log(`Until:       ${untilIso ?? "(now)"}`);
        console.log(`Will clear:  ${formatNumber(matched)} synced events`);

        if (matched === 0) {
          return;
        }

        if (!yes) {
          const answer = prompt("\nClear synced_at on these events? [y/N] ") ?? "";
          if (answer.trim().toLowerCase() !== "y") {
            console.log("Aborted.");
            return;
          }
        }

        const cleared = clearSyncStatus(db, filter);
        console.log(`Cleared synced_at on ${formatNumber(cleared)} events.`);
        console.log("Run `claude-cost loki-push` to ship them.");
      } finally {
        db.close();
      }
    },
  );

await program.parseAsync(process.argv);
