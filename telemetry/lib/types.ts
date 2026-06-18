export const EVENT_SCHEMA_VERSION = '0.1.0';

export type CallType =
  | 'chat_completion'
  | 'embedding'
  | 'image'
  | 'speech'
  | 'agent_framework'
  | 'unknown';

export type TokenSource = 'provider' | 'estimated' | 'unknown';

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
  source: TokenSource;
}

export interface TelemetryEvent {
  event_id: string;
  timestamp: string;
  schema_version: typeof EVENT_SCHEMA_VERSION;
  finding_id?: string;
  call_site_fingerprint?: string;
  provider: string;
  model: string;
  call_type: CallType;
  input: Record<string, unknown>;
  tokens: TokenUsage;
  latency_ms?: number;
  metadata?: Record<string, unknown>;
}

export interface WriterOptions {
  filePath?: string;
  maxBytes?: number;
  maxEvents?: number;
  enabled?: boolean;
}

export interface InstrumentOptions {
  findingId?: string;
  label?: string;
  writer?: JsonlEventWriter;
  environment?: string;
}

/** Minimal writer interface used by wrappers. */
export interface JsonlEventWriter {
  write(event: TelemetryEvent): void;
  flush(): void;
  close(): void;
  isEnabled?(): boolean;
}
