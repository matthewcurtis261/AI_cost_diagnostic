import fs from 'fs';
import os from 'os';
import path from 'path';

import { newEventId, resolveCorrelationId } from '../lib/fingerprint.js';
import { assertNoOutputFields, cloneInput } from '../lib/sanitize.js';
import {
  EVENT_SCHEMA_VERSION,
  type InstrumentOptions,
  type JsonlEventWriter,
  type TelemetryEvent,
  type TokenUsage,
  type WriterOptions,
} from '../lib/types.js';

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_EVENTS = 100_000;

export function defaultEventsPath(): string {
  const override = process.env.DIAGNOSTIC_AGENT_EVENTS_PATH;
  if (override) return path.resolve(override);
  return path.join(os.homedir(), '.diagnostic_agent', 'events.jsonl');
}

export class JsonlWriter implements JsonlEventWriter {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxEvents: number;
  private readonly enabled: boolean;
  private eventCount = 0;

  constructor(options: WriterOptions = {}) {
    this.filePath = options.filePath ?? defaultEventsPath();
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.enabled = options.enabled ?? process.env.DIAGNOSTIC_AGENT_TELEMETRY !== '0';
    this.eventCount = this.countExistingEvents();
  }

  get path(): string {
    return this.filePath;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  write(event: TelemetryEvent): void {
    if (!this.enabled) return;

    assertNoOutputFields(event);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.rotateIfNeeded();
    fs.appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, 'utf-8');
    this.eventCount += 1;
  }

  flush(): void {
    // appendFileSync is synchronous; nothing to flush.
  }

  close(): void {
    this.flush();
  }

  private countExistingEvents(): number {
    if (!fs.existsSync(this.filePath)) return 0;
    const content = fs.readFileSync(this.filePath, 'utf-8');
    if (!content.trim()) return 0;
    return content.split('\n').filter(Boolean).length;
  }

  private rotateIfNeeded(): void {
    if (!fs.existsSync(this.filePath)) return;

    const stats = fs.statSync(this.filePath);
    if (stats.size >= this.maxBytes || this.eventCount >= this.maxEvents) {
      const rotated = `${this.filePath}.${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.renameSync(this.filePath, rotated);
      this.eventCount = 0;
    }
  }
}

let defaultWriter: JsonlWriter | undefined;

export function getDefaultWriter(): JsonlWriter {
  if (!defaultWriter) {
    defaultWriter = new JsonlWriter();
  }
  return defaultWriter;
}

export interface BuildEventParams {
  provider: string;
  model: string;
  call_type: TelemetryEvent['call_type'];
  input: Record<string, unknown>;
  tokens: TokenUsage;
  latency_ms?: number;
  metadata?: Record<string, unknown>;
  correlation?: ReturnType<typeof resolveCorrelationId>;
}

export function buildEvent(params: BuildEventParams): TelemetryEvent {
  assertNoOutputFields(params.input, 'input', false);

  return {
    event_id: newEventId(),
    timestamp: new Date().toISOString(),
    schema_version: EVENT_SCHEMA_VERSION,
    provider: params.provider,
    model: params.model,
    call_type: params.call_type,
    input: cloneInput(params.input),
    tokens: params.tokens,
    latency_ms: params.latency_ms,
    metadata: params.metadata,
    ...params.correlation,
  };
}

export function recordEvent(
  params: BuildEventParams,
  writer: JsonlEventWriter = getDefaultWriter(),
): TelemetryEvent {
  const event = buildEvent(params);
  writer.write(event);
  return event;
}

export function correlationFromOptions(options: InstrumentOptions = {}) {
  return resolveCorrelationId({
    findingId: options.findingId,
    label: options.label,
  });
}
