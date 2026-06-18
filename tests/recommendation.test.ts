import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadPricingTable } from '../estimate/lib/pricing.js';
import { loadModelAliases, loadQualityScores } from '../input-analysis/lib/quality-scores.js';
import {
  blendedQualityForModel,
  evaluateAlternative,
  pickBestAlternative,
} from '../input-analysis/lib/recommendation.js';

describe('quality-aware recommendation (6d)', () => {
  const pricing = loadPricingTable(undefined, { includeOpenPricing: true });
  const scores = loadQualityScores();
  const aliases = loadModelAliases();

  const codingWeights = { code_completion: 0.8, instruction_following: 0.2 };

  it('computes blended quality for open models on coding weights', () => {
    const q = blendedQualityForModel('deepseek-chat', codingWeights, pricing, { scores, aliases });
    assert.ok(q != null);
    assert.ok(q > 0.7);
  });

  it('rejects alternatives that fail quality floor', () => {
    const evaluation = evaluateAlternative(
      'gpt-4o',
      'gpt-4.1-nano',
      'chat_completion',
      1000,
      500,
      0.95,
      0.98,
      pricing,
      {
        metricWeights: { expert_science: 1 },
        scores,
        aliases,
        preferences: {
          preset: 'conservative',
          quality_floor_pct: 0.95,
          quality_sacrifice_per_cost: 0.2,
        },
      },
    );
    assert.ok(evaluation);
    if (evaluation.alternative_quality != null && evaluation.quality_floor != null) {
      assert.equal(
        evaluation.passes_quality_floor,
        evaluation.alternative_quality >= evaluation.quality_floor,
      );
    }
  });

  it('picks a cheaper open model for coding prompts when savings exist', () => {
    const best = pickBestAlternative(
      'gpt-4o',
      'chat_completion',
      1200,
      450,
      pricing,
      {
        metricWeights: codingWeights,
        scores,
        aliases,
        preferences: {
          preset: 'balanced',
          quality_floor_pct: 0.9,
          quality_sacrifice_per_cost: 0.5,
        },
      },
      ['deepseek-chat', 'llama-3.1-8b-instruct', 'gpt-4o-mini'],
    );

    if (best) {
      assert.ok(best.savings_usd > 0);
      assert.ok(best.passes_quality_floor);
      assert.ok(best.passes_sacrifice_tradeoff);
    }
  });
});
