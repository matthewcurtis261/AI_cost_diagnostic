import fs from 'fs';

import { loadPricingTable, calculateCost, getModelPricing, roundUsd } from '../../estimate/lib/pricing.js';
import type { PricingTable } from '../../estimate/lib/types.js';
import {
  classifyTexts,
  extractInputText,
  metricWeightsFromPrediction,
} from './classifier.js';
import { pickBestAlternative, taskQualityForModel } from './recommendation.js';
import {
  loadModelAliases,
  loadQualityScores,
  resolveQualityPreferences,
} from './quality-scores.js';
import type {
  AnalyzeInputsOptions,
  AnalyzeInputsReport,
  AnalyzeInputsSummary,
  InputAnalysisItem,
  TelemetryEventWithInput,
} from './types.js';

interface FilterOptions {
  since?: string;
  until?: string;
}

export function loadTelemetryEventsWithInput(eventsPath: string): TelemetryEventWithInput[] {
  const content = fs.readFileSync(eventsPath, 'utf-8');
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TelemetryEventWithInput);
}

export function filterEventsByTime(
  events: TelemetryEventWithInput[],
  options: FilterOptions = {},
): TelemetryEventWithInput[] {
  const sinceMs = options.since ? Date.parse(options.since) : undefined;
  const untilMs = options.until ? Date.parse(options.until) : undefined;

  return events.filter((event) => {
    const ts = Date.parse(event.timestamp);
    if (sinceMs !== undefined && ts < sinceMs) return false;
    if (untilMs !== undefined && ts > untilMs) return false;
    return true;
  });
}

function buildSummary(items: InputAnalysisItem[]): AnalyzeInputsSummary {
  const byAlternative: AnalyzeInputsSummary['by_alternative_model'] = {};
  const byMetric: AnalyzeInputsSummary['by_primary_metric'] = {};

  let eventsAnalyzed = 0;
  let eventsWithRecommendations = 0;
  let eventsSkipped = 0;
  let totalCurrentUsd = 0;
  let totalPotentialSavingsUsd = 0;

  for (const item of items) {
    if (item.skipped_reason) {
      eventsSkipped += 1;
      continue;
    }

    eventsAnalyzed += 1;
    totalCurrentUsd = roundUsd(totalCurrentUsd + item.current_cost_usd);

    if (!item.recommendation) continue;

    eventsWithRecommendations += 1;
    totalPotentialSavingsUsd = roundUsd(
      totalPotentialSavingsUsd + item.recommendation.savings_usd,
    );

    const alt = item.recommendation.alternative_model;
    byAlternative[alt] ??= { count: 0, savings_usd: 0 };
    byAlternative[alt].count += 1;
    byAlternative[alt].savings_usd = roundUsd(
      byAlternative[alt].savings_usd + item.recommendation.savings_usd,
    );

    const metric = item.classification.primary_metric ?? 'unknown';
    byMetric[metric] ??= { count: 0, savings_usd: 0 };
    byMetric[metric].count += 1;
    byMetric[metric].savings_usd = roundUsd(
      byMetric[metric].savings_usd + item.recommendation.savings_usd,
    );
  }

  return {
    events_total: items.length,
    events_analyzed: eventsAnalyzed,
    events_with_recommendations: eventsWithRecommendations,
    events_skipped: eventsSkipped,
    total_current_usd: roundUsd(totalCurrentUsd),
    total_potential_savings_usd: roundUsd(totalPotentialSavingsUsd),
    by_alternative_model: byAlternative,
    by_primary_metric: byMetric,
  };
}

