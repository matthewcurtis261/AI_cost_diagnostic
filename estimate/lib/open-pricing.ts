import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import type { ModelPricing, PricingTable } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OPEN_PRICING_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'input-analysis',
  'pricing',
  'models-open.json',
);

export interface OpenPricingFile {
  schema_version: string;
  currency: string;
  unit: string;
  as_of: string;
  notes?: string;
  self_hosted_compute?: {
    input_per_million: number;
    output_per_million: number;
    notes?: string;
  };
  models: Record<
    string,
    ModelPricing & {
      deployment?: 'api' | 'self_hosted';
      api_via?: string;
      quality_score_key?: string;
    }
  >;
}

export interface MergeOpenPricingOptions {
  basePath: string;
  openPath: string;
}

function avgTokenCost(model: ModelPricing): number {
  return (model.input_per_million + model.output_per_million) / 2;
}

/** Merge open/smaller model API + self-hosted pricing into the base proprietary table. */
export function mergeOpenPricing(
  base: PricingTable,
  open: OpenPricingFile,
  paths: MergeOpenPricingOptions,
): PricingTable {
  const models: Record<string, ModelPricing> = { ...base.models };

  for (const [modelId, entry] of Object.entries(open.models)) {
    if (models[modelId]) continue;
    models[modelId] = { ...entry };
  }

  const existingChat = base.default_alternatives?.chat_completion ?? [];
  const openChatIds = Object.entries(open.models)
    .filter(([, m]) => m.call_types.includes('chat_completion'))
    .sort(([, a], [, b]) => avgTokenCost(a) - avgTokenCost(b))
    .map(([id]) => id);

  const mergedChat = [...existingChat];
  for (const id of openChatIds) {
    if (!mergedChat.includes(id)) mergedChat.push(id);
  }

  const notes = [base.notes, open.notes].filter(Boolean).join(' ');

  return {
    ...base,
    models,
    notes: notes || base.notes,
    default_alternatives: {
      ...base.default_alternatives,
      chat_completion: mergedChat,
    },
    pricing_sources: [paths.basePath, paths.openPath],
    self_hosted_compute: open.self_hosted_compute,
  };
}

export function loadOpenPricingFile(openPath = DEFAULT_OPEN_PRICING_PATH): OpenPricingFile | undefined {
  if (!fs.existsSync(openPath)) return undefined;
  return JSON.parse(fs.readFileSync(openPath, 'utf-8')) as OpenPricingFile;
}
