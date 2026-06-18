export const QUALITY_SCORES_SCHEMA_VERSION = '0.1.0';

export interface QualityMetricDef {
  id: string;
  label: string;
  benchmarks?: string[];
  score_kind?: string;
}

export interface QualityModelScores {
  display_name?: string;
  oll_id?: string;
  type?: 'proprietary' | 'open' | 'unknown';
  scores: Record<string, number | null>;
  score_sources?: Record<string, string>;
}

export interface QualityScoresDocument {
  schema_version: typeof QUALITY_SCORES_SCHEMA_VERSION;
  generated_at: string;
  sources: Array<{ id: string; url: string; fetched_at: string; notes?: string }>;
  metrics: QualityMetricDef[];
  normalization?: Record<string, unknown>;
  models: Record<string, QualityModelScores>;
  coverage?: {
    total_models: number;
    metrics_with_data: Record<string, number>;
    notes?: string[];
  };
}

export interface OpenModelPricing {
  provider: string;
  deployment: 'api' | 'self_hosted';
  call_types: string[];
  input_per_million: number;
  output_per_million: number;
  api_via?: string;
  quality_score_key?: string;
}

export interface OpenPricingTable {
  schema_version: string;
  currency: string;
  unit: string;
  as_of: string;
  notes?: string;
  self_hosted_compute: {
    input_per_million: number;
    output_per_million: number;
    notes?: string;
  };
  models: Record<string, OpenModelPricing>;
}

export type QualityPreset = 'conservative' | 'balanced' | 'aggressive';

export interface QualityPreferences {
  preset?: QualityPreset;
  quality_floor_pct?: number;
  quality_sacrifice_per_cost?: number;
}

export const QUALITY_PRESETS: Record<
  QualityPreset,
  { quality_floor_pct: number; quality_sacrifice_per_cost: number }
> = {
  conservative: { quality_floor_pct: 0.95, quality_sacrifice_per_cost: 0.2 },
  balanced: { quality_floor_pct: 0.9, quality_sacrifice_per_cost: 0.5 },
  aggressive: { quality_floor_pct: 0.85, quality_sacrifice_per_cost: 1.0 },
};

export interface ClassifierPrediction {
  index: number;
  text_preview?: string;
  metric_ids: string[];
  scores: Record<string, number>;
  primary_metric?: string;
}

export interface ClassifierOutput {
  schema_version: '0.1.0';
  model: {
    base: string;
    weights_path: string;
    label_count: number;
    threshold?: number;
    runtime_mode?: 'distilbert_head' | 'keyword_lexicon' | 'keyword_fallback';
  };
  predictions: ClassifierPrediction[];
  warnings?: string[];
}

export interface ClassifyInputsOptions {
  weightsDir?: string;
  labelMapPath?: string;
  pythonPath?: string;
  forceFallback?: boolean;
  cwd?: string;
  timeoutMs?: number;
}

export const ANALYZE_INPUTS_SCHEMA_VERSION = '0.1.0';

export interface TelemetryEventWithInput {
  event_id: string;
  timestamp: string;
  schema_version?: string;
  finding_id?: string;
  call_site_fingerprint?: string;
  provider: string;
  model: string;
  call_type: string;
  input?: Record<string, unknown>;
  tokens: {
    input_tokens: number;
    output_tokens: number;
    total_tokens?: number;
    source?: string;
  };
  latency_ms?: number;
  metadata?: Record<string, unknown>;
}

export interface InputAnalysisRecommendation {
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

export interface InputAnalysisItem {
  event_id: string;
  timestamp: string;
  finding_id?: string;
  provider: string;
  model: string;
  call_type: string;
  tokens: {
    input_tokens: number;
    output_tokens: number;
  };
  current_cost_usd: number;
  current_quality: number | null;
  classification: {
    metric_ids: string[];
    primary_metric?: string;
    metric_weights: Record<string, number>;
    scores: Record<string, number>;
  };
  recommendation: InputAnalysisRecommendation | null;
  skipped_reason?: string;
}

export interface AnalyzeInputsSummary {
  events_total: number;
  events_analyzed: number;
  events_with_recommendations: number;
  events_skipped: number;
  total_current_usd: number;
  total_potential_savings_usd: number;
  by_alternative_model: Record<string, { count: number; savings_usd: number }>;
  by_primary_metric: Record<string, { count: number; savings_usd: number }>;
}

export interface AnalyzeInputsReport {
  analysis_metadata: {
    generated_at: string;
    schema_version: typeof ANALYZE_INPUTS_SCHEMA_VERSION;
    events_source: string;
    pricing_as_of: string;
    currency: string;
    quality_scores_generated_at?: string;
    quality_preset: string;
    quality_floor_pct: number;
    quality_sacrifice_per_cost: number;
    classifier_runtime?: string;
    pricing_sources?: string[];
  };
  items: InputAnalysisItem[];
  summary: AnalyzeInputsSummary;
  coverage_notes: string[];
}

export interface AnalyzeInputsOptions {
  eventsPath: string;
  outputPath?: string;
  since?: string;
  until?: string;
  pricingPath?: string;
  openPricingPath?: string;
  includeOpenPricing?: boolean;
  qualityScoresPath?: string;
  alternatives?: string[];
  qualityPreferences?: QualityPreferences;
  classifierOptions?: ClassifyInputsOptions;
}
