export type JobStatus = 'idle' | 'running' | 'done' | 'error'
export type QualityPreset = 'conservative' | 'balanced' | 'aggressive'

export interface AppState {
  repoPath: string | null
  scanStatus: JobStatus
  estimateStatus: JobStatus
  analyzeStatus: JobStatus
  scanError: string | null
  estimateError: string | null
  analyzeError: string | null
  diagnosisStatus: JobStatus
  diagnosisError: string | null
  instrumentStatus: JobStatus
  instrumentError: string | null
  telemetryExpiresAt: string | null
  telemetryRemoveAt: string | null
  lastPreset: string
  hasFindings: boolean
  hasEstimate: boolean
  hasAnalysis: boolean
  hasEvents: boolean
  hasAgentReport: boolean
  agentScanStatus: JobStatus
  agentScanError: string | null
}

export interface Finding {
  id: string
  provider: string
  model: string
  call_type: 'chat_completion' | 'embedding' | 'image' | 'speech' | 'agent_framework'
  location: { file: string; lines: number[] }
  confidence: 'high' | 'medium' | 'low'
  evidence: string
  wrapper?: string
  env_refs?: string[]
  notes?: string
}

export interface FindingsDocument {
  scan_metadata: {
    scanned_at: string
    repo_path: string
    scanner_version: string
    scan_mode: string
    scope: string[]
  }
  findings: Finding[]
  summary: {
    total: number
    billable: number
    by_provider: Record<string, number>
    by_confidence: Record<string, number>
    by_call_type: Record<string, number>
    coverage_notes: string[]
  }
}

export interface EstimateLineItem {
  finding_id: string
  provider: string
  model: string
  call_type: string
  location: { file: string; lines: number[] }
  usage: {
    calls: number
    input_tokens: number
    output_tokens: number
    source: 'telemetry' | 'assumed' | 'mixed'
  }
  cost: {
    input_usd: number
    output_usd: number
    total_usd: number
  }
  pricing_model_resolved: string
}

export interface SavingsOpportunity {
  finding_id: string
  current_model: string
  alternative_model: string
  current_total_usd: number
  alternative_total_usd: number
  savings_usd: number
  savings_percent: number
  compatible: boolean
}

export interface EstimateReport {
  estimate_metadata: {
    generated_at: string
    mode: 'code_only' | 'telemetry'
    pricing_as_of: string
    currency: 'USD'
    period: string
  }
  line_items: EstimateLineItem[]
  totals: {
    calls: number
    input_tokens: number
    output_tokens: number
    total_usd: number
    source: string
  }
  savings_opportunities: SavingsOpportunity[]
  coverage_notes: string[]
}

export interface InputAnalysisItem {
  event_id: string
  timestamp: string
  finding_id?: string
  provider: string
  model: string
  call_type: string
  tokens: { input_tokens: number; output_tokens: number }
  current_cost_usd: number
  current_quality: number | null
  classification: {
    metric_ids: string[]
    primary_metric?: string
    scores: Record<string, number>
  }
  recommendation: {
    alternative_model: string
    alternative_cost_usd: number
    savings_usd: number
    savings_percent: number
    alternative_quality: number | null
    quality_delta: number | null
    passes_quality_floor: boolean
  } | null
  skipped_reason?: string
}

export interface AnalyzeInputsReport {
  analysis_metadata: {
    generated_at: string
    quality_preset: QualityPreset
    quality_floor_pct: number
    events_source: string
    pricing_as_of: string
  }
  items: InputAnalysisItem[]
  summary: {
    events_total: number
    events_analyzed: number
    events_with_recommendations: number
    events_skipped: number
    total_current_usd: number
    total_potential_savings_usd: number
    by_alternative_model: Record<string, { count: number; savings_usd: number }>
  }
  coverage_notes: string[]
}

export interface NanoclawStatus {
  socketExists: boolean
  responding: boolean
  ready: boolean
  socketPath: string
}

export interface AgentTrendBucket {
  date: string
  inputTokens: number
  outputTokens: number
  costUsd: number
  sessions: number
}

export interface AgentProjectSummary {
  label: string
  tool: 'nanoclaw' | 'claude-code'
  sessions: number
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  costUsd: number
}

export interface AgentModelSummary {
  sessions: number
  inputTokens: number
  outputTokens: number
  costUsd: number
}

export interface AgentReport {
  scanned_at: string
  totals: {
    sessions: number
    messages: number
    inputTokens: number
    outputTokens: number
    cacheCreationTokens: number
    cacheReadTokens: number
    costUsd: number
  }
  by_project: Record<string, AgentProjectSummary>
  by_model: Record<string, AgentModelSummary>
  by_tool: Record<string, { sessions: number; costUsd: number }>
  trend: AgentTrendBucket[]
  potential_savings: {
    if_downgrade_to_haiku: { savingsUsd: number; savingsPct: number }
  }
}
