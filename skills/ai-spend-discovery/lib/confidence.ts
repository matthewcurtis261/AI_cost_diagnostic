import type { CallType, Confidence, Finding } from './types.js';

const DIRECT_CALL_PATTERNS = [
  '.create(',
  '.completions',
  'messages.create',
  'chat.completions',
  '.embeddings',
  '.images.generate',
  '.audio.',
  '.invoke(',
  '.invoke_model',
  'InvokeModel',
];

const IMPORT_ONLY_PATTERNS = [
  /^from\s+\S+\s+import/,
  /^import\s+\S+/,
  /require\s*\(\s*['"][^'"]+['"]\s*\)/,
];

const DEPENDENCY_EVIDENCE = /^(openai|anthropic|langchain|litellm|cohere|groq)[=<>!]/i;

export interface ConfidenceAssessment {
  suggested: Confidence;
  score: number;
  reasons: string[];
}

/** Score a finding 0–10 and map to high / medium / low. */
export function assessConfidence(finding: Finding): ConfidenceAssessment {
  const evidence = finding.evidence.trim();
  const lower = evidence.toLowerCase();
  let score = 0;
  const reasons: string[] = [];

  if (finding.call_type === 'agent_framework') {
    if (DEPENDENCY_EVIDENCE.test(evidence) || evidence.includes('==')) {
      score += 2;
      reasons.push('dependency declaration only');
    } else {
      score += 4;
      reasons.push('framework usage without direct API method');
    }
  } else if (DIRECT_CALL_PATTERNS.some((p) => lower.includes(p.toLowerCase()))) {
    score += 6;
    reasons.push('direct API call pattern in evidence');
  } else if (IMPORT_ONLY_PATTERNS.some((re) => re.test(evidence))) {
    score += 2;
    reasons.push('import or client init only');
  } else {
    score += 3;
    reasons.push('indirect or partial evidence');
  }

  if (finding.model !== 'unknown' && finding.model !== 'dynamic') {
    score += 2;
    reasons.push('static or config-backed model');
  } else if (finding.model === 'dynamic') {
    score += 1;
    reasons.push('runtime model selection');
  }

  if (finding.wrapper) {
    score -= 1;
    reasons.push('call via wrapper/delegate');
  }

  if (finding.confidence === 'high' && score < 5) {
    // assigned high but evidence weak — validator will flag
  }

  const suggested: Confidence = score >= 7 ? 'high' : score >= 4 ? 'medium' : 'low';
  return { suggested, score, reasons };
}

/** True when assigned confidence is more than one tier away from assessment. */
export function confidenceMismatch(finding: Finding): boolean {
  const { suggested } = assessConfidence(finding);
  const rank: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
  const assigned = finding.confidence as Confidence;
  if (!(assigned in rank)) return true;
  return Math.abs(rank[assigned] - rank[suggested]) > 1;
}

export function isBillableCallSite(finding: Finding): boolean {
  if (finding.call_type === 'agent_framework') return false;
  if (finding.call_type === 'embedding') {
    return finding.evidence.toLowerCase().includes('embed');
  }
  const lower = finding.evidence.toLowerCase();
  return DIRECT_CALL_PATTERNS.some((p) => lower.includes(p.toLowerCase()));
}

export function isDependencyOnly(finding: Finding): boolean {
  return (
    finding.call_type === 'agent_framework' &&
    (DEPENDENCY_EVIDENCE.test(finding.evidence.trim()) ||
      finding.evidence.includes('requirements.txt') ||
      finding.evidence.includes('package.json'))
  );
}

export function expectedConfidenceForCallType(callType: CallType | string): Confidence {
  switch (callType) {
    case 'agent_framework':
      return 'medium';
    case 'unknown':
      return 'low';
    default:
      return 'high';
  }
}
