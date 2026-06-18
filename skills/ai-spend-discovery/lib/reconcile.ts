import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { buildCoverageReport, mergeCoverageNotes } from './coverage.js';
import { dedupeFindings } from './dedup.js';
import type { Finding, FindingsDocument, FindingsSummary } from './types.js';

const STATIC_MODELS = new Set(['dynamic', 'config_ref', 'unknown']);

/** Recompute summary fields from findings list. */
export function reconcileSummary(
  findings: Finding[],
  existing?: Partial<FindingsSummary>,
): FindingsSummary {
  const providers = [...new Set(findings.map((f) => f.provider))].sort();
  const models = [
    ...new Set(
      findings
        .map((f) => f.model)
        .filter((m) => m && !STATIC_MODELS.has(m)),
    ),
  ].sort();
  const likelyDynamic = findings.filter(
    (f) => f.model === 'dynamic' || f.model === 'config_ref',
  ).length;
  const callTypes = [...new Set(findings.map((f) => f.call_type))].sort();

  return {
    providers,
    models_detected: models,
    likely_dynamic_models: likelyDynamic,
    call_types: callTypes,
    coverage_notes: existing?.coverage_notes,
    coverage: existing?.coverage,
  };
}

/** Normalize findings: dedupe, reconcile summary, enrich coverage. */
export function normalizeFindings(doc: FindingsDocument): FindingsDocument {
  const deduped = dedupeFindings(doc.findings);
  const summary = reconcileSummary(deduped, doc.summary);
  const coverage = buildCoverageReport({ ...doc, findings: deduped, summary });
  summary.coverage = coverage;
  summary.coverage_notes = mergeCoverageNotes({
    ...doc,
    findings: deduped,
    summary,
  });

  const exclusions = doc.scan_metadata.exclusions ?? coverage.excluded;

  return {
    scan_metadata: {
      ...doc.scan_metadata,
      exclusions,
    },
    findings: renumberFindings(deduped),
    summary,
  };
}

export function renumberFindings(findings: Finding[]): Finding[] {
  return findings.map((f, i) => ({
    ...f,
    id: `f${String(i + 1).padStart(3, '0')}`,
  }));
}

export function loadPatternsExcludeDirs(): string[] {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const patternsPath = path.join(__dirname, '..', 'patterns', 'providers.json');
  const data = JSON.parse(fs.readFileSync(patternsPath, 'utf-8')) as {
    exclude_dirs?: string[];
  };
  return data.exclude_dirs ?? [];
}
