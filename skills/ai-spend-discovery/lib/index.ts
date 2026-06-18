export type {
  CallType,
  Confidence,
  CoverageReport,
  ExclusionCategory,
  ExclusionEntry,
  Finding,
  FindingLocation,
  FindingsDocument,
  FindingsSummary,
  ScanMetadata,
  ValidationIssue,
  ValidationSeverity,
} from './types.js';
export { FINDINGS_SCHEMA_VERSION } from './types.js';

export {
  assessConfidence,
  confidenceMismatch,
  expectedConfidenceForCallType,
  isBillableCallSite,
  isDependencyOnly,
} from './confidence.js';
export type { ConfidenceAssessment } from './confidence.js';

export {
  billableDedupKey,
  callSiteGroupKey,
  callSiteScore,
  dedupeFindings,
  findDuplicateGroups,
  linesOverlap,
  pickBestFinding,
  selectBillableFindings,
} from './dedup.js';
export type { DuplicateGroup } from './dedup.js';

export {
  buildCoverageReport,
  buildExclusions,
  categorizeExclusion,
  defaultBlindSpots,
  mergeCoverageNotes,
} from './coverage.js';

export {
  loadPatternsExcludeDirs,
  normalizeFindings,
  reconcileSummary,
  renumberFindings,
} from './reconcile.js';

export {
  formatIssues,
  hasErrors,
  validateSemantics,
} from './validate-semantics.js';
export type { SemanticValidationOptions } from './validate-semantics.js';

export { runStaticScan, writeFindingsDocument } from './static-scan.js';
export type { StaticScanOptions } from './static-scan.js';
