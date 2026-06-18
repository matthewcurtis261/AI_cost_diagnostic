import { assessConfidence, confidenceMismatch, isDependencyOnly } from './confidence.js';
import { findDuplicateGroups } from './dedup.js';
import { reconcileSummary } from './reconcile.js';
import type { FindingsDocument, ValidationIssue } from './types.js';

export interface SemanticValidationOptions {
  strict?: boolean;
}

export function validateSemantics(
  doc: FindingsDocument,
  options: SemanticValidationOptions = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { findings, summary, scan_metadata } = doc;

  // Unique finding ids
  const ids = new Set<string>();
  for (const f of findings) {
    if (ids.has(f.id)) {
      issues.push({
        severity: 'error',
        code: 'duplicate_id',
        message: `Duplicate finding id: ${f.id}`,
        finding_id: f.id,
      });
    }
    ids.add(f.id);
  }

  // Evidence required (non-empty handled by schema)
  for (const f of findings) {
    if (f.evidence.length < 8) {
      issues.push({
        severity: 'warning',
        code: 'short_evidence',
        message: `Evidence snippet very short for ${f.id}`,
        finding_id: f.id,
      });
    }
  }

  // Confidence rubric
  for (const f of findings) {
    if (confidenceMismatch(f)) {
      const { suggested, reasons } = assessConfidence(f);
      issues.push({
        severity: 'warning',
        code: 'confidence_mismatch',
        message: `${f.id} confidence is "${f.confidence}" but rubric suggests "${suggested}" (${reasons.join('; ')})`,
        finding_id: f.id,
      });
    }

    if (isDependencyOnly(f) && f.confidence === 'high' && f.call_type === 'agent_framework') {
      issues.push({
        severity: 'info',
        code: 'dependency_high_confidence',
        message: `${f.id} is dependency-only; high confidence is acceptable for manifest evidence`,
        finding_id: f.id,
      });
    }
  }

  // Duplicate call sites
  for (const group of findDuplicateGroups(findings)) {
    issues.push({
      severity: 'warning',
      code: 'duplicate_call_site',
      message: `Possible duplicate call sites at ${group.key}: ${group.finding_ids.join(', ')}. ${group.recommendation}`,
    });
  }

  // Summary consistency
  const reconciled = reconcileSummary(findings);
  const providerSet = new Set(summary.providers);
  for (const p of reconciled.providers) {
    if (!providerSet.has(p)) {
      issues.push({
        severity: 'warning',
        code: 'summary_provider_missing',
        message: `summary.providers missing "${p}" present in findings`,
        path: 'summary.providers',
      });
    }
  }
  for (const p of summary.providers) {
    if (!reconciled.providers.includes(p)) {
      issues.push({
        severity: 'warning',
        code: 'summary_provider_extra',
        message: `summary.providers lists "${p}" with no matching finding`,
        path: 'summary.providers',
      });
    }
  }

  if (summary.likely_dynamic_models !== reconciled.likely_dynamic_models) {
    issues.push({
      severity: 'warning',
      code: 'summary_dynamic_count',
      message: `likely_dynamic_models is ${summary.likely_dynamic_models} but findings imply ${reconciled.likely_dynamic_models}`,
      path: 'summary.likely_dynamic_models',
    });
  }

  // Coverage self-report
  if (!summary.coverage_notes?.length && !summary.coverage) {
    issues.push({
      severity: 'warning',
      code: 'missing_coverage',
      message: 'No coverage_notes or summary.coverage — document exclusions and blind spots',
      path: 'summary',
    });
  }

  if (
    (scan_metadata.excluded_paths?.length ?? 0) > 0 &&
    !summary.coverage_notes?.some((n) => n.toLowerCase().includes('exclud'))
  ) {
    issues.push({
      severity: 'warning',
      code: 'excluded_paths_not_documented',
      message: 'scan_metadata.excluded_paths set but not reflected in coverage_notes',
      path: 'summary.coverage_notes',
    });
  }

  if (options.strict) {
    return issues.map((i) =>
      i.severity === 'warning' || i.severity === 'info'
        ? { ...i, severity: 'error' as const }
        : i,
    );
  }

  return issues;
}

export function hasErrors(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

export function formatIssues(issues: ValidationIssue[]): string[] {
  return issues.map((i) => `[${i.severity}] ${i.code}: ${i.message}`);
}
