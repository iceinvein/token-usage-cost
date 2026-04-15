import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelPricing } from "./types";

type LiteLlmEntry = {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_creation_input_token_cost?: number;
  cache_read_input_token_cost?: number;
  provider_specific_entry?: { fast?: number };
};

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const WEB_SEARCH_COST = 0.01;
const ASSUMED_OUTPUT_FRACTION = 0.15;

const FALLBACK_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-1": {
    inputCostPerToken: 15e-6,
    outputCostPerToken: 75e-6,
    cacheWriteCostPerToken: 18.75e-6,
    cacheReadCostPerToken: 1.5e-6,
    webSearchCostPerRequest: WEB_SEARCH_COST,
    fastMultiplier: 1,
  },
  "claude-sonnet-4-5": {
    inputCostPerToken: 3e-6,
    outputCostPerToken: 15e-6,
    cacheWriteCostPerToken: 3.75e-6,
    cacheReadCostPerToken: 0.3e-6,
    webSearchCostPerRequest: WEB_SEARCH_COST,
    fastMultiplier: 1,
  },
  "claude-sonnet-4": {
    inputCostPerToken: 3e-6,
    outputCostPerToken: 15e-6,
    cacheWriteCostPerToken: 3.75e-6,
    cacheReadCostPerToken: 0.3e-6,
    webSearchCostPerRequest: WEB_SEARCH_COST,
    fastMultiplier: 1,
  },
  "claude-3-7-sonnet": {
    inputCostPerToken: 3e-6,
    outputCostPerToken: 15e-6,
    cacheWriteCostPerToken: 3.75e-6,
    cacheReadCostPerToken: 0.3e-6,
    webSearchCostPerRequest: WEB_SEARCH_COST,
    fastMultiplier: 1,
  },
  "claude-3-5-haiku": {
    inputCostPerToken: 0.8e-6,
    outputCostPerToken: 4e-6,
    cacheWriteCostPerToken: 1e-6,
    cacheReadCostPerToken: 0.08e-6,
    webSearchCostPerRequest: WEB_SEARCH_COST,
    fastMultiplier: 1,
  },
  "gpt-4o": {
    inputCostPerToken: 2.5e-6,
    outputCostPerToken: 10e-6,
    cacheWriteCostPerToken: 2.5e-6,
    cacheReadCostPerToken: 1.25e-6,
    webSearchCostPerRequest: WEB_SEARCH_COST,
    fastMultiplier: 1,
  },
  "gpt-4o-mini": {
    inputCostPerToken: 0.15e-6,
    outputCostPerToken: 0.6e-6,
    cacheWriteCostPerToken: 0.15e-6,
    cacheReadCostPerToken: 0.075e-6,
    webSearchCostPerRequest: WEB_SEARCH_COST,
    fastMultiplier: 1,
  },
};

function getCachePath(): string {
  return join(homedir(), ".cache", "claude-cost", "litellm-pricing.json");
}

function canonicalizeModelName(model: string): string {
  return model.replace(/@.*$/, "").replace(/-\d{8}$/, "");
}

function parseEntry(entry: LiteLlmEntry): ModelPricing | null {
  if (entry.input_cost_per_token == null || entry.output_cost_per_token == null) {
    return null;
  }

  return {
    inputCostPerToken: entry.input_cost_per_token,
    outputCostPerToken: entry.output_cost_per_token,
    cacheWriteCostPerToken:
      entry.cache_creation_input_token_cost ?? entry.input_cost_per_token * 1.25,
    cacheReadCostPerToken:
      entry.cache_read_input_token_cost ?? entry.input_cost_per_token * 0.1,
    webSearchCostPerRequest: WEB_SEARCH_COST,
    fastMultiplier: entry.provider_specific_entry?.fast ?? 1,
  };
}

async function readCachedPricing(): Promise<Map<string, ModelPricing> | null> {
  const file = Bun.file(getCachePath());

  if (!(await file.exists())) {
    return null;
  }

  try {
    const cached = (await file.json()) as {
      timestamp: number;
      data: Record<string, ModelPricing>;
    };

    if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
      return null;
    }

    return new Map(Object.entries(cached.data));
  } catch {
    return null;
  }
}

async function fetchPricing(): Promise<Map<string, ModelPricing>> {
  const response = await fetch(LITELLM_URL);

  if (!response.ok) {
    throw new Error(`Failed to fetch pricing: HTTP ${response.status}`);
  }

  const json = (await response.json()) as Record<string, LiteLlmEntry>;
  const pricing = new Map<string, ModelPricing>();

  for (const [model, entry] of Object.entries(json)) {
    if (model.includes("/") || model.includes(".")) {
      continue;
    }

    const parsed = parseEntry(entry);
    if (parsed) {
      pricing.set(model, parsed);
    }
  }

  const cachePath = getCachePath();
  await mkdir(join(cachePath, ".."), { recursive: true });
  await Bun.write(
    cachePath,
    JSON.stringify({ timestamp: Date.now(), data: Object.fromEntries(pricing) }),
  );

  return pricing;
}

export async function loadPricing(): Promise<Map<string, ModelPricing>> {
  const cached = await readCachedPricing();
  if (cached) {
    return cached;
  }

  try {
    return await fetchPricing();
  } catch {
    return new Map(Object.entries(FALLBACK_PRICING));
  }
}

export function resolvePricing(
  model: string,
  pricingTable: Map<string, ModelPricing>,
): ModelPricing | null {
  const canonical = canonicalizeModelName(model);

  if (pricingTable.has(canonical)) {
    return pricingTable.get(canonical)!;
  }

  for (const [key, pricing] of pricingTable.entries()) {
    if (canonical.startsWith(key) || key.startsWith(canonical)) {
      return pricing;
    }
  }

  for (const [key, pricing] of Object.entries(FALLBACK_PRICING)) {
    if (canonical.startsWith(key)) {
      return pricing;
    }
  }

  return null;
}

export function estimateCostUsd(
  model: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    webSearchRequests: number;
    speed: "standard" | "fast";
  },
  pricingTable: Map<string, ModelPricing>,
): number {
  const pricing = resolvePricing(model, pricingTable);
  if (!pricing) {
    return 0;
  }

  const multiplier = usage.speed === "fast" ? pricing.fastMultiplier : 1;

  return (
    multiplier *
    (usage.inputTokens * pricing.inputCostPerToken +
      usage.outputTokens * pricing.outputCostPerToken +
      usage.cacheWriteTokens * pricing.cacheWriteCostPerToken +
      usage.cacheReadTokens * pricing.cacheReadCostPerToken +
      usage.webSearchRequests * pricing.webSearchCostPerRequest)
  );
}

export function estimateAggregateTokenCostUsd(
  model: string,
  totalTokens: number,
  pricingTable: Map<string, ModelPricing>,
): number {
  const pricing = resolvePricing(model, pricingTable);
  if (!pricing) {
    return 0;
  }

  const assumedInputTokens = totalTokens * (1 - ASSUMED_OUTPUT_FRACTION);
  const assumedOutputTokens = totalTokens * ASSUMED_OUTPUT_FRACTION;

  return (
    assumedInputTokens * pricing.inputCostPerToken +
    assumedOutputTokens * pricing.outputCostPerToken
  );
}
