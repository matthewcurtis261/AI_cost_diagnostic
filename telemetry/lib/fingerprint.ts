import { createHash } from 'crypto';

const TELEMETRY_FRAME_MARKERS = [
  'diagnostic_agent/telemetry',
  'diagnostic-agent/telemetry',
  'node_modules',
];

export interface FingerprintOptions {
  findingId?: string;
  label?: string;
}

/**
 * Returns a finding_id when provided, otherwise a stable call-site fingerprint
 * derived from the first application stack frame outside this package.
 */
export function resolveCorrelationId(options: FingerprintOptions = {}): {
  finding_id?: string;
  call_site_fingerprint?: string;
} {
  if (options.findingId) {
    return { finding_id: options.findingId };
  }

  const frame = findApplicationFrame(new Error().stack ?? '');
  const material = [options.label ?? '', frame].filter(Boolean).join('|');
  const hash = createHash('sha256').update(material).digest('hex').slice(0, 12);
  return { call_site_fingerprint: `cs_${hash}` };
}

function findApplicationFrame(stack: string): string {
  const lines = stack.split('\n').map((l) => l.trim());

  for (const line of lines) {
    if (!line.startsWith('at ')) continue;
    if (TELEMETRY_FRAME_MARKERS.some((m) => line.includes(m))) continue;
    return line.replace(/^at\s+/, '');
  }

  return 'unknown';
}

export function newEventId(): string {
  const suffix = createHash('sha256')
    .update(`${Date.now()}-${Math.random()}`)
    .digest('hex')
    .slice(0, 10);
  return `evt_${suffix}`;
}
