import { selectBillableFindings as selectBillableFromDiscovery } from '../../skills/ai-spend-discovery/lib/dedup.js';
import type { Finding } from './types.js';

/** Findings that represent actual API spend, not dependency declarations. */
export function selectBillableFindings(findings: Finding[]): Finding[] {
  return selectBillableFromDiscovery(findings);
}
