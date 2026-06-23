import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import type { OpenPricingTable, QualityPreferences, QualityScoresDocument } from './types.js';
import { QUALITY_PRESETS } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const DEFAULT_QUALITY_SCORES_PATH = path.join(ROOT, 'data', 'quality-scores.snapshot.json');
export const DEFAULT_OPEN_PRICING_PATH = path.join(ROOT, 'pricing', 'models-open.json');
export const DEFAULT_MODEL_ALIASES_PATH = path.join(ROOT, 'pricing', 'model-aliases.json');

export function loadQualityScores(scoresPath = DEFAULT_QUALITY_SCORES_PATH): QualityScoresDocument {
  return JSON.parse(fs.readFileSync(scoresPath, 'utf-8')) as QualityScoresDocument;
}

export function loadOpenPricing(pricingPath = DEFAULT_OPEN_PRICING_PATH): OpenPricingTable {
  return JSON.parse(fs.readFileSync(pricingPath, 'utf-8')) as OpenPricingTable;
}

export function loadModelAliases(aliasesPath = DEFAULT_MODEL_ALIASES_PATH): Record<string, string[]> {
  const data = JSON.parse(fs.readFileSync(aliasesPath, 'utf-8')) as { aliases: Record<string, string[]> };
  return data.aliases;
}

export function resolveQualityPreferences(prefs: QualityPreferences = {}) {
  const preset = prefs.preset ? QUALITY_PRESETS[prefs.preset] : QUALITY_PRESETS.balanced;
  return {
    quality_floor_pct: prefs.quality_floor_pct ?? preset.quality_floor_pct,
    quality_sacrifice_per_cost: prefs.quality_sacrifice_per_cost ?? preset.quality_sacrifice_per_cost,
    preset: prefs.preset ?? 'balanced',
  };
}

/** Map a telemetry/pricing model id to a quality-scores matrix key. */
export function resolveQualityModelId(
  modelId: string,
  aliases: Record<string, string[]>,
  scores: QualityScoresDocument,
): string | undefined {
  const direct = scores.models[modelId];
  if (direct) return modelId;

  const lower = modelId.toLowerCase();
  for (const [key, entry] of Object.entries(scores.models)) {
    if (key.toLowerCase() === lower) return key;
    if (entry.display_name?.toLowerCase() === lower) return key;
    if (entry.oll_id?.toLowerCase() === lower) return key;
  }

  const aliasHits = aliases[modelId] ?? aliases[lower];
  if (aliasHits) {
    for (const candidate of aliasHits) {
      const resolved = resolveQualityModelId(candidate, {}, scores);
      if (resolved) return resolved;
    }
  }

  for (const [key] of Object.entries(scores.models)) {
    if (key.toLowerCase().includes(lower) || lower.includes(key.toLowerCase())) {
      return key;
    }
  }

  return undefined;
}

/**
 * Returns the quality score for a model scoped to the active task metrics.
 * - Single active metric → direct lookup of that metric's score.
 * - Multiple active metrics → weighted blend of only those metrics (proportional to classifier scores).
 * - No active metrics → null.
 */
export function taskQualityScore(
  modelKey: string,
  metricWeights: Record<string, number>,
  scores: QualityScoresDocument,
): number | null {
  const entry = scores.models[modelKey];
  if (!entry) return null;

  const activeEntries = Object.entries(metricWeights).filter(([, w]) => w > 0);

  // Single metric: direct lookup, no blending
  if (activeEntries.length === 1) {
    const value = entry.scores[activeEntries[0][0]];
    return value ?? null;
  }

  // Multiple metrics: weighted blend of active metrics only
  let totalWeight = 0;
  let totalScore = 0;
  for (const [metricId, weight] of activeEntries) {
    const value = entry.scores[metricId];
    if (value == null) continue;
    totalWeight += weight;
    totalScore += weight * value;
  }

  return totalWeight === 0 ? null : totalScore / totalWeight;
}

/** @deprecated Use taskQualityScore — blends only active task metrics, not all metrics. */
export function weightedQualityScore(
  modelKey: string,
  metricWeights: Record<string, number>,
  scores: QualityScoresDocument,
): number | null {
  return taskQualityScore(modelKey, metricWeights, scores);
}
