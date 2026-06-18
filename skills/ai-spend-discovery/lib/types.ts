export const FINDINGS_SCHEMA_VERSION = '0.1.0';

export type Confidence = 'high' | 'medium' | 'low';

export type CallType =
  | 'chat_completion'
  | 'embedding'
  | 'image'
  | 'speech'
  | 'agent_framework'
  | 'unknown';

export type ExclusionCategory =
  | 'standard_exclude'
  | 'mount_blocked'
  | 'user_scope'
  | 'binary_or_generated'
  | 'other';

export interface FindingLocation {
  file: string;
  lines: number[];
}

export interface Finding {
  id: string;
  provider: string;
  model: string;
  call_type: CallType | string;
  location: FindingLocation;
  confidence: Confidence | string;
  evidence: string;
  wrapper?: string;
  env_refs?: string[];
  notes?: string;
}

export interface ExclusionEntry {
  path: string;
  reason: string;
  category: ExclusionCategory;
}

export interface CoverageReport {
  scan_mode: 'full' | 'scoped' | 'partial';
  excluded: ExclusionEntry[];
  blind_spots: string[];
  files_scanned?: number;
  passes_completed?: string[];
}

export interface FindingsSummary {
  providers: string[];
  models_detected: string[];
  likely_dynamic_models: number;
  call_types?: string[];
  coverage_notes?: string[];
  coverage?: CoverageReport;
}

export interface ScanMetadata {
  repo_path: string;
  repo_mount_name?: string;
  scope?: string[];
  scanned_at: string;
  schema_version: string;
  files_scanned?: number;
  agent_version?: string;
  excluded_paths?: string[];
  exclusions?: ExclusionEntry[];
}

export interface FindingsDocument {
  scan_metadata: ScanMetadata;
  findings: Finding[];
  summary: FindingsSummary;
}

export type ValidationSeverity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  message: string;
  finding_id?: string;
  path?: string;
}
