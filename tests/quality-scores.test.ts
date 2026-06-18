import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  loadModelAliases,
  loadOpenPricing,
  loadQualityScores,
  resolveQualityModelId,
  resolveQualityPreferences,
  weightedQualityScore,
} from '../input-analysis/lib/quality-scores.js';

describe('quality scores (6a)', () => {
  const scores = loadQualityScores();
  const aliases = loadModelAliases();
  const openPricing = loadOpenPricing();

  it('loads snapshot with 20 models and 20 metrics', () => {
    assert.equal(scores.schema_version, '0.1.0');
    assert.equal(scores.coverage?.total_models, 20);
    assert.equal(scores.metrics.length, 20);
    assert.ok(scores.models['deepseek-ai/DeepSeek-V3']);
    assert.ok(scores.models['meta-llama/Llama-3.1-8B-Instruct']);
  });

  it('resolves telemetry model aliases to matrix keys', () => {
    assert.equal(
      resolveQualityModelId('gpt-4o', aliases, scores),
      'openai/gpt-4o-2024-11-20',
    );
    assert.equal(
      resolveQualityModelId('deepseek-chat', aliases, scores),
      'deepseek-ai/DeepSeek-V3',
    );
    assert.equal(
      resolveQualityModelId('llama-3.1-8b-instruct', aliases, scores),
      'meta-llama/Llama-3.1-8B-Instruct',
    );
  });

  it('computes blended quality for coding-heavy weights', () => {
    const key = 'meta-llama/Llama-3.1-8B-Instruct';
    const q = weightedQualityScore(
      key,
      { code_completion: 0.7, instruction_following: 0.3 },
      scores,
    );
    assert.ok(q != null);
    assert.ok(q > 0.7 && q < 0.8);
  });

  it('open pricing includes self-hosted compute baseline', () => {
    assert.equal(openPricing.self_hosted_compute.input_per_million, 0.2);
    assert.equal(openPricing.self_hosted_compute.output_per_million, 0.2);
    assert.ok(openPricing.models['llama-3.1-8b-instruct-self-hosted']);
  });

  it('quality presets default to balanced 90% floor', () => {
    const prefs = resolveQualityPreferences();
    assert.equal(prefs.preset, 'balanced');
    assert.equal(prefs.quality_floor_pct, 0.9);
    assert.equal(prefs.quality_sacrifice_per_cost, 0.5);
  });
});
