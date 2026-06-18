import fs from 'fs';
import path from 'path';

import { createValidator, formatValidationErrors } from '../lib/ajv.js';
import {
  hasErrors,
  selectBillableFindings,
  validateSemantics,
  type Confidence,
  type FindingsDocument,
} from '../skills/ai-spend-discovery/lib/index.js';
import { ExitCode } from './lib/exit-codes.js';
import { SKILL_SOURCE_DIR } from './lib/nanoclaw.js';

const SCHEMA_PATH = path.join(SKILL_SOURCE_DIR, 'schema', 'findings.schema.json');

export interface CheckOptions {
  findingsPath: string;
  strict?: boolean;
  failOnFindings?: boolean;
  minConfidence?: Confidence;
  maxBillable?: number;
  minBillable?: number;
  json?: boolean;
  quiet?: boolean;
}

export interface CheckResult {
  ok: boolean;
  exitCode: number;
  findingsPath: string;
  totalFindings: number;
  billableCount: number;
  issues: string[];
  document: FindingsDocument;
}

const CONFIDENCE_RANK: Record<Confidence, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

function loadSchema(): object {
  return JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
}

function log(msg: string, quiet?: boolean): void {
  if (!quiet) console.log(msg);
}

export function runCheck(options: CheckOptions): CheckResult {
  const findingsPath = path.resolve(options.findingsPath);
  if (!fs.existsSync(findingsPath)) {
    throw new Error(`Findings file not found: ${findingsPath}`);
  }

  const document = JSON.parse(fs.readFileSync(findingsPath, 'utf-8')) as FindingsDocument;
  const validate = createValidator(loadSchema());

  const issues: string[] = [];

  if (!validate(document)) {
    for (const line of formatValidationErrors(validate.errors)) {
      issues.push(`schema: ${line}`);
    }
    return {
      ok: false,
      exitCode: ExitCode.ERROR,
      findingsPath,
      totalFindings: document.findings?.length ?? 0,
      billableCount: 0,
      issues,
      document,
    };
  }

  const semantic = validateSemantics(document, { strict: options.strict });
  for (const issue of semantic) {
    issues.push(`${issue.severity}/${issue.code}: ${issue.message}`);
  }

  if (hasErrors(semantic)) {
    return {
      ok: false,
      exitCode: ExitCode.ERROR,
      findingsPath,
      totalFindings: document.findings.length,
      billableCount: 0,
      issues,
      document,
    };
  }

  const billable = selectBillableFindings(document.findings);
  const billableCount = billable.length;

  if (options.failOnFindings && billableCount > 0) {
    issues.push(`policy: ${billableCount} billable call site(s) detected (--fail-on-findings)`);
  }

  if (options.minConfidence) {
    const minRank = CONFIDENCE_RANK[options.minConfidence];
    const weak = billable.filter(
      (f) => CONFIDENCE_RANK[f.confidence as Confidence] < minRank,
    );
    if (weak.length > 0) {
      issues.push(
        `policy: ${weak.length} billable finding(s) below --min-confidence ${options.minConfidence}`,
      );
    }
  }

  if (options.maxBillable !== undefined && billableCount > options.maxBillable) {
    issues.push(
      `policy: billable count ${billableCount} exceeds --max-billable ${options.maxBillable}`,
    );
  }

  if (options.minBillable !== undefined && billableCount < options.minBillable) {
    issues.push(
      `policy: billable count ${billableCount} below --min-billable ${options.minBillable}`,
    );
  }

  const policyFailed = issues.some((i) => i.startsWith('policy:'));
  const ok = !policyFailed;

  const result: CheckResult = {
    ok,
    exitCode: ok ? ExitCode.OK : ExitCode.POLICY_FAIL,
    findingsPath,
    totalFindings: document.findings.length,
    billableCount,
    issues,
    document,
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  if (ok) {
    log(`OK: ${findingsPath} (${document.findings.length} findings, ${billableCount} billable)`, options.quiet);
  } else {
    log(`CHECK FAILED: ${findingsPath}`, options.quiet);
    for (const issue of issues) {
      console.error(`  ${issue}`);
    }
  }

  return result;
}

export function parseCheckArgs(argv: string[]): Omit<CheckOptions, 'findingsPath'> & {
  findings?: string;
} {
  const parsed: Omit<CheckOptions, 'findingsPath'> & { findings?: string } = {};

  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--findings' && val) {
      parsed.findings = val;
      i++;
    } else if (key === '--strict') {
      parsed.strict = true;
    } else if (key === '--fail-on-findings') {
      parsed.failOnFindings = true;
    } else if (key === '--min-confidence' && val) {
      parsed.minConfidence = val as Confidence;
      i++;
    } else if (key === '--max-billable' && val) {
      parsed.maxBillable = Number(val);
      i++;
    } else if (key === '--min-billable' && val) {
      parsed.minBillable = Number(val);
      i++;
    } else if (key === '--json') {
      parsed.json = true;
    } else if (key === '--quiet') {
      parsed.quiet = true;
    } else if (!key.startsWith('-') && !parsed.findings) {
      parsed.findings = key;
    }
  }

  return parsed;
}
