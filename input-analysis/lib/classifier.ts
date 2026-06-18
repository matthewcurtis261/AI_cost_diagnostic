import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import type { ClassifierOutput, ClassifyInputsOptions } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const DEFAULT_CLASSIFIER_WEIGHTS_DIR = path.join(ROOT, 'classifier', 'weights');
export const DEFAULT_LABEL_MAP_PATH = path.join(ROOT, 'classifier', 'label_map.json');
export const DEFAULT_CLASSIFY_SCRIPT = path.join(ROOT, 'python', 'classify.py');

export function extractInputText(input: Record<string, unknown>): string {
  const parts: string[] = [];

  const messages = input.messages;
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;
      const role = typeof msg.role === 'string' ? msg.role : 'unknown';
      const content = msg.content;
      if (typeof content === 'string') {
        parts.push(`${role}: ${content}`);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === 'object') {
            const text =
              typeof block.text === 'string'
                ? block.text
                : typeof block.input_text === 'string'
                  ? block.input_text
                  : undefined;
            if (text) parts.push(`${role}: ${text}`);
          }
        }
      }
    }
  }

  for (const key of ['prompt', 'text', 'input', 'question', 'instruction'] as const) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      parts.push(value.trim());
    }
  }

  const tools = input.tools;
  if (Array.isArray(tools) && tools.length > 0) {
    parts.push('tools:');
    for (const tool of tools.slice(0, 8)) {
      if (!tool || typeof tool !== 'object') continue;
      const fn =
        tool.function && typeof tool.function === 'object'
          ? (tool.function as Record<string, unknown>)
          : tool;
      const name = typeof fn.name === 'string' ? fn.name : undefined;
      const desc = typeof fn.description === 'string' ? fn.description : '';
      if (name) parts.push(`- ${name}: ${desc}`.trim());
    }
  }

  const params = input.parameters;
  if (params && typeof params === 'object') {
    const bits: string[] = [];
    for (const key of ['temperature', 'max_tokens', 'response_format'] as const) {
      if (key in params) bits.push(`${key}=${String((params as Record<string, unknown>)[key])}`);
    }
    if (bits.length > 0) parts.push(`params: ${bits.join(', ')}`);
  }

  if (parts.length === 0) {
    return JSON.stringify(input);
  }
  return parts.join('\n');
}

export function classifierWeightsAvailable(weightsDir = DEFAULT_CLASSIFIER_WEIGHTS_DIR): boolean {
  return (
    fs.existsSync(path.join(weightsDir, 'model-meta.json')) &&
    (fs.existsSync(path.join(weightsDir, 'classifier-head.json')) ||
      fs.existsSync(path.join(weightsDir, 'classifier-head.pt')))
  );
}

export function classifyTexts(
  texts: string[],
  options: ClassifyInputsOptions = {},
): ClassifierOutput {
  if (texts.length === 0) {
    return {
      schema_version: '0.1.0',
      model: {
        base: 'distilbert-base-uncased',
        weights_path: options.weightsDir ?? DEFAULT_CLASSIFIER_WEIGHTS_DIR,
        label_count: 20,
      },
      predictions: [],
      warnings: [],
    };
  }

  const pythonPath = options.pythonPath ?? 'python';
  const scriptPath = DEFAULT_CLASSIFY_SCRIPT;
  const args = [scriptPath];
  if (options.weightsDir) args.push('--weights-dir', options.weightsDir);
  if (options.labelMapPath) args.push('--label-map', options.labelMapPath);
  if (options.forceFallback) args.push('--fallback');

  const payload = JSON.stringify({ texts });
  const result = spawnSync(pythonPath, args, {
    cwd: options.cwd ?? ROOT,
    input: payload,
    encoding: 'utf-8',
    timeout: options.timeoutMs ?? 120_000,
    shell: process.platform === 'win32',
  });

  if (result.error) {
    throw new Error(`Classifier subprocess failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `Classifier exited with code ${result.status}: ${result.stderr || result.stdout || 'unknown error'}`,
    );
  }

  return JSON.parse(result.stdout) as ClassifierOutput;
}

export function classifyTelemetryInputs(
  inputs: Array<Record<string, unknown>>,
  options: ClassifyInputsOptions = {},
): ClassifierOutput {
  const texts = inputs.map((input) => extractInputText(input));
  return classifyTexts(texts, options);
}

export function metricWeightsFromPrediction(
  prediction: ClassifierOutput['predictions'][number],
): Record<string, number> {
  const weights: Record<string, number> = {};
  for (const metricId of prediction.metric_ids) {
    const score = prediction.scores[metricId] ?? 0.5;
    weights[metricId] = Math.max(score, 0.1);
  }
  if (prediction.primary_metric && !weights[prediction.primary_metric]) {
    weights[prediction.primary_metric] = 0.5;
  }
  return weights;
}
