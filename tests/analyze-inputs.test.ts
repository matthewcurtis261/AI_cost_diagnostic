import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  analyzeInputs,
  filterEventsByTime,
  loadTelemetryEventsWithInput,
} from '../input-analysis/lib/analyze-inputs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_EVENTS = path.join(__dirname, '..', 'examples', 'sample-events-input-analysis.jsonl');

describe('analyze-inputs (6d)', () => {
  it('loads telemetry events with input payloads', () => {
    const events = loadTelemetryEventsWithInput(SAMPLE_EVENTS);
    assert.equal(events.length, 3);
    assert.ok(events[0].input);
  });

  it('filters events by time window', () => {
    const events = loadTelemetryEventsWithInput(SAMPLE_EVENTS);
    const filtered = filterEventsByTime(events, {
      since: '2026-06-18T15:00:00Z',
      until: '2026-06-18T16:00:00Z',
    });
    assert.equal(filtered.length, 2);
  });

  it('builds per-request what-if report from telemetry batch', () => {
    const report = analyzeInputs({
      eventsPath: SAMPLE_EVENTS,
      qualityPreferences: { preset: 'balanced' },
    });

    assert.equal(report.analysis_metadata.schema_version, '0.1.0');
    assert.equal(report.summary.events_total, 3);
    assert.equal(report.summary.events_analyzed, 3);
    assert.ok(report.items.length === 3);

    const codingItem = report.items.find((item) => item.event_id === 'evt_sample002');
    assert.ok(codingItem);
    assert.ok(codingItem.classification.metric_ids.length >= 1);
    assert.ok(codingItem.current_cost_usd > 0);

    if (codingItem.recommendation) {
      assert.ok(codingItem.recommendation.savings_usd > 0);
      assert.ok(codingItem.recommendation.passes_quality_floor);
    }
  });

  it('aggregates summary savings by alternative model', () => {
    const report = analyzeInputs({
      eventsPath: SAMPLE_EVENTS,
      qualityPreferences: { preset: 'aggressive' },
    });

    assert.ok(report.summary.total_current_usd > 0);
    const altCount = Object.keys(report.summary.by_alternative_model).length;
    if (report.summary.events_with_recommendations > 0) {
      assert.ok(altCount >= 1);
      assert.ok(report.summary.total_potential_savings_usd > 0);
    }
  });
});
