import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  DEFAULT_OPEN_PRICING_PATH,
  loadOpenPricingFile,
  mergeOpenPricing,
} from './open-pricing.js';
import type { CostBreakdown, ModelPricing, PricingTable } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PRICING_PATH = path.join(__dirname, '..', 'pricing', 'models.json');

const DYNAMIC_MODELS = new Set(['dynamic', 'config_ref', 'unknown']);

export interface LoadPricingOptions {
  openPricingPath?: string;
  includeOpenPricing?: boolean;
}

export function loadPricingTable(
  pricingPath = DEFAULT_PRICING_PATH,
  options: LoadPricingOptions = {},
): PricingTable {
  const base = JSON.parse(fs.readFileSync(pricingPath, 'utf-8')) as PricingTable;
  const includeOpen = options.includeOpenPricing !== false;

  if (!includeOpen) {
    return { ...base, pricing_sources: [pricingPath] };
  }

  const openPath = options.openPricingPath ?? DEFAULT_OPEN_PRICING_PATH;
  const open = loadOpenPricingFile(openPath);
  if (!open) {
    return { ...base, pricing_sources: [pricingPath] };
  }

  return mergeOpenPricing(base, open, { basePath: pricingPath, openPath });
}

export function isResolvableModel(model: string): boolean {
  return !DYNAMIC_MODELS.has(model);
}

export function resolveModelId(
  findingModel: string,
  options: {
    defaultModel?: string;
    overrideModel?: string;
    modelsDetected?: string[];
    pricing: PricingTable;
  },
): { model: string; notes: string[] } {
  const notes: string[] = [];

  if (options.overrideModel) {
    return { model: options.overrideModel, notes };
  }

  if (isResolvableModel(findingModel) && options.pricing.models[findingModel]) {
    return { model: findingModel, notes };
  }

  if (isResolvableModel(findingModel) && !options.pricing.models[findingModel]) {
    notes.push(`Model "${findingModel}" not in pricing table; using fallback`);
    return { model: findingModel, notes };
  }

  const detected = (options.modelsDetected ?? []).find((m) => options.pricing.models[m]);
  if (detected) {
    notes.push(`Resolved ${findingModel} → ${detected} from scan summary`);
    return { model: detected, notes };
  }

  if (options.defaultModel) {
    notes.push(`Resolved ${findingModel} → ${options.defaultModel} (CLI default)`);
    return { model: options.defaultModel, notes };
  }

  notes.push(`Could not resolve model "${findingModel}"; cost may be zero`);
  return { model: findingModel, notes };
}

export function getModelPricing(
  pricing: PricingTable,
  modelId: string,
): ModelPricing | undefined {
  if (pricing.models[modelId]) return pricing.models[modelId];

  const normalized = modelId.toLowerCase();
  for (const [key, value] of Object.entries(pricing.models)) {
    if (key.toLowerCase() === normalized) return value;
    if (normalized.startsWith(key.toLowerCase())) return value;
  }

  return undefined;
}

export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  modelPricing: ModelPricing | undefined,
): CostBreakdown {
  if (!modelPricing) {
    return { input_usd: 0, output_usd: 0, total_usd: 0 };
  }

  const input_usd = (inputTokens / 1_000_000) * modelPricing.input_per_million;
  const output_usd = (outputTokens / 1_000_000) * modelPricing.output_per_million;
  const total_usd = roundUsd(input_usd + output_usd);

  return {
    input_usd: roundUsd(input_usd),
    output_usd: roundUsd(output_usd),
    total_usd,
  };
}

export function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function supportsCallType(modelPricing: ModelPricing, callType: string): boolean {
  return modelPricing.call_types.includes(callType);
}
