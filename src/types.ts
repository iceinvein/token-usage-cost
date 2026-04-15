export type UsageEvent = {
  source: "claude-code" | "codex-cli" | "cursor";
  project: string;
  sessionId: string;
  filePath: string;
  eventKey: string;
  timestamp: string;
  messageId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  webSearchRequests: number;
  totalTokens: number;
  tokenBreakdownKnown: boolean;
  speed: "standard" | "fast";
  estimatedCostUsd: number;
};

export type ModelPricing = {
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheWriteCostPerToken: number;
  cacheReadCostPerToken: number;
  webSearchCostPerRequest: number;
  fastMultiplier: number;
};

export type DailySummary = {
  date: string;
  events: number;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheWriteTokens: number;
  totalCacheReadTokens: number;
  totalWebSearchRequests: number;
  estimatedCostUsd: number;
  byModel: Array<{
    model: string;
    events: number;
    estimatedCostUsd: number;
  }>;
  bySource: Array<{
    source: UsageEvent["source"];
    events: number;
    totalTokens: number;
    estimatedCostUsd: number;
    tokenBreakdownKnown: boolean;
  }>;
  unknownModels: string[];
};

export type IngestStats = {
  filesScanned: number;
  filesSkipped: number;
  eventsInserted: number;
};

export type RangeSummary = {
  label: string;
  startDate: string;
  endDate: string;
  events: number;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheWriteTokens: number;
  totalCacheReadTokens: number;
  totalWebSearchRequests: number;
  estimatedCostUsd: number;
  byModel: Array<{
    model: string;
    events: number;
    estimatedCostUsd: number;
  }>;
  bySource: Array<{
    source: UsageEvent["source"];
    events: number;
    totalTokens: number;
    estimatedCostUsd: number;
    tokenBreakdownKnown: boolean;
  }>;
  unknownModels: string[];
};

export type ProjectSummary = {
  project: string;
  displayProject: string;
  rawProjects: string[];
  events: number;
  estimatedCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
};