export function buildAnalyzeInputsReport(
  events: TelemetryEventWithInput[],
  options: AnalyzeInputsOptions,
  pricing?: PricingTable,
): AnalyzeInputsReport {
  const coverageNotes: string[] = [];
  const pricingTable =
    pricing ??
    loadPricingTable(options.pricingPath, {
      openPricingPath: options.openPricingPath,
      includeOpenPricing: options.includeOpenPricing,
    });

  const scores = loadQualityScores(options.qualityScoresPath);
  const aliases = loadModelAliases();
  const preferences = resolveQualityPreferences(options.qualityPreferences ?? {});

  const classifiable = events.filter((event) => event.input && typeof event.input === 'object');
  if (classifiable.length < events.length) {
    coverageNotes.push(
      `${events.length - classifiable.length} event(s) skipped: missing input payload for classification`,
    );
  }

  const texts = classifiable.map((event) => extractInputText(event.input!));
  const classification =
    texts.length > 0
      ? classifyTexts(texts, options.classifierOptions)
      : {
          schema_version: '0.1.0' as const,
          model: {
            base: 'distilbert-base-uncased',
            weights_path: '',
            label_count: 20,
          },
          predictions: [],
          warnings: [],
        };

  if (classification.warnings?.length) {
    coverageNotes.push(...classification.warnings);
  }

  const items: InputAnalysisItem[] = [];

  for (const event of events) {
    if (!event.input || typeof event.input !== 'object') {
      items.push({
        event_id: event.event_id,
        timestamp: event.timestamp,
        finding_id: event.finding_id,
        provider: event.provider,
        model: event.model,
        call_type: event.call_type,
        tokens: {
          input_tokens: event.tokens.input_tokens,
          output_tokens: event.tokens.output_tokens,
        },
        current_cost_usd: 0,
        current_quality: null,
        classification: {
          metric_ids: [],
          metric_weights: {},
          scores: {},
        },
        recommendation: null,
        skipped_reason: 'missing_input_payload',
      });
      continue;
    }

    const classIndex = classifiable.indexOf(event);
    const prediction = classification.predictions[classIndex];
    const metricWeights = prediction ? metricWeightsFromPrediction(prediction) : {};

    if (!prediction || prediction.metric_ids.length === 0) {
      coverageNotes.push(`Event ${event.event_id}: classifier returned no active metrics`);
    }

    const modelPricing = getModelPricing(pricingTable, event.model);
    const currentCost = calculateCost(
      event.tokens.input_tokens,
      event.tokens.output_tokens,
      modelPricing,
      event.tokens.cache_creation_tokens ?? 0,
      event.tokens.cache_read_tokens ?? 0,
    );

    if (!modelPricing) {
      coverageNotes.push(`No pricing entry for model "${event.model}" (${event.event_id})`);
    }

    const currentQuality = taskQualityForModel(
      event.model,
      metricWeights,
      pricingTable,
      { scores, aliases },
    );

    const recommendation = pickBestAlternative(
      event.model,
      event.call_type,
      event.tokens.input_tokens,
      event.tokens.output_tokens,
      event.tokens.cache_creation_tokens ?? 0,
      event.tokens.cache_read_tokens ?? 0,
      pricingTable,
      {
        metricWeights,
        scores,
        aliases,
        preferences,
      },
      options.alternatives,
    );

    items.push({
      event_id: event.event_id,
      timestamp: event.timestamp,
      finding_id: event.finding_id,
      provider: event.provider,
      model: event.model,
      call_type: event.call_type,
      tokens: {
        input_tokens: event.tokens.input_tokens,
        output_tokens: event.tokens.output_tokens,
      },
      current_cost_usd: currentCost.total_usd,
      current_quality: currentQuality,
      classification: {
        metric_ids: prediction?.metric_ids ?? [],
        primary_metric: prediction?.primary_metric,
        metric_weights: metricWeights,
        scores: prediction?.scores ?? {},
      },
      recommendation: recommendation
        ? {
            alternative_model: recommendation.alternative_model,
            alternative_cost_usd: recommendation.alternative_cost_usd,
            savings_usd: recommendation.savings_usd,
            savings_percent: recommendation.savings_percent,
            alternative_quality: recommendation.alternative_quality,
            quality_delta: recommendation.quality_delta,
            quality_floor: recommendation.quality_floor,
            passes_quality_floor: recommendation.passes_quality_floor,
            passes_sacrifice_tradeoff: recommendation.passes_sacrifice_tradeoff,
            notes: recommendation.notes,
          }
        : null,
      skipped_reason: undefined,
    });
  }

  return {
    analysis_metadata: {
      generated_at: new Date().toISOString(),
      schema_version: '0.1.0',
      events_source: options.eventsPath,
      pricing_as_of: pricingTable.as_of,
      currency: pricingTable.currency,
      quality_scores_generated_at: scores.generated_at,
      quality_preset: preferences.preset,
      quality_floor_pct: preferences.quality_floor_pct,
      quality_sacrifice_per_cost: preferences.quality_sacrifice_per_cost,
      classifier_runtime: classification.model.runtime_mode,
      pricing_sources: pricingTable.pricing_sources,
    },
    items,
    summary: buildSummary(items),
    coverage_notes: coverageNotes,
  };
}

export function analyzeInputs(options: AnalyzeInputsOptions): AnalyzeInputsReport {
  const allEvents = loadTelemetryEventsWithInput(options.eventsPath);
  const filtered = filterEventsByTime(allEvents, {
    since: options.since,
    until: options.until,
  });

  if (filtered.length === 0) {
    return {
      analysis_metadata: {
        generated_at: new Date().toISOString(),
        schema_version: '0.1.0',
        events_source: options.eventsPath,
        pricing_as_of: '',
        currency: 'USD',
        quality_preset: resolveQualityPreferences(options.qualityPreferences).preset,
        quality_floor_pct: resolveQualityPreferences(options.qualityPreferences).quality_floor_pct,
        quality_sacrifice_per_cost: resolveQualityPreferences(options.qualityPreferences)
          .quality_sacrifice_per_cost,
      },
      items: [],
      summary: {
        events_total: 0,
        events_analyzed: 0,
        events_with_recommendations: 0,
        events_skipped: 0,
        total_current_usd: 0,
        total_potential_savings_usd: 0,
        by_alternative_model: {},
        by_primary_metric: {},
      },
      coverage_notes: ['No telemetry events matched the requested time window'],
    };
  }

  return buildAnalyzeInputsReport(filtered, options);
}
