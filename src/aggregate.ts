import { resolvePricing } from "./pricing";
import { normalizeProjectName } from "./present";
import type { DailySummary, ModelPricing, ProjectSummary, RangeSummary, UsageEvent } from "./types";

function summarizeRangeInternal(
  events: UsageEvent[],
  label: string,
  startDate: string,
  endDate: string,
  pricingTable: Map<string, ModelPricing>,
): RangeSummary {
  const byModel = new Map<string, { events: number; estimatedCostUsd: number }>();
  const bySource = new Map<
    UsageEvent["source"],
    { events: number; totalTokens: number; estimatedCostUsd: number; tokenBreakdownKnown: boolean }
  >();
  const unknownModels = new Set<string>();

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalCacheReadTokens = 0;
  let totalWebSearchRequests = 0;
  let totalTokens = 0;
  let estimatedCostUsd = 0;

  for (const event of events) {
    totalTokens += event.totalTokens;
    totalInputTokens += event.inputTokens;
    totalOutputTokens += event.outputTokens;
    totalCacheWriteTokens += event.cacheWriteTokens;
    totalCacheReadTokens += event.cacheReadTokens;
    totalWebSearchRequests += event.webSearchRequests;
    estimatedCostUsd += event.estimatedCostUsd;

    const modelSummary = byModel.get(event.model) ?? { events: 0, estimatedCostUsd: 0 };
    modelSummary.events += 1;
    modelSummary.estimatedCostUsd += event.estimatedCostUsd;
    byModel.set(event.model, modelSummary);

    const sourceSummary = bySource.get(event.source) ?? {
      events: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      tokenBreakdownKnown: true,
    };
    sourceSummary.events += 1;
    sourceSummary.totalTokens += event.totalTokens;
    sourceSummary.estimatedCostUsd += event.estimatedCostUsd;
    sourceSummary.tokenBreakdownKnown = sourceSummary.tokenBreakdownKnown && event.tokenBreakdownKnown;
    bySource.set(event.source, sourceSummary);

    if (!resolvePricing(event.model, pricingTable)) {
      unknownModels.add(event.model);
    }
  }

  return {
    label,
    startDate,
    endDate,
    events: events.length,
    totalTokens,
    totalInputTokens,
    totalOutputTokens,
    totalCacheWriteTokens,
    totalCacheReadTokens,
    totalWebSearchRequests,
    estimatedCostUsd,
    byModel: [...byModel.entries()]
      .map(([model, summary]) => ({ model, ...summary }))
      .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd || b.events - a.events || a.model.localeCompare(b.model)),
    bySource: [...bySource.entries()]
      .map(([source, summary]) => ({ source, ...summary }))
      .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd || b.events - a.events || a.source.localeCompare(b.source)),
    unknownModels: [...unknownModels].sort(),
  };
}

export function summarizeDay(
  events: UsageEvent[],
  date: string,
  pricingTable: Map<string, ModelPricing>,
): DailySummary {
  const dayEvents = events.filter((event) => event.timestamp.startsWith(date));
  const summary = summarizeRangeInternal(dayEvents, date, date, date, pricingTable);

  return {
    date,
    events: summary.events,
    totalTokens: summary.totalTokens,
    totalInputTokens: summary.totalInputTokens,
    totalOutputTokens: summary.totalOutputTokens,
    totalCacheWriteTokens: summary.totalCacheWriteTokens,
    totalCacheReadTokens: summary.totalCacheReadTokens,
    totalWebSearchRequests: summary.totalWebSearchRequests,
    estimatedCostUsd: summary.estimatedCostUsd,
    byModel: summary.byModel,
    bySource: summary.bySource,
    unknownModels: summary.unknownModels,
  };
}

export function summarizeRange(
  events: UsageEvent[],
  label: string,
  startDate: string,
  endDate: string,
  pricingTable: Map<string, ModelPricing>,
): RangeSummary {
  return summarizeRangeInternal(events, label, startDate, endDate, pricingTable);
}

export function summarizeProjects(events: UsageEvent[]): ProjectSummary[] {
  const byProject = new Map<
    string,
    {
      events: number;
      estimatedCostUsd: number;
      totalInputTokens: number;
      totalOutputTokens: number;
    }
  >();

  for (const event of events) {
    const project = byProject.get(event.project) ?? {
      events: 0,
      estimatedCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    };

    project.events += 1;
    project.estimatedCostUsd += event.estimatedCostUsd;
    project.totalInputTokens += event.inputTokens;
    project.totalOutputTokens += event.outputTokens;
    byProject.set(event.project, project);
  }

  const grouped = new Map<
    string,
    {
      rawProjects: string[];
      events: number;
      estimatedCostUsd: number;
      totalInputTokens: number;
      totalOutputTokens: number;
    }
  >();

  for (const [project, summary] of byProject.entries()) {
    const displayProject = normalizeProjectName(project);
    const group = grouped.get(displayProject) ?? {
      rawProjects: [],
      events: 0,
      estimatedCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    };

    group.rawProjects.push(project);
    group.events += summary.events;
    group.estimatedCostUsd += summary.estimatedCostUsd;
    group.totalInputTokens += summary.totalInputTokens;
    group.totalOutputTokens += summary.totalOutputTokens;
    grouped.set(displayProject, group);
  }

  return [...grouped.entries()]
    .map(([displayProject, summary]) => ({
      project: summary.rawProjects[0] ?? displayProject,
      displayProject,
      rawProjects: summary.rawProjects.sort(),
      events: summary.events,
      estimatedCostUsd: summary.estimatedCostUsd,
      totalInputTokens: summary.totalInputTokens,
      totalOutputTokens: summary.totalOutputTokens,
    }))
    .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd || b.events - a.events || a.displayProject.localeCompare(b.displayProject));
}

export function summarizeModelsByDay(
  events: UsageEvent[],
  startDate: string,
  endDate: string,
): Array<{
  date: string;
  models: Array<{
    model: string;
    events: number;
    estimatedCostUsd: number;
    inputTokens: number;
    outputTokens: number;
  }>;
}> {
  const dates: string[] = [];
  let current = startDate;

  while (current <= endDate) {
    dates.push(current);
    const value = new Date(`${current}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + 1);
    current = value.toISOString().slice(0, 10);
  }

  return dates.map((date) => {
    const byModel = new Map<
      string,
      { events: number; estimatedCostUsd: number; inputTokens: number; outputTokens: number }
    >();

    for (const event of events) {
      if (!event.timestamp.startsWith(date)) {
        continue;
      }

      const summary = byModel.get(event.model) ?? {
        events: 0,
        estimatedCostUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
      };

      summary.events += 1;
      summary.estimatedCostUsd += event.estimatedCostUsd;
      summary.inputTokens += event.inputTokens;
      summary.outputTokens += event.outputTokens;
      byModel.set(event.model, summary);
    }

    return {
      date,
      models: [...byModel.entries()]
        .map(([model, summary]) => ({ model, ...summary }))
        .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd || b.events - a.events || a.model.localeCompare(b.model)),
    };
  });
}
