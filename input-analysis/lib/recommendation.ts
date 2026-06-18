import type { ModelPricing, PricingTable } from '../../estimate/lib/types.js';
import {
  calculateCost,
  getModelPricing,
  roundUsd,
  supportsCallType,
} from '../../estimate/lib/pricing.js';
import type { QualityScoresDocument } from './types.js';
import { resolveQualityModelId, weightedQualityScore } from './quality-scores.js';

export interface ResolvedQualityPreferences {
  preset: string;
  quality_floor_pct: number;
  quality_sacrifice_per_cost: number;
}

export interface QualityEvalContext {
  metricWeights: Record<string, number>;
  scores: QualityScoresDocument;
  aliases: Record<string, string[]>;
  preferences: ResolvedQualityPreferences;
}

export interface AlternativeEvaluation {
  alternative_model: string;
  alternative_cost_usd: number;
  savings_usd: number;
  savings_percent: number;
  alternative_quality: number | null;
  quality_delta: number | null;
  quality_floor: number | null;
  passes_quality_floor: boolean;
  passes_sacrifice_tradeoff: boolean;
  notes?: string[];
}

function resolveAlternatives(
  callType: string,
  currentModel: string,
  pricing: PricingTable,
  explicitAlternatives?: string[],
): string[] {
  const pool =
    explicitAlternatives && explicitAlternatives.length > 0
      ? explicitAlternatives
      : (pricing.default_alternatives?.[callType] ?? []);

  return pool.filter((model) => model !== currentModel);
}

export function resolveModelQualityKey(
  pricingModelId: string,
  modelPricing: ModelPricing | undefined,
  aliases: Record<string, string[]>,
  scores: QualityScoresDocument,
): string | undefined {
  if (modelPricing?.quality_score_key) {
    const fromKey = resolveQualityModelId(modelPricing.quality_score_key, aliases, scores);
    if (fromKey) return fromKey;
  }
  return resolveQualityModelId(pricingModelId, aliases, scores);
}

export function blendedQualityForModel(
  pricingModelId: string,
  metricWeights: Record<string, number>,
  pricing: PricingTable,
  ctx: Pick<QualityEvalContext, 'scores' | 'aliases'>,
): number | null {
  const modelPricing = getModelPricing(pricing, pricingModelId);
  const qualityKey = resolveModelQualityKey(pricingModelId, modelPricing, ctx.aliases, ctx.scores);
  if (!qualityKey) return null;
  return weightedQualityScore(qualityKey, metricWeights, ctx.scores);
}

export function evaluateAlternative(
  currentModel: string,
  alternativeModel: string,
  callType: string,
  inputTokens: number,
  outputTokens: number,
  currentQuality: number | null,
  bestQuality: number | null,
  pricing: PricingTable,
  ctx: QualityEvalContext,
): AlternativeEvaluation | null {
  const altPricing = getModelPricing(pricing, alternativeModel);
  if (!altPricing || !supportsCallType(altPricing, callType)) {
    return null;
  }

  const currentPricing = getModelPricing(pricing, currentModel);
  const currentCost = calculateCost(inputTokens, outputTokens, currentPricing);
  const altCost = calculateCost(inputTokens, outputTokens, altPricing);
  const savingsUsd = roundUsd(currentCost.total_usd - altCost.total_usd);
  const savingsPercent =
    currentCost.total_usd > 0 ? roundUsd((savingsUsd / currentCost.total_usd) * 100) : 0;

  if (savingsUsd <= 0) return null;

  const altQuality = blendedQualityForModel(alternativeModel, ctx.metricWeights, pricing, ctx);
  const qualityFloor =
    bestQuality != null ? roundUsd(bestQuality * ctx.preferences.quality_floor_pct) : null;

  const baselineQuality = currentQuality ?? bestQuality;
  const qualityDelta =
    baselineQuality != null && altQuality != null
      ? roundUsd(baselineQuality - altQuality)
      : null;

  const passesFloor =
    qualityFloor == null || altQuality == null ? altQuality != null : altQuality >= qualityFloor;

  const acceptableLoss =
    (savingsPercent / 100) * ctx.preferences.quality_sacrifice_per_cost;
  const passesSacrifice =
    qualityDelta == null ? true : qualityDelta <= acceptableLoss + 1e-9;

  const notes: string[] = [];
  if (altPricing.deployment === 'self_hosted') {
    notes.push('Self-hosted compute baseline ($0.20/Mtok in+out)');
  } else if (altPricing.api_via) {
    notes.push(`API via ${altPricing.api_via}`);
  }

  return {
    alternative_model: alternativeModel,
    alternative_cost_usd: altCost.total_usd,
    savings_usd: savingsUsd,
    savings_percent: savingsPercent,
    alternative_quality: altQuality,
    quality_delta: qualityDelta,
    quality_floor: qualityFloor,
    passes_quality_floor: passesFloor,
    passes_sacrifice_tradeoff: passesSacrifice,
    notes: notes.length > 0 ? notes : undefined,
  };
}

export function pickBestAlternative(
  currentModel: string,
  callType: string,
  inputTokens: number,
  outputTokens: number,
  pricing: PricingTable,
  ctx: QualityEvalContext,
  explicitAlternatives?: string[],
): AlternativeEvaluation | null {
  const candidates = resolveAlternatives(callType, currentModel, pricing, explicitAlternatives);
  const currentQuality = blendedQualityForModel(currentModel, ctx.metricWeights, pricing, ctx);

  const qualityByModel = new Map<string, number | null>();
  qualityByModel.set(currentModel, currentQuality);

  for (const candidate of candidates) {
    qualityByModel.set(
      candidate,
      blendedQualityForModel(candidate, ctx.metricWeights, pricing, ctx),
    );
  }

  const knownQualities = [...qualityByModel.values()].filter((q): q is number => q != null);
  const bestQuality = knownQualities.length > 0 ? Math.max(...knownQualities) : null;

  const evaluations: AlternativeEvaluation[] = [];
  for (const candidate of candidates) {
    const evaluation = evaluateAlternative(
      currentModel,
      candidate,
      callType,
      inputTokens,
      outputTokens,
      currentQuality,
      bestQuality,
      pricing,
      ctx,
    );
    if (evaluation) evaluations.push(evaluation);
  }

  const passing = evaluations.filter(
    (e) => e.passes_quality_floor && e.passes_sacrifice_tradeoff,
  );

  if (passing.length === 0) return null;

  return passing.sort((a, b) => b.savings_usd - a.savings_usd)[0];
}
