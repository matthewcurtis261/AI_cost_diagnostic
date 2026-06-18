import type { InstrumentOptions } from '../lib/types.js';
import { cloneInput } from '../lib/sanitize.js';
import {
  buildEvent,
  correlationFromOptions,
  getDefaultWriter,
  type BuildEventParams,
} from '../writer/jsonl-writer.js';
import type { TokenUsage } from '../lib/types.js';

type MessagesCreateFn = (...args: unknown[]) => Promise<unknown>;

export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
}

export interface AnthropicMessageResponse {
  model?: string;
  usage?: AnthropicUsage;
}

export interface AnthropicClientLike {
  messages: {
    create: MessagesCreateFn;
  };
}

function usageFromAnthropic(usage?: AnthropicUsage): TokenUsage {
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    source: usage ? 'provider' : 'unknown',
  };
}

function extractModel(args: unknown[], response: AnthropicMessageResponse): string {
  const first = args[0];
  if (first && typeof first === 'object' && 'model' in first) {
    const model = (first as { model?: unknown }).model;
    if (typeof model === 'string' && model.length > 0) return model;
  }
  if (typeof response.model === 'string' && response.model.length > 0) {
    return response.model;
  }
  return 'unknown';
}

function wrapMessagesCreate(
  original: MessagesCreateFn,
  options: InstrumentOptions,
): MessagesCreateFn {
  return async (...args: unknown[]) => {
    const started = Date.now();
    const response = (await original(...args)) as AnthropicMessageResponse;
    const request =
      args[0] && typeof args[0] === 'object'
        ? (args[0] as Record<string, unknown>)
        : {};

    const params: BuildEventParams = {
      provider: 'anthropic',
      model: extractModel(args, response),
      call_type: 'chat_completion',
      input: {
        messages: request.messages ?? [],
        system: request.system ?? null,
        tools: request.tools ?? null,
        parameters: {
          max_tokens: request.max_tokens,
          temperature: request.temperature,
          top_p: request.top_p,
        },
      },
      tokens: usageFromAnthropic(response.usage),
      latency_ms: Date.now() - started,
      metadata: {
        sdk: 'anthropic-typescript',
        environment: options.environment ?? process.env.NODE_ENV,
        label: options.label,
      },
      correlation: correlationFromOptions(options),
    };

    const writer = options.writer ?? getDefaultWriter();
    if (writer.isEnabled?.() ?? true) {
      writer.write(buildEvent(params));
    }

    return response;
  };
}

/** Wrap an Anthropic client so messages.create emits telemetry events. */
export function instrumentAnthropic<T extends AnthropicClientLike>(
  client: T,
  options: InstrumentOptions = {},
): T {
  client.messages.create = wrapMessagesCreate(
    client.messages.create.bind(client.messages),
    options,
  );
  return client;
}
