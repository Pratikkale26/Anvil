/**
 * Per-model token pricing (USD per million tokens).
 *
 * Centralized so every cost-estimate path sees the same numbers. Adding a
 * new model = one entry here. The estimator reaches into MODEL_PRICING via
 * `priceFor(modelId)` which falls back to a reasonable default when the
 * configured model isn't in the table — better to under-warn than crash on
 * a fresh model ID nobody updated the table for.
 *
 * Updated 2026-05-02 against published Anthropic prices. Keep in
 * sync with the model IDs documented in `api/src/ai/config.ts`.
 */

export interface ModelPricing {
  /** USD per 1M input tokens */
  inputPerM: number;
  /** USD per 1M output tokens */
  outputPerM: number;
  /** USD per 1M cache-write tokens (Anthropic prompt caching) */
  cacheWritePerM: number;
  /** USD per 1M cache-read tokens (Anthropic prompt caching) */
  cacheReadPerM: number;
}

const DEFAULT: ModelPricing = {
  inputPerM: 3,
  outputPerM: 15,
  cacheWritePerM: 3.75,
  cacheReadPerM: 0.3,
};

const MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic — Sonnet family
  "claude-sonnet-4-20250514": { inputPerM: 3, outputPerM: 15, cacheWritePerM: 3.75, cacheReadPerM: 0.3 },
  "claude-sonnet-4-6":        { inputPerM: 3, outputPerM: 15, cacheWritePerM: 3.75, cacheReadPerM: 0.3 },
  "claude-sonnet-4-7":        { inputPerM: 3, outputPerM: 15, cacheWritePerM: 3.75, cacheReadPerM: 0.3 },
  // Anthropic — Opus family
  "claude-opus-4-6":          { inputPerM: 15, outputPerM: 75, cacheWritePerM: 18.75, cacheReadPerM: 1.5 },
  "claude-opus-4-7":          { inputPerM: 15, outputPerM: 75, cacheWritePerM: 18.75, cacheReadPerM: 1.5 },
  // Anthropic — Haiku family
  "claude-haiku-4-5-20251001": { inputPerM: 1, outputPerM: 5, cacheWritePerM: 1.25, cacheReadPerM: 0.1 },
};

/**
 * Look up pricing for a given model ID. Falls back to Sonnet-class pricing
 * for unknown models so we don't fail closed (under-bill is better than
 * crash). Logs once per unknown model so operators can update the table.
 */
const warnedModels = new Set<string>();

export function priceFor(modelId: string): ModelPricing {
  const exact = MODEL_PRICING[modelId];
  if (exact) return exact;

  // Prefix match for date-suffixed variants we haven't pinned individually.
  for (const [key, value] of Object.entries(MODEL_PRICING)) {
    if (modelId.startsWith(key)) return value;
  }

  if (!warnedModels.has(modelId)) {
    warnedModels.add(modelId);
    console.warn(`[model-pricing] unknown model '${modelId}' — falling back to Sonnet-class defaults; update api/src/ai/model-pricing.ts to pin exact rates.`);
  }
  return DEFAULT;
}

export interface UsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export function estimateCostUsd(modelId: string, usage: UsageBreakdown): number {
  const p = priceFor(modelId);
  return (
    usage.inputTokens * p.inputPerM +
    usage.outputTokens * p.outputPerM +
    usage.cacheCreationTokens * p.cacheWritePerM +
    usage.cacheReadTokens * p.cacheReadPerM
  ) / 1_000_000;
}
