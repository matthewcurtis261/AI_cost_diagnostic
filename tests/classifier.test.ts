import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifierWeightsAvailable,
  classifyTexts,
  extractInputText,
  metricWeightsFromPrediction,
} from '../input-analysis/lib/classifier.js';

describe('input classifier (6c)', () => {
  it('extracts text from telemetry chat payloads', () => {
    const text = extractInputText({
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Write Python code to merge intervals.' },
      ],
      parameters: { temperature: 0, max_tokens: 512 },
    });
    assert.match(text, /user: Write Python code to merge intervals/);
    assert.match(text, /params: temperature=0/);
  });

  it('classifies coding prompts (fallback or trained)', () => {
    const result = classifyTexts(
      ['Complete this Python function:\ndef has_close_elements(numbers, threshold):'],
    );
    assert.equal(result.schema_version, '0.1.0');
    assert.equal(result.predictions.length, 1);
    const pred = result.predictions[0];
    assert.ok(pred.metric_ids.includes('code_completion'));
    assert.equal(pred.primary_metric, 'code_completion');
  });

  it('classifies math prompts', () => {
    const result = classifyTexts(['Solve for x: 3x + 7 = 22']);
    const pred = result.predictions[0];
    assert.ok(pred.metric_ids.includes('math'));
  });

  it('builds metric weights from predictions', () => {
    const result = classifyTexts(['Question: capital of France? A. Paris B. Rome']);
    const weights = metricWeightsFromPrediction(result.predictions[0]);
    assert.ok(Object.keys(weights).length >= 1);
    for (const value of Object.values(weights)) {
      assert.ok(value > 0);
    }
  });

  it('reports committed bootstrap weights when present', () => {
    assert.equal(classifierWeightsAvailable(), true);
  });
});
