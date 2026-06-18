import type { InstrumentOptions } from '../lib/types.js';
import { cloneInput } from '../lib/sanitize.js';
import {
  buildEvent,
  correlationFromOptions,
  getDefaultWriter,
  type BuildEventParams,
} from '../writer/jsonl-writer.js';
import type { TokenUsage } from '../lib/types.js';

type ChatCreateFn = (...args: unknown[]) => Promise<unknown>;
type EmbeddingsCreateFn = (...args: unknown[]) => Promise<unknown>;

export interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface OpenAIChatResponse {
  model?: string;
  usage?: OpenAIUsage;
}

export interface OpenAIClientLike {
  chat: {
    completions: {
      create: ChatCreateFn;
    };
  };
  embeddings?: {
    create: EmbeddingsCreateFn;
  };
}

function usageFromOpenAI(usage?: OpenAIUsage): TokenUsage {
  return {
    input_tokens: usage?.prompt_tokens ?? 0,
    output_tokens: usage?.completion_tokens ?? 0,
    total_tokens: usage?.total_tokens,
    source: usage ? 'provider' : 'unknown',
  };
}

function extractModel(args: unknown[], response: OpenAIChatResponse): string {
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

function wrapChatCreate(
  original: ChatCreateFn,
  options: InstrumentOptions,
): ChatCreateFn {
  return async (...args: unknown[]) => {
    const started = Date.now();
    const response = (await original(...args)) as OpenAIChatResponse;
    const request =
      args[0] && typeof args[0] === 'object'
        ? (args[0] as Record<string, unknown>)
        : {};

    const params: BuildEventParams = {
      provider: 'openai',
      model: extractModel(args, response),
      call_type: 'chat_completion',
      input: {
        messages: request.messages ?? [],
        tools: request.tools ?? null,
        parameters: {
          max_tokens: request.max_tokens,
          temperature: request.temperature,
          response_format: request.response_format,
          top_p: request.top_p,
        },
      },
      tokens: usageFromOpenAI(response.usage),
      latency_ms: Date.now() - started,
      metadata: {
        sdk: 'openai-typescript',
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

function wrapEmbeddingsCreate(
  original: EmbeddingsCreateFn,
  options: InstrumentOptions,
): EmbeddingsCreateFn {
  return async (...args: unknown[]) => {
    const started = Date.now();
    const response = (await original(...args)) as OpenAIChatResponse;
    const request =
      args[0] && typeof args[0] === 'object'
        ? (args[0] as Record<string, unknown>)
        : {};

    const params: BuildEventParams = {
      provider: 'openai',
      model: extractModel(args, response),
      call_type: 'embedding',
      input: cloneInput({
        input: request.input,
        model: request.model,
        dimensions: request.dimensions,
      }),
      tokens: usageFromOpenAI(response.usage),
      latency_ms: Date.now() - started,
      metadata: {
        sdk: 'openai-typescript',
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

/**
 * Wrap an OpenAI client so chat.completions.create (and embeddings.create if present)
 * emit telemetry events. The full API response is still returned to application code.
 */
export function instrumentOpenAI<T extends OpenAIClientLike>(
  client: T,
  options: InstrumentOptions = {},
): T {
  client.chat.completions.create = wrapChatCreate(
    client.chat.completions.create.bind(client.chat.completions),
    options,
  );

  if (client.embeddings?.create) {
    client.embeddings.create = wrapEmbeddingsCreate(
      client.embeddings.create.bind(client.embeddings),
      options,
    );
  }

  return client;
}
