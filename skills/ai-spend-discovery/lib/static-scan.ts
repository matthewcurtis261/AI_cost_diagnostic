import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { buildCoverageReport, mergeCoverageNotes } from './coverage.js';
import { reconcileSummary } from './reconcile.js';
import { FINDINGS_SCHEMA_VERSION, type CallType, type Finding, type FindingsDocument } from './types.js';

interface PatternsFile {
  exclude_dirs: string[];
  exclude_globs: string[];
  model_patterns: string[];
  providers: Record<
    string,
    { sdk_imports: string[]; http_endpoints: string[]; env_vars: string[] }
  >;
  dependency_packages: string[];
}

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.rb',
  '.php',
  '.cs',
  '.swift',
  '.kt',
  '.yaml',
  '.yml',
  '.json',
  '.toml',
  '.tf',
  '.mod',
  '.gradle',
  '.xml',
]);

const MANIFEST_NAMES = new Set([
  'package.json',
  'requirements.txt',
  'pyproject.toml',
  'go.mod',
  'Gemfile',
  'Cargo.toml',
  'pnpm-workspace.yaml',
]);

export interface StaticScanOptions {
  repoPath: string;
  scope?: string[];
  mountName?: string;
}

function loadPatterns(): PatternsFile {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const patternsPath = path.join(__dirname, '..', 'patterns', 'providers.json');
  return JSON.parse(fs.readFileSync(patternsPath, 'utf-8')) as PatternsFile;
}

function loadPatternsFromRoot(root: string): PatternsFile {
  const patternsPath = path.join(root, 'patterns', 'providers.json');
  return JSON.parse(fs.readFileSync(patternsPath, 'utf-8')) as PatternsFile;
}

export function resolvePatternsFile(skillRoot?: string): PatternsFile {
  if (skillRoot) return loadPatternsFromRoot(skillRoot);
  return loadPatterns();
}

function globMatch(relativePath: string, pattern: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  if (pattern.startsWith('**/')) {
    const suffix = pattern.slice(3);
    if (suffix.startsWith('*.')) {
      return normalized.endsWith(suffix.slice(1));
    }
    return normalized.endsWith(suffix) || normalized.includes(`/${suffix}`);
  }
  return normalized === pattern;
}

function isExcluded(relativePath: string, patterns: PatternsFile): boolean {
  const parts = relativePath.split(/[/\\]/);
  for (const dir of patterns.exclude_dirs) {
    if (parts.includes(dir)) return true;
  }
  for (const glob of patterns.exclude_globs) {
    if (globMatch(relativePath, glob)) return true;
  }
  return false;
}

function listFiles(repoPath: string, scope: string[] | undefined, patterns: PatternsFile): string[] {
  const files: string[] = [];
  const roots =
    scope && scope.length > 0
      ? scope.map((s) => path.join(repoPath, s))
      : [repoPath];

  function walk(dir: string): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(repoPath, full);
      if (isExcluded(rel, patterns)) continue;

      if (entry.isDirectory()) {
        walk(full);
      } else if (
        SOURCE_EXTENSIONS.has(path.extname(entry.name)) ||
        MANIFEST_NAMES.has(entry.name)
      ) {
        files.push(full);
      }
    }
  }

  for (const root of roots) walk(root);
  return files;
}

