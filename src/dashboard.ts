import { summarizeDay, summarizeProjects, summarizeRange } from "./aggregate";
import type { DashboardSourceFilter } from "./dashboard-data";
import type { ModelPricing, UsageEvent } from "./types";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const BLUE = "\x1b[34m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const MAGENTA = "\x1b[35m";
const WHITE = "\x1b[37m";

type DashboardSourceId = Exclude<DashboardSourceFilter, "all">;

const DASHBOARD_SOURCES: DashboardSourceId[] = ["claude-code", "codex-cli", "cursor"];

function formatUsd(amount: number): string {
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  if (amount >= 0.01) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(4)}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatSourceLabel(source: DashboardSourceId): string {
  switch (source) {
    case "claude-code":
      return "Claude Code";
    case "codex-cli":
      return "Codex";
    case "cursor":
      return "Cursor";
  }
}

function sourceTone(source: DashboardSourceId): string {
  switch (source) {
    case "claude-code":
      return CYAN;
    case "codex-cli":
      return YELLOW;
    case "cursor":
      return MAGENTA;
  }
}

function formatSourceFilterLabel(source: DashboardSourceFilter): string {
  if (source === "all") {
    return "All tools";
  }

  return formatSourceLabel(source);
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function repeat(char: string, width: number): string {
  return "".padEnd(width, char);
}

function color(text: string, tone: string): string {
  return `${tone}${text}${RESET}`;
}

function miniBar(value: number, max: number, width = 16, tone = CYAN): string {
  if (max <= 0) {
    return repeat(" ", width);
  }

  const filled = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  const solid = filled > 0 ? color(repeat("#", filled), tone) : "";
  return `${solid}${color(repeat(".", width - filled), DIM)}`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text.padEnd(width);
}

function plainLength(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padAnsi(text: string, width: number): string {
  const visible = plainLength(text);
  return visible >= width ? text : `${text}${" ".repeat(width - visible)}`;
}

function box(title: string, lines: string[], tone = BLUE, width = 72): string[] {
  const inner = width - 4;
  const header = `+${repeat("-", width - 2)}+`;
  const titleLine = `| ${padAnsi(color(`${BOLD}${title}${RESET}`, tone), inner)} |`;
  const body = lines.map((line) => `| ${padAnsi(line, inner)} |`);
  return [color(header, tone), titleLine, color(header, tone), ...body, color(header, tone)];
}

function renderMetricGrid(rows: string[][]): string[] {
  const columnWidth = 33;
  return rows.map((row) => row.map((cell) => padAnsi(cell, columnWidth)).join("  "));
}

export function renderDashboard(
  events: UsageEvent[],
  pricing: Map<string, ModelPricing>,
  date: string,
  source: DashboardSourceFilter,
): string {
  const filteredEvents = source === "all"
    ? events
    : events.filter((event) => event.source === source);
  const today = summarizeDay(filteredEvents, date, pricing);
  const weekStart = addDays(date, -6);
  const monthBegin = monthStart(date);

  const week = summarizeRange(
    filteredEvents.filter((event) => event.timestamp.slice(0, 10) >= weekStart && event.timestamp.slice(0, 10) <= date),
    `${weekStart} to ${date}`,
    weekStart,
    date,
    pricing,
  );
  const month = summarizeRange(
    filteredEvents.filter((event) => event.timestamp.slice(0, 10) >= monthBegin && event.timestamp.slice(0, 10) <= date),
    `${monthBegin} to ${date}`,
    monthBegin,
    date,
    pricing,
  );

  const monthProjects = summarizeProjects(
    filteredEvents.filter((event) => event.timestamp.slice(0, 10) >= monthBegin && event.timestamp.slice(0, 10) <= date),
  ).slice(0, 5);
  const monthModels = month.byModel.slice(0, 5);
  const todayProjects = summarizeProjects(
    filteredEvents.filter((event) => event.timestamp.startsWith(date)),
  ).slice(0, 3);
  const todayModels = today.byModel.slice(0, 3);

  const dailyRows = [];
  for (let current = weekStart; current <= date; current = addDays(current, 1)) {
    dailyRows.push(summarizeDay(filteredEvents, current, pricing));
  }
  dailyRows.reverse();

  const maxDailyCost = Math.max(...dailyRows.map((row) => row.estimatedCostUsd), 0);
  const maxProjectCost = Math.max(...monthProjects.map((row) => row.estimatedCostUsd), 0);
  const maxModelCost = Math.max(...monthModels.map((row) => row.estimatedCostUsd), 0);
  const sourceLines = DASHBOARD_SOURCES.map((source) => {
    const todaySource = today.bySource.find((row) => row.source === source);
    const monthSource = month.bySource.find((row) => row.source === source);

    return `${padAnsi(color(formatSourceLabel(source), sourceTone(source)), 18)}  ${color("Today", DIM)} ${color(formatUsd(todaySource?.estimatedCostUsd ?? 0).padStart(8), YELLOW)} ${color(formatNumber(todaySource?.events ?? 0).padStart(5), DIM)} ev  ${color("Month", DIM)} ${color(formatUsd(monthSource?.estimatedCostUsd ?? 0).padStart(8), YELLOW)} ${color(formatNumber(monthSource?.events ?? 0).padStart(5), DIM)} ev`;
  });

  const lines: string[] = [];
  lines.push(color(`${BOLD}CLAUDE COST DASHBOARD${RESET}`, WHITE));
  lines.push(color(`${DIM}Snapshot for ${date}${RESET}`, DIM));
  lines.push(color(`${DIM}Filter: ${formatSourceFilterLabel(source)}${RESET}`, DIM));
  lines.push("");
  lines.push(...box("Overview", renderMetricGrid([
    [
      `${color("Today", CYAN)}  ${color(formatUsd(today.estimatedCostUsd).padStart(8), YELLOW)}  ${color(formatNumber(today.events).padStart(6), WHITE)} events`,
      `${color("Week", CYAN)}   ${color(formatUsd(week.estimatedCostUsd).padStart(8), YELLOW)}  ${color(formatNumber(week.events).padStart(6), WHITE)} events`,
    ],
    [
      `${color("Month", CYAN)}  ${color(formatUsd(month.estimatedCostUsd).padStart(8), YELLOW)}  ${color(formatNumber(month.events).padStart(6), WHITE)} events`,
      `${color("Today tokens", MAGENTA)} ${formatNumber(today.totalInputTokens)} in / ${formatNumber(today.totalOutputTokens)} out`,
    ],
    [
      `${color("Cache read", GREEN)}  ${formatNumber(today.totalCacheReadTokens)}`,
      `${color("Cache write", GREEN)} ${formatNumber(today.totalCacheWriteTokens)}`,
    ],
  ]), CYAN));
  lines.push("");
  if (source === "all") {
    lines.push(...box("Sources", sourceLines, YELLOW));
    lines.push("");
  }
  const trendLines: string[] = [];
  for (const row of dailyRows) {
    trendLines.push(
      `${color(row.date, WHITE)}  [${miniBar(row.estimatedCostUsd, maxDailyCost, 18, CYAN)}]  ${color(formatUsd(row.estimatedCostUsd).padStart(8), YELLOW)}  ${color(formatNumber(row.events).padStart(6), DIM)} events`,
    );
  }
  lines.push(...box("7-Day Trend", trendLines, CYAN));
  lines.push("");
  const todayProjectLines: string[] = [];
  if (todayProjects.length === 0) {
    todayProjectLines.push(color("No project usage today.", DIM));
  } else {
    const maxTodayProjectCost = Math.max(...todayProjects.map((row) => row.estimatedCostUsd), 0);
    for (const project of todayProjects) {
      todayProjectLines.push(
        `${padAnsi(color(project.displayProject, WHITE), 30)} [${miniBar(project.estimatedCostUsd, maxTodayProjectCost, 16, GREEN)}]  ${color(formatUsd(project.estimatedCostUsd).padStart(8), YELLOW)}`,
      );
    }
  }
  lines.push(...box("Top Projects Today", todayProjectLines, GREEN));
  lines.push("");
  const todayModelLines: string[] = [];
  if (todayModels.length === 0) {
    todayModelLines.push(color("No model usage today.", DIM));
  } else {
    const maxTodayModelCost = Math.max(...todayModels.map((row) => row.estimatedCostUsd), 0);
    for (const model of todayModels) {
      todayModelLines.push(
        `${padAnsi(color(model.model, WHITE), 26)} [${miniBar(model.estimatedCostUsd, maxTodayModelCost, 16, MAGENTA)}]  ${color(formatUsd(model.estimatedCostUsd).padStart(8), YELLOW)}  ${color(formatNumber(model.events).padStart(6), DIM)} events`,
      );
    }
  }
  lines.push(...box("Top Models Today", todayModelLines, MAGENTA));
  lines.push("");
  const monthProjectLines: string[] = [];
  if (monthProjects.length === 0) {
    monthProjectLines.push(color("No project usage.", DIM));
  } else {
    for (const project of monthProjects) {
      monthProjectLines.push(
        `${padAnsi(color(project.displayProject, WHITE), 30)} [${miniBar(project.estimatedCostUsd, maxProjectCost, 16, GREEN)}]  ${color(formatUsd(project.estimatedCostUsd).padStart(8), YELLOW)}`,
      );
    }
  }
  lines.push(...box("Top Projects This Month", monthProjectLines, GREEN));
  lines.push("");
  const monthModelLines: string[] = [];
  if (monthModels.length === 0) {
    monthModelLines.push(color("No model usage.", DIM));
  } else {
    for (const model of monthModels) {
      monthModelLines.push(
        `${padAnsi(color(model.model, WHITE), 26)} [${miniBar(model.estimatedCostUsd, maxModelCost, 16, MAGENTA)}]  ${color(formatUsd(model.estimatedCostUsd).padStart(8), YELLOW)}  ${color(formatNumber(model.events).padStart(6), DIM)} events`,
      );
    }
  }
  lines.push(...box("Top Models This Month", monthModelLines, MAGENTA));

  return `${lines.join("\n")}\n`;
}
