import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertNoOutputFields, ForbiddenOutputFieldError } from '../telemetry/lib/sanitize.js';
import { resolveCorrelationId } from '../telemetry/lib/fingerprint.js';
import { JsonlWriter, buildEvent } from '../telemetry/writer/jsonl-writer.js';
import { instrumentOpenAI } from '../telemetry/wrappers/openai.js';
import { instrumentAnthropic } from '../telemetry/wrappers/anthropic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

describe('telemetry sanitize', () => {
  it('allows message content in input.messages', () => {
    assert.doesNotThrow(() =>
      assertNoOutputFields({
        input: {
          messages: [{ role: 'user', content: 'hello' }],
        },
      }),
    );
  });

  it('rejects top-level output fields', () => {
    assert.throws(
      () => assertNoOutputFields({ output: 'secret completion text' }),
      ForbiddenOutputFieldError,
    );
  });
});

describe('telemetry correlation', () => {
  it('uses finding_id when provided', () => {
    const result = resolveCorrelationId({ findingId: 'f001' });
    assert.equal(result.finding_id, 'f001');
    assert.equal(result.call_site_fingerprint, undefined);
  });

  it('generates call_site_fingerprint otherwise', () => {
    const result = resolveCorrelationId({ label: 'test-label' });
    assert.match(result.call_site_fingerprint ?? '', /^cs_[a-f0-9]{12}$/);
  });
});

describe('telemetry writer + wrappers', () => {
  let tmpDir: string;
  let eventsPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-agent-telemetry-'));
    eventsPath = path.join(tmpDir, 'events.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes schema-valid events from OpenAI wrapper', async () => {
    const writer = new JsonlWriter({ filePath: eventsPath, enabled: true });
    const client = {
      chat: {
        completions: {
          create: async (..._args: unknown[]) => ({
            model: 'gpt-4o-mini',
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            choices: [{ message: { content: 'should not be persisted' } }],
          }),
        },
      },
    };

    instrumentOpenAI(client, { findingId: 'f001', writer, label: 'unit-test' });
    await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.2,
    });

    const lines = fs.readFileSync(eventsPath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 1);
    const event = JSON.parse(lines[0]!);
    assert.equal(event.finding_id, 'f001');
    assert.equal(event.provider, 'openai');
    assert.equal(event.tokens.input_tokens, 10);
    assert.equal(event.tokens.output_tokens, 5);
    assert.equal(event.input.messages[0].content, 'hi');
    assert.equal(event.output, undefined);
    assert.equal(event.choices, undefined);

    execFileSync('pnpm', ['run', 'validate-events', eventsPath], {
      cwd: ROOT,
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
  });

  it('writes schema-valid events from Anthropic wrapper', async () => {
    const writer = new JsonlWriter({ filePath: eventsPath, enabled: true });
    const client = {
      messages: {
        create: async (..._args: unknown[]) => ({
          model: 'claude-3-5-sonnet-20241022',
          usage: { input_tokens: 20, output_tokens: 8 },
          content: [{ type: 'text', text: 'not persisted' }],
        }),
      },
    };

    instrumentAnthropic(client, { findingId: 'f002', writer });
    await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hello' }],
    });

    const event = JSON.parse(fs.readFileSync(eventsPath, 'utf-8').trim());
    assert.equal(event.finding_id, 'f002');
    assert.equal(event.provider, 'anthropic');
    assert.equal(event.tokens.input_tokens, 20);
  });

  it('buildEvent rejects forbidden output keys in input', () => {
    assert.throws(() =>
      buildEvent({
        provider: 'openai',
        model: 'gpt-4o',
        call_type: 'chat_completion',
        input: { completion: 'leaked' },
        tokens: { input_tokens: 1, output_tokens: 1, source: 'provider' },
        correlation: { finding_id: 'f001' },
      }),
    );
  });
});

describe('sample events fixture', () => {
  it('validates examples/sample-events.jsonl', () => {
    const sample = path.join(ROOT, 'examples', 'sample-events.jsonl');
    execFileSync('pnpm', ['run', 'validate-events', sample], {
      cwd: ROOT,
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
  });
});
