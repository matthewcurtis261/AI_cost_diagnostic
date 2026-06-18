import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assessConfidence,
  dedupeFindings,
  findDuplicateGroups,
  normalizeFindings,
  reconcileSummary,
  selectBillableFindings,
  validateSemantics,
  type FindingsDocument,
  type Finding,
} from '../skills/ai-spend-discovery/lib/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadJson<T>(rel: string): T {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf-8')) as T;
}

describe('confidence rubric', () => {
  it('scores direct API call as high', () => {
    const finding: Finding = {
      id: 'f001',
      provider: 'openai',
      model: 'gpt-4o-mini',
      call_type: 'chat_completion',
      location: { file: 'src/a.ts', lines: [1, 5] },
      confidence: 'high',
      evidence: 'openai.chat.completions.create({ model: "gpt-4o-mini", messages })',
    };
    const result = assessConfidence(finding);
    assert.equal(result.suggested, 'high');
  });

  it('scores import-only as low or medium', () => {
    const finding: Finding = {
      id: 'f002',
      provider: 'openai',
      model: 'unknown',
      call_type: 'chat_completion',
      location: { file: 'src/a.ts', lines: [1, 3] },
      confidence: 'high',
      evidence: 'from openai import OpenAI',
    };
    const result = assessConfidence(finding);
    assert.ok(['low', 'medium'].includes(result.suggested));
  });
});

describe('dedup', () => {
  it('keeps direct call over import in same file', () => {
    const direct: Finding = {
      id: 'f001',
      provider: 'openai',
      model: 'config_ref',
      call_type: 'chat_completion',
      location: { file: 'backend/app/agent.py', lines: [63, 68] },
      confidence: 'high',
      evidence: 'client.chat.completions.create(model=settings.openai_model, messages=messages)',
    };
    const importOnly: Finding = {
      id: 'f002',
      provider: 'openai',
      model: 'unknown',
      call_type: 'chat_completion',
      location: { file: 'backend/app/agent.py', lines: [6, 45] },
      confidence: 'high',
      evidence: 'from openai import OpenAI\nclient = OpenAI(api_key=settings.openai_api_key)',
    };

    const deduped = dedupeFindings([importOnly, direct]);
    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].id, 'f001');
  });

  it('keeps dependency separate from billable call', () => {
    const findings = loadJson<FindingsDocument>('test-runs/rival-search/ai-usage-findings.json');
    const deduped = dedupeFindings(findings.findings);
    const ids = deduped.map((f) => f.id);
    assert.ok(ids.includes('f001') || deduped.some((f) => f.evidence.includes('completions.create')));
    assert.ok(deduped.some((f) => f.call_type === 'agent_framework'));
  });

  it('dedupes rival-search billable to fewer chat_completion hits in agent.py', () => {
    const findings = loadJson<FindingsDocument>('test-runs/rival-search/ai-usage-findings.json');
    const billable = selectBillableFindings(findings.findings);
    const agentPy = billable.filter((f) => f.location.file === 'backend/app/agent.py');
    assert.equal(agentPy.length, 1);
  });
});

describe('reconcile and normalize', () => {
  it('reconciles summary provider list from findings', () => {
    const doc = loadJson<FindingsDocument>('examples/sample-findings.json');
    const summary = reconcileSummary(doc.findings);
    assert.deepEqual(summary.providers, ['anthropic', 'openai']);
    assert.equal(summary.likely_dynamic_models, 1);
  });

  it('normalize adds coverage block', () => {
    const doc = loadJson<FindingsDocument>('examples/sample-findings.json');
    const normalized = normalizeFindings(doc);
    assert.ok(normalized.summary.coverage);
    assert.ok(normalized.summary.coverage!.excluded.length > 0);
    assert.ok(normalized.summary.coverage_notes!.length > 0);
  });
});

describe('semantic validation', () => {
  it('flags duplicate call sites in rival-search', () => {
    const doc = loadJson<FindingsDocument>('test-runs/rival-search/ai-usage-findings.json');
    const issues = validateSemantics(doc);
    const dupes = issues.filter((i) => i.code === 'duplicate_call_site');
    assert.ok(dupes.length > 0);
  });

  it('sample findings pass without errors', () => {
    const doc = loadJson<FindingsDocument>('examples/sample-findings.json');
    const issues = validateSemantics(doc);
    assert.ok(!issues.some((i) => i.severity === 'error'));
  });
});

describe('duplicate detection', () => {
  it('finds agent.py duplicate group', () => {
    const findings = loadJson<FindingsDocument>('test-runs/rival-search/ai-usage-findings.json');
    const groups = findDuplicateGroups(findings.findings);
    assert.ok(groups.some((g) => g.key.includes('backend/app/agent.py')));
  });
});
