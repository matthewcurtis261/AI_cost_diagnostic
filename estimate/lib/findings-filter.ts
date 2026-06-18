import type { Finding } from './types.js';

const BILLABLE_CALL_TYPES = new Set([
  'chat_completion',
  'embedding',
  'image',
  'speech',
]);

/** Findings that represent actual API spend, not dependency declarations. */
export function selectBillableFindings(findings: Finding[]): Finding[] {
  const candidates = findings.filter((f) => {
    if (!BILLABLE_CALL_TYPES.has(f.call_type)) return false;
    if (f.call_type === 'chat_completion' && f.confidence === 'low') return false;
    return isActualCallSite(f);
  });

  return dedupeCallSites(candidates);
}

function isActualCallSite(finding: Finding): boolean {
  const evidence = finding.evidence.toLowerCase();
  if (finding.call_type === 'embedding') {
    return evidence.includes('embed');
  }
  return (
    evidence.includes('.create(') ||
    evidence.includes('.completions') ||
    evidence.includes('messages.create') ||
    evidence.includes('invoke') ||
    evidence.includes('chat.completions')
  );
}

/** Avoid double-counting wrapper/delegate findings for the same file. */
function dedupeCallSites(findings: Finding[]): Finding[] {
  const byFile = new Map<string, Finding>();

  for (const finding of findings) {
    const key = `${finding.location.file}::${finding.call_type}`;
    const existing = byFile.get(key);
    if (!existing) {
      byFile.set(key, finding);
      continue;
    }

    const existingScore = callSiteScore(existing);
    const nextScore = callSiteScore(finding);
    if (nextScore > existingScore) {
      byFile.set(key, finding);
    }
  }

  return [...byFile.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function callSiteScore(finding: Finding): number {
  let score = 0;
  if (finding.confidence === 'high') score += 3;
  if (finding.confidence === 'medium') score += 2;
  if (finding.confidence === 'low') score += 1;
  if (finding.evidence.includes('.create(')) score += 2;
  if (!finding.wrapper) score += 1;
  return score;
}
