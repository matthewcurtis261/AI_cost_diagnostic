import { isBillableCallSite, isDependencyOnly } from './confidence.js';
import type { Finding } from './types.js';

export function lineRange(finding: Finding): { start: number; end: number } {
  const [start, end = start] = finding.location.lines;
  return { start, end };
}

export function linesOverlap(a: Finding, b: Finding): boolean {
  const ra = lineRange(a);
  const rb = lineRange(b);
  return ra.start <= rb.end && rb.start <= ra.end;
}

/** Stable key for same logical call site (file + call type + overlapping lines). */
export function callSiteGroupKey(finding: Finding): string {
  const { start } = lineRange(finding);
  return `${finding.location.file}::${finding.call_type}::${start}`;
}

/** Key used for billable dedup (one billable hit per file per call type). */
export function billableDedupKey(finding: Finding): string {
  return `${finding.location.file}::${finding.call_type}`;
}

export function callSiteScore(finding: Finding): number {
  let score = 0;
  if (finding.confidence === 'high') score += 3;
  else if (finding.confidence === 'medium') score += 2;
  else score += 1;

  if (finding.evidence.includes('.create(')) score += 2;
  if (isBillableCallSite(finding)) score += 3;
  if (!finding.wrapper) score += 1;
  if (isDependencyOnly(finding)) score -= 4;
  return score;
}

export function shouldReplace(existing: Finding, candidate: Finding): boolean {
  return callSiteScore(candidate) > callSiteScore(existing);
}

/** Merge duplicate call sites; keep highest-scoring finding per group. */
export function dedupeFindings(findings: Finding[]): Finding[] {
  const groups = new Map<string, Finding>();

  for (const finding of findings) {
    const key = billableDedupKey(finding);
    const existing = groups.get(key);

    if (!existing) {
      groups.set(key, finding);
      continue;
    }

    // Keep dependency-only separate from billable call in same file
    if (isDependencyOnly(finding) !== isDependencyOnly(existing)) {
      if (isDependencyOnly(finding)) {
        groups.set(`${key}::dep::${finding.id}`, finding);
      } else if (isDependencyOnly(existing)) {
        groups.set(key, finding);
        groups.set(`${key}::dep::${existing.id}`, existing);
      }
      continue;
    }

    if (linesOverlap(existing, finding) || finding.call_type === existing.call_type) {
      if (shouldReplace(existing, finding)) {
        groups.set(key, finding);
      }
    } else {
      groups.set(`${key}::${lineRange(finding).start}`, finding);
    }
  }

  return [...groups.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export interface DuplicateGroup {
  key: string;
  finding_ids: string[];
  recommendation: string;
}

/** Find groups that look like duplicate call-site reporting. */
export function findDuplicateGroups(findings: Finding[]): DuplicateGroup[] {
  const byKey = new Map<string, Finding[]>();

  for (const finding of findings) {
    if (isDependencyOnly(finding)) continue;
    const key = billableDedupKey(finding);
    const list = byKey.get(key) ?? [];
    list.push(finding);
    byKey.set(key, list);
  }

  const groups: DuplicateGroup[] = [];
  for (const [key, list] of byKey) {
    if (list.length <= 1) continue;
    groups.push({
      key,
      finding_ids: list.map((f) => f.id),
      recommendation: `Keep ${pickBestFinding(list).id}; merge or downgrade others`,
    });
  }
  return groups;
}

export function pickBestFinding(findings: Finding[]): Finding {
  return findings.reduce((best, f) => (callSiteScore(f) > callSiteScore(best) ? f : best));
}

/** Billable call sites after dedup (used by estimate). */
export function selectBillableFindings(findings: Finding[]): Finding[] {
  const candidates = findings.filter((f) => {
    if (f.call_type === 'agent_framework' || f.call_type === 'unknown') return false;
    if (f.call_type === 'chat_completion' && f.confidence === 'low') return false;
    return isBillableCallSite(f);
  });
  return dedupeFindings(candidates);
}