function lineNumber(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

function snippet(content: string, line: number, context = 0): string {
  const lines = content.split('\n');
  const start = Math.max(0, line - 1 - context);
  const end = Math.min(lines.length, line + context);
  return lines.slice(start, end).join('\n').trim();
}

function inferCallType(evidence: string, isManifest: boolean): CallType {
  const lower = evidence.toLowerCase();
  if (isManifest) return 'agent_framework';
  if (lower.includes('embed')) return 'embedding';
  if (lower.includes('dall-e') || lower.includes('images.generate')) return 'image';
  if (lower.includes('whisper') || lower.includes('audio.')) return 'speech';
  if (
    lower.includes('.create(') ||
    lower.includes('completions') ||
    lower.includes('messages.create')
  ) {
    return 'chat_completion';
  }
  if (lower.includes('langchain') || lower.includes('llama-index')) return 'agent_framework';
  return 'unknown';
}

function inferConfidence(
  kind: 'sdk' | 'http' | 'env' | 'model' | 'dependency',
  evidence: string,
): 'high' | 'medium' | 'low' {
  if (kind === 'dependency') return 'medium';
  if (evidence.includes('.create(') || evidence.includes('messages.create')) return 'medium';
  if (kind === 'sdk' || kind === 'http') return 'low';
  return 'low';
}

interface RawHit {
  provider: string;
  kind: 'sdk' | 'http' | 'env' | 'model' | 'dependency';
  file: string;
  line: number;
  evidence: string;
  model: string;
}

function scanFile(
  repoPath: string,
  filePath: string,
  patterns: PatternsFile,
): RawHit[] {
  const rel = path.relative(repoPath, filePath).replace(/\\/g, '/');
  const content = fs.readFileSync(filePath, 'utf-8');
  const isManifest = MANIFEST_NAMES.has(path.basename(filePath));
  const hits: RawHit[] = [];
  const seen = new Set<string>();

  function add(hit: Omit<RawHit, 'file'>): void {
    const key = `${hit.provider}::${hit.line}::${hit.kind}::${hit.evidence.slice(0, 40)}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ ...hit, file: rel });
  }

  for (const [provider, cfg] of Object.entries(patterns.providers)) {
    for (const sig of cfg.sdk_imports) {
      let idx = content.indexOf(sig);
      while (idx !== -1) {
        const line = lineNumber(content, idx);
        add({
          provider,
          kind: 'sdk',
          line,
          evidence: snippet(content, line),
          model: 'unknown',
        });
        idx = content.indexOf(sig, idx + sig.length);
      }
    }
    for (const sig of cfg.http_endpoints) {
      let idx = content.indexOf(sig);
      while (idx !== -1) {
        const line = lineNumber(content, idx);
        add({
          provider,
          kind: 'http',
          line,
          evidence: snippet(content, line),
          model: 'unknown',
        });
        idx = content.indexOf(sig, idx + sig.length);
      }
    }
    for (const sig of cfg.env_vars) {
      let idx = content.indexOf(sig);
      while (idx !== -1) {
        const line = lineNumber(content, idx);
        add({
          provider,
          kind: 'env',
          line,
          evidence: snippet(content, line),
          model: 'unknown',
        });
        idx = content.indexOf(sig, idx + sig.length);
      }
    }
  }

  for (const pkg of patterns.dependency_packages) {
    if (!content.includes(pkg)) continue;
    let idx = content.indexOf(pkg);
    while (idx !== -1) {
      const line = lineNumber(content, idx);
      add({
        provider: pkg.includes('anthropic')
          ? 'anthropic'
          : pkg.includes('openai')
            ? 'openai'
            : pkg.includes('bedrock')
              ? 'aws-bedrock'
              : 'unknown',
        kind: 'dependency',
        line,
        evidence: snippet(content, line),
        model: 'unknown',
      });
      idx = content.indexOf(pkg, idx + pkg.length);
    }
  }

  for (const pattern of patterns.model_patterns) {
    const re = new RegExp(pattern, 'gi');
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      const line = lineNumber(content, match.index);
      add({
        provider: 'unknown',
        kind: 'model',
        line,
        evidence: snippet(content, line),
        model: match[0],
      });
    }
  }

  if (isManifest && hits.length === 0) {
    for (const pkg of patterns.dependency_packages) {
      if (content.includes(pkg)) {
        add({
          provider: 'unknown',
          kind: 'dependency',
          line: 1,
          evidence: pkg,
          model: 'unknown',
        });
      }
    }
  }

  return hits;
}

function rawToFinding(hit: RawHit, index: number): Finding {
  const isManifest = MANIFEST_NAMES.has(path.basename(hit.file));
  const callType = inferCallType(hit.evidence, isManifest || hit.kind === 'dependency');
  const confidence = inferConfidence(hit.kind, hit.evidence);

  return {
    id: `f${String(index + 1).padStart(3, '0')}`,
    provider: hit.provider,
    model: hit.kind === 'model' ? hit.model : 'unknown',
    call_type: callType,
    location: { file: hit.file, lines: [hit.line] },
    confidence,
    evidence: hit.evidence,
    notes:
      hit.kind === 'env'
        ? 'Pass A static scan — env var reference only'
        : 'Pass A static scan — run agent scan for Pass B classification',
  };
}

/** Deterministic Pass A scan (no Nanoclaw / LLM). Suitable for CI. */
export function runStaticScan(options: StaticScanOptions): FindingsDocument {
  const repoPath = path.resolve(options.repoPath);
  const patterns = loadPatterns();
  const files = listFiles(repoPath, options.scope, patterns);
  const rawHits: RawHit[] = [];

  for (const file of files) {
    rawHits.push(...scanFile(repoPath, file, patterns));
  }

  const findings = rawHits.map((hit, i) => rawToFinding(hit, i));
  const summary = reconcileSummary(findings);
  summary.coverage_notes = [
    'Static Pass A scan only — no agent Pass B–E',
    'Findings may include false positives; use check --min-confidence or agent scan',
    ...(summary.coverage_notes ?? []),
  ];

  const doc: FindingsDocument = {
    scan_metadata: {
      repo_path: repoPath,
      repo_mount_name: options.mountName ?? path.basename(repoPath),
      scope: options.scope ?? [],
      scanned_at: new Date().toISOString(),
      schema_version: FINDINGS_SCHEMA_VERSION,
      files_scanned: files.length,
      agent_version: 'static-pass-a/0.1.0',
      excluded_paths: patterns.exclude_dirs,
    },
    findings,
    summary,
  };

  doc.summary.coverage = buildCoverageReport(doc);
  doc.summary.coverage_notes = mergeCoverageNotes(doc);
  doc.summary.coverage!.passes_completed = ['A'];

  return doc;
}

export function writeFindingsDocument(doc: FindingsDocument, outputPath: string): void {
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(doc, null, 2)}\n`);
}
