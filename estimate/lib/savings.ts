import type { EstimateLineItem, PricingTable, SavingsOpportunity } from './types.js';
import { calculateCost, getModelPricing, roundUsd, supportsCallType } from './pricing.js';

export function buildSavingsOpportunities(
  lineItems: EstimateLineItem[],
  pricing: PricingTable,
  explicitAlternatives?: string[],
): SavingsOpportunity[] {
  const opportunities: SavingsOpportunity[] = [];

  for (const item of lineItems) {
    const alternatives = resolveAlternatives(item, pricing, explicitAlternatives);

    for (const alternativeModel of alternatives) {
      if (alternativeModel === item.model) continue;

      const altPricing = getModelPricing(pricing, alternativeModel);
      if (!altPricing) continue;

      const compatible = supportsCallType(altPricing, item.call_type);
      const altCost = compatible
        ? calculateCost(item.usage.input_tokens, item.usage.output_tokens, altPricing)
        : { input_usd: 0, output_usd: 0, total_usd: 0 };

      const savingsUsd = roundUsd(item.cost.total_usd - altCost.total_usd);
      const savingsPercent =
        item.cost.total_usd > 0
          ? roundUsd((savingsUsd / item.cost.total_usd) * 100)
          : 0;

      opportunities.push({
        finding_id: item.finding_id,
        current_model: item.model,
        alternative_model: alternativeModel,
        current_total_usd: item.cost.total_usd,
        alternative_total_usd: altCost.total_usd,
        savings_usd: savingsUsd,
        savings_percent: savingsPercent,
        compatible,
        notes: compatible
          ? undefined
          : [`${alternativeModel} does not support call_type ${item.call_type}`],
      });
    }
  }

  return opportunities
    .filter((o) => o.compatible && o.savings_usd > 0)
    .sort((a, b) => b.savings_usd - a.savings_usd);
}

function resolveAlternatives(
  item: EstimateLineItem,
  pricing: PricingTable,
  explicitAlternatives?: string[],
): string[] {
  if (explicitAlternatives && explicitAlternatives.length > 0) {
    return explicitAlternatives;
  }

  const defaults = pricing.default_alternatives?.[item.call_type] ?? [];
  return defaults.filter((model) => model !== item.model);
}
