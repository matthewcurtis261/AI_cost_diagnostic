export const ESTIMATE_SCHEMA_VERSION = '0.1.0';

export type EstimateMode = 'code_only' | 'telemetry';
export type UsageSource = 'telemetry' | 'assumed' | 'mixed';

export interface FindingLocation {
  file: string;
  lines: number[];
}

export interface Finding {
  id: string;
  provider: string;
  model: string;
  call_type: string;
  location: FindingLocation;
  confidence: string;
  evidence: string;
  wrapper?: string;
  notes?: string;
}

export interface FindingsDocument {
  scan_metadata: {
    repo_path: string;
    scanned_at: string;
    schema_version: string;
  };
  findings: Finding[];
  summary: {
    providers: string[];
    models_detected: string[];
    likely_dynamic_models: number;
    call_types?: string[];
    coverage_notes?: string[];
  };
}

export interface TelemetryEvent {
  event_id: string;
  timestamp: string;
  finding_id?: string;
  call_site_fingerprint?: string;
  provider: string;
  model: string;
  call_type: string;
  tokens: {
    input_tokens: number;
    output_tokens: number;
    total_tokens?: number;
    source: string;
  };
}

export interface ModelPricing {
  provider: string;
  call_types: string[];
  input_per_million: number;
  output_per_million: number;
}

export interface PricingTable {
  schema_version: string;
  currency: string;
  unit: string;
  as_of: string;
  models: Record<string, ModelPricing>;
  default_alternatives?: Record<string, string[]>;
}

export interface UsageAssumptions {
  avg_input_tokens?: number;
  avg_output_tokens?: number;
  calls_per_month?: number;
  model?: string;
}

export interface AssumptionsFile {
  defaults?: UsageAssumptions;
  findings?: Record<string, UsageAssumptions>;
}

export interface UsageBreakdown {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  source: UsageSource;
}

export interface CostBreakdown {
  input_usd: number;
  output_usd: number;
  total_usd: number;
}

export interface EstimateLineItem {
  finding_id: string;
  provider: string;
  model: string;
  call_type: string;
  location: FindingLocation;
  usage: UsageBreakdown;
  cost: CostBreakdown;
  pricing_model_resolved: string;
  notes?: string[];
}

export interface SavingsOpportunity {
  finding_id: string;
  current_model: string;
  alternative_model: string;
  current_total_usd: number;
  alternative_total_usd: number;
  savings_usd: number;
  savings_percent: number;
  compatible: boolean;
  notes?: string[];
}

export interface EstimateReport {
  estimate_metadata: {
    generated_at: string;
    schema_version: typeof ESTIMATE_SCHEMA_VERSION;
    mode: EstimateMode;
    findings_source: string;
    events_source?: string;
    pricing_as_of: string;
    currency: string;
    period: 'month' | 'day' | 'event_window';
  };
  line_items: EstimateLineItem[];
  totals: UsageBreakdown & { total_usd: number };
  savings_opportunities: SavingsOpportunity[];
  coverage_notes: string[];
}

export interface EstimateOptions {
  findingsPath: string;
  eventsPath?: string;
  outputPath?: string;
  assumptionsPath?: string;
  pricingPath?: string;
  callsPerMonth?: number;
  defaultModel?: string;
  alternatives?: string[];
  since?: string;
  until?: string;
  period?: 'month' | 'day' | 'event_window';
}
