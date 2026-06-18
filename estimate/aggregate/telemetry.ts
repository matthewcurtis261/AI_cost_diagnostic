import fs from 'fs';

import type { TelemetryEvent } from '../lib/types.js';

export interface AggregatedUsage {
  finding_id: string;
  provider: string;
  model: string;
  call_type: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
}

export interface AggregateOptions {
  since?: string;
  until?: string;
}

export function loadTelemetryEvents(eventsPath: string): TelemetryEvent[] {
  const content = fs.readFileSync(eventsPath, 'utf-8');
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TelemetryEvent);
}

export function aggregateTelemetry(
  events: TelemetryEvent[],
  options: AggregateOptions = {},
): Map<string, AggregatedUsage> {
  const sinceMs = options.since ? Date.parse(options.since) : undefined;
  const untilMs = options.until ? Date.parse(options.until) : undefined;

  const buckets = new Map<string, AggregatedUsage>();

  for (const event of events) {
    if (!event.finding_id) continue;

    const ts = Date.parse(event.timestamp);
    if (sinceMs !== undefined && ts < sinceMs) continue;
    if (untilMs !== undefined && ts > untilMs) continue;

    const key = `${event.finding_id}::${event.model}::${event.call_type}`;
    const existing = buckets.get(key) ?? {
      finding_id: event.finding_id,
      provider: event.provider,
      model: event.model,
      call_type: event.call_type,
      calls: 0,
      input_tokens: 0,
      output_tokens: 0,
    };

    existing.calls += 1;
    existing.input_tokens += event.tokens.input_tokens;
    existing.output_tokens += event.tokens.output_tokens;
    buckets.set(key, existing);
  }

  return buckets;
}

export function mergeAggregatesByFinding(
  aggregates: Map<string, AggregatedUsage>,
): Map<string, AggregatedUsage> {
  const byFinding = new Map<string, AggregatedUsage>();

  for (const agg of aggregates.values()) {
    const existing = byFinding.get(agg.finding_id);
    if (!existing) {
      byFinding.set(agg.finding_id, { ...agg });
      continue;
    }

    existing.calls += agg.calls;
    existing.input_tokens += agg.input_tokens;
    existing.output_tokens += agg.output_tokens;
    if (agg.model !== 'unknown') existing.model = agg.model;
  }

  return byFinding;
}
