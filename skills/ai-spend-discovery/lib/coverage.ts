import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import type {
  CoverageReport,
  ExclusionCategory,
  ExclusionEntry,
  FindingsDocument,
  ScanMetadata,
} from './types.js';

function loadExcludeDirs(): Set<string> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const patternsPath = path.join(__dirname, '..', 'patterns', 'providers.json');
  const data = JSON.parse(fs.readFileSync(patternsPath, 'utf-8')) as {
    exclude_dirs?: string[];
  };
  return new Set(data.exclude_dirs ?? []);
}

const STANDARD_EXCLUDES = loadExcludeDirs();

const STANDARD_REASONS: Record<string, { reason: string; category: ExclusionCategory }> = {
  node_modules: {
    reason: 'Third-party dependencies; not application source',
    category: 'standard_exclude',
  },
  '.git': { reason: 'Version control metadata', category: 'standard_exclude' },
  vendor: { reason: 'Vendored third-party code', category: 'standard_exclude' },
  dist: { reason: 'Build output', category: 'binary_or_generated' },
  build: { reason: 'Build output', category: 'binary_or_generated' },
  '.next': { reason: 'Next.js build cache', category: 'binary_or_generated' },
  venv: { reason: 'Python virtual environment', category: 'standard_exclude' },
  '.venv': { reason: 'Python virtual environment', category: 'standard_exclude' },
  __pycache__: { reason: 'Python bytecode cache', category: 'binary_or_generated' },
  coverage: { reason: 'Test coverage output', category: 'binary_or_generated' },
};

export function categorizeExclusion(path: string): ExclusionEntry {
  const base = path.split(/[/\\]/).pop() ?? path;
  const normalized = base.replace(/^\.\//, '');
  const match = STANDARD_REASONS[normalized] ?? STANDARD_REASONS[path];

  if (match) {
    return { path, ...match };
  }

  if (STANDARD_EXCLUDES.has(normalized) || STANDARD_EXCLUDES.has(path)) {
    return {
      path,
      reason: 'Standard scan exclusion',
      category: 'standard_exclude',
    };
  }

  if (path.includes('.env')) {
    return {
      path,
      reason: 'Environment files not mounted for security',
      category: 'mount_blocked',
    };
  }

  return {
    path,
    reason: 'Excluded from scan scope',
    category: 'other',
  };
}

export function buildExclusions(metadata: ScanMetadata): ExclusionEntry[] {
  if (metadata.exclusions?.length) {
    return metadata.exclusions;
  }

  const paths = metadata.excluded_paths ?? [];
  return paths.map(categorizeExclusion);
}

export function defaultBlindSpots(): string[] {
  return [
    'Runtime-only model selection (DB or feature flags)',
    'External microservices with LLM calls in unmounted repos',
    'Obfuscated or dynamically constructed API endpoints',
    '.env files and secret stores are not read — env var references in code only',
  ];
}

export function buildCoverageReport(doc: FindingsDocument): CoverageReport {
  const { scan_metadata, findings, summary } = doc;
  const scope = scan_metadata.scope ?? [];
  const dynamicCount = findings.filter(
    (f) => f.model === 'dynamic' || f.model === 'config_ref',
  ).length;

  const blindSpots = [...(summary.coverage?.blind_spots ?? defaultBlindSpots())];
  if (dynamicCount > 0 && !blindSpots.some((b) => b.includes('Runtime'))) {
    blindSpots.unshift(
      `${dynamicCount} call site(s) use runtime or config-backed model selection`,
    );
  }

  let scanMode: CoverageReport['scan_mode'] = 'full';
  if (scope.length > 0) scanMode = 'scoped';
  if (!scan_metadata.files_scanned || scan_metadata.files_scanned === 0) {
    scanMode = 'partial';
  }

  return {
    scan_mode: scanMode,
    excluded: buildExclusions(scan_metadata),
    blind_spots: blindSpots,
    files_scanned: scan_metadata.files_scanned,
    passes_completed: summary.coverage?.passes_completed ?? ['A', 'B', 'E'],
  };
}

export function mergeCoverageNotes(doc: FindingsDocument): string[] {
  const report = buildCoverageReport(doc);
  const notes = new Set(doc.summary.coverage_notes ?? []);

  if (report.scan_mode === 'scoped' && (doc.scan_metadata.scope?.length ?? 0) > 0) {
    notes.add(`Scoped scan: ${doc.scan_metadata.scope!.join(', ')}`);
  }

  for (const ex of report.excluded.slice(0, 8)) {
    notes.add(`Excluded ${ex.path}: ${ex.reason}`);
  }

  for (const spot of report.blind_spots.slice(0, 4)) {
    notes.add(spot);
  }

  return [...notes];
}
