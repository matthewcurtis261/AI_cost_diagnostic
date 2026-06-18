export {
  EVENT_SCHEMA_VERSION,
  type CallType,
  type InstrumentOptions,
  type JsonlEventWriter,
  type TelemetryEvent,
  type TokenUsage,
  type WriterOptions,
} from '../lib/types.js';

export { assertNoOutputFields, ForbiddenOutputFieldError } from '../lib/sanitize.js';
export { newEventId, resolveCorrelationId } from '../lib/fingerprint.js';

export {
  JsonlWriter,
  buildEvent,
  defaultEventsPath,
  getDefaultWriter,
  recordEvent,
} from '../writer/jsonl-writer.js';

export { instrumentOpenAI } from './openai.js';
export { instrumentAnthropic } from './anthropic.js';
