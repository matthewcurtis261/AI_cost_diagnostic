import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildEstimate } from '../estimate/index.js';
import { calculateCost, getModelPricing, loadPricingTable } from '../estimate/lib/pricing.js';
import { selectBillableFindings } from '../estimate/lib/findings-filter.js';
import type { EstimateLineItem, FindingsDocument, SavingsOpportunity } from '../estimate/lib/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadJson<T>(relativePath: string): T {
  return JSON.parse(
    fs.readFileSync(path.join(ROOT, relativePath), 'utf-8'),
  ) as T;
}

describe('open pricing merge (6b)', () => {
  it('merges open models into default pricing table', () => {
    const pricing = loadPricingTable();
    assert.ok(pricing.models['deepseek-chat']);
    assert.ok(pricing.models['llama-3.1-8b-instruct']);
    assert.equal(pricing.self_hosted_compute?.input_per_million, 0.2);
    assert.ok(pricing.pricing_sources && pricing.pricing_sources.length >= 2);
  });

  it('includes open models in default chat alternatives', () => {
    const pricing = loadPricingTable();
    const alts = pricing.default_alternatives?.chat_completion ?? [];
    assert.ok(alts.includes('deepseek-chat'));
    assert.ok(alts.includes('llama-3.1-8b-instruct-self-hosted'));
  });

  it('excludes open models when includeOpenPricing is false', () => {
    const pricing = loadPricingTable(undefined, { includeOpenPricing: false });
    assert.equal(pricing.models['deepseek-chat'], undefined);
    assert.equal(pricing.pricing_sources?.length, 1);
  });

  it('surfaces open-model savings vs frontier chat models', () => {
    const findings = loadJson<FindingsDocument>('examples/sample-findings.json');
    const report = buildEstimate(findings, {
      findingsPath: 'examples/sample-findings.json',
      callsPerMonth: 10000,
    });

    const sonnetItem = report.line_items.find((i) =>
      i.model.includes('claude-3-5-sonnet'),
    );
    assert.ok(sonnetItem);
    const deepseekSave = report.savings_opportunities.find(
      (s) =>
        s.finding_id === sonnetItem.finding_id &&
        s.alternative_model === 'deepseek-chat' &&
        s.savings_usd > 0,
    );
    assert.ok(deepseekSave);
    assert.ok(report.estimate_metadata.pricing_sources);
  });

  it('prices self-hosted llama at $0.20/Mtok', () => {
    const pricing = loadPricingTable();
    const model = getModelPricing(pricing, 'llama-3.1-8b-instruct-self-hosted');
    assert.ok(model);
    assert.equal(model.deployment, 'self_hosted');
    const cost = calculateCost(1_000_000, 1_000_000, model);
    assert.equal(cost.total_usd, 0.4);
  });
});

describe('pricing', () => {
  it('calculates gpt-4o-mini chat cost', () => {
    const pricing = loadPricingTable();
    const model = getModelPricing(pricing, 'gpt-4o-mini');
    assert.ok(model);
    const cost = calculateCost(1_000_000, 1_000_000, model);
    assert.equal(cost.input_usd, 0.15);
    assert.equal(cost.output_usd, 0.6);
    assert.equal(cost.total_usd, 0.75);
  });
});

describe('findings filter', () => {
  it('selects billable call sites from sample findings', () => {
    const findings = loadJson<FindingsDocument>('examples/sample-findings.json');
    const billable = selectBillableFindings(findings.findings);
    const ids = billable.map((f) => f.id);
    assert.ok(ids.includes('f001'));
    assert.ok(ids.includes('f002'));
    assert.ok(ids.includes('f003'));
  });

  it('dedupes rival-search wrapper vs direct call site', () => {
    const findings = loadJson<FindingsDocument>('test-runs/rival-search/ai-usage-findings.json');
    const billable = selectBillableFindings(findings.findings);
    assert.equal(billable.length, 1);
    assert.equal(billable[0]?.id, 'f001');
  });
});

describe('estimate engine', () => {
  it('builds code-only estimate for sample findings', () => {
    const findings = loadJson<FindingsDocument>('examples/sample-findings.json');
    const report = buildEstimate(findings, {
      findingsPath: 'examples/sample-findings.json',
      callsPerMonth: 1000,
      defaultModel: 'gpt-4o',
    });

    assert.equal(report.estimate_metadata.mode, 'code_only');
    assert.ok(report.line_items.length >= 2);
    assert.ok(report.totals.total_usd > 0);
    assert.ok(report.totals.calls > 0);
  });

  it('builds telemetry-mode estimate from sample events', () => {
    const findings = loadJson<FindingsDocument>('test-runs/rival-search/ai-usage-findings.json');
    const report = buildEstimate(findings, {
      findingsPath: 'test-runs/rival-search/ai-usage-findings.json',
      eventsPath: 'examples/sample-events.jsonl',
    });

    assert.equal(report.estimate_metadata.mode, 'telemetry');
    assert.equal(report.line_items.length, 1);
    assert.equal(report.line_items[0]?.finding_id, 'f001');
    assert.equal(report.line_items[0]?.usage.calls, 1);
    assert.equal(report.line_items[0]?.usage.input_tokens, 847);
    assert.equal(report.line_items[0]?.usage.output_tokens, 312);
    assert.ok(report.totals.total_usd > 0);
  });

  it('produces savings opportunities for expensive models', () => {
    const findings = loadJson<FindingsDocument>('examples/sample-findings.json');
    const report = buildEstimate(findings, {
      findingsPath: 'examples/sample-findings.json',
      callsPerMonth: 10000,
    });

    const sonnetItem = report.line_items.find((i: EstimateLineItem) =>
      i.model.includes('claude-3-5-sonnet'),
    );
    assert.ok(sonnetItem);
    const savings = report.savings_opportunities.filter(
      (s: SavingsOpportunity) => s.finding_id === sonnetItem?.finding_id && s.savings_usd > 0,
    );
    assert.ok(savings.length > 0);
  });
});

describe('estimate schema', () => {
  it('validates generated sample estimate', () => {
    const findings = loadJson<FindingsDocument>('examples/sample-findings.json');
    const report = buildEstimate(findings, {
      findingsPath: 'examples/sample-findings.json',
      callsPerMonth: 1000,
    });

    const outPath = path.join(ROOT, 'examples', 'sample-estimate.json');
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

    execFileSync('pnpm', ['run', 'validate-estimate', outPath], {
      cwd: ROOT,
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
  });
});
