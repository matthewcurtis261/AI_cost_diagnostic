import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runCheck } from '../cli/check.js';
import { ExitCode } from '../cli/lib/exit-codes.js';
import { runStaticScan } from '../skills/ai-spend-discovery/lib/static-scan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'repos', 'openai-chat-app');

describe('static scan', () => {
  it('detects OpenAI signals in openai-chat-app fixture', () => {
    const doc = runStaticScan({ repoPath: FIXTURE });
    assert.ok(doc.findings.length > 0);
    assert.ok(doc.findings.some((f) => f.provider === 'openai'));
    assert.equal(doc.scan_metadata.agent_version, 'static-pass-a/0.1.0');
    assert.deepEqual(doc.summary.coverage?.passes_completed, ['A']);
  });

  it('writes valid JSON with schema fields', () => {
    const doc = runStaticScan({ repoPath: FIXTURE });
    assert.ok(doc.scan_metadata.scanned_at);
    assert.ok(Array.isArray(doc.summary.providers));
  });
});

describe('check command', () => {
  it('passes sample findings', () => {
    const sample = path.join(ROOT, 'examples', 'sample-findings.json');
    const result = runCheck({ findingsPath: sample, quiet: true });
    assert.equal(result.exitCode, ExitCode.OK);
    assert.ok(result.billableCount > 0);
  });

  it('fails --fail-on-findings when billable sites exist', () => {
    const sample = path.join(ROOT, 'examples', 'sample-findings.json');
    const result = runCheck({
      findingsPath: sample,
      failOnFindings: true,
      quiet: true,
    });
    assert.equal(result.exitCode, ExitCode.POLICY_FAIL);
  });

  it('passes --max-billable when under threshold', () => {
    const sample = path.join(ROOT, 'examples', 'sample-findings.json');
    const result = runCheck({
      findingsPath: sample,
      maxBillable: 10,
      quiet: true,
    });
    assert.equal(result.exitCode, ExitCode.OK);
  });

  it('fails --max-billable 0 on sample with billable sites', () => {
    const sample = path.join(ROOT, 'examples', 'sample-findings.json');
    const result = runCheck({
      findingsPath: sample,
      maxBillable: 0,
      quiet: true,
    });
    assert.equal(result.exitCode, ExitCode.POLICY_FAIL);
  });

  it('returns error for missing file', () => {
    assert.throws(
      () => runCheck({ findingsPath: path.join(os.tmpdir(), 'missing-findings.json'), quiet: true }),
      /not found/,
    );
  });
});

describe('rival-search static scan', () => {
  it('finds openai in rival-search checkout when present', () => {
    const rivalPath = path.join(ROOT, 'test-runs', 'rival-search');
    if (!fs.existsSync(path.join(rivalPath, 'backend', 'app', 'agent.py'))) {
      return; // skip if test-run tree not present
    }
    const doc = runStaticScan({ repoPath: rivalPath });
    assert.ok(doc.findings.some((f) => f.provider === 'openai'));
  });
});
