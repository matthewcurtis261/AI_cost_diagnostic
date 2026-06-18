import type {
  AssumptionsFile,
  EstimateLineItem,
  EstimateOptions,
  EstimateReport,
  FindingsDocument,
  PricingTable,
  UsageSource,
} from '../lib/types.js';
import { ESTIMATE_SCHEMA_VERSION } from '../lib/types.js';
import {
  aggregateTelemetry,
  loadTelemetryEvents,
  mergeAggregatesByFinding,
} from '../aggregate/telemetry.js';
import { selectBillableFindings } from '../lib/findings-filter.js';
import { buildAssumedUsage } from '../lib/heuristics.js';
import {
  calculateCost,
  getModelPricing,
  loadPricingTable,
  resolveModelId,
  roundUsd,
} from '../lib/pricing.js';
import { buildSavingsOpportunities } from '../lib/savings.js';

export function buildEstimate(
  findingsDoc: FindingsDocument,
  options: EstimateOptions,
  assumptions?: AssumptionsFile,
  pricing: PricingTable = loadPricingTable(options.pricingPath),
): EstimateReport {
  const billable = selectBillableFindings(findingsDoc.findings);
  const mode = options.eventsPath ? 'telemetry' : 'code_only';
  const telemetryByFinding = options.eventsPath
    ? mergeAggregatesByFinding(
        aggregateTelemetry(loadTelemetryEvents(options.eventsPath), {
          since: options.since,
          until: options.until,
        }),
      )
    : undefined;

  const lineItems: EstimateLineItem[] = [];
  const coverageNotes: string[] = [...(findingsDoc.summary.coverage_notes ?? [])];

  if (billable.length === 0) {
    coverageNotes.push('No billable call sites selected from findings');
  }

  for (const finding of billable) {
    const perFindingAssumptions = assumptions?.findings?.[finding.id];
    const resolved = resolveModelId(finding.model, {
      defaultModel: options.defaultModel ?? perFindingAssumptions?.model,
      overrideModel: perFindingAssumptions?.model,
      modelsDetected: findingsDoc.summary.models_detected,
      pricing,
    });

    const telemetry = telemetryByFinding?.get(finding.id);
    const usage = telemetry
      ? {
          calls: telemetry.calls,
          input_tokens: telemetry.input_tokens,
          output_tokens: telemetry.output_tokens,
          source: 'telemetry' as const,
        }
      : buildAssumedUsage(
          finding.call_type,
          finding.id,
          assumptions,
          options.callsPerMonth,
        );

    if (mode === 'telemetry' && !telemetry) {
      coverageNotes.push(
        `Finding ${finding.id} has no telemetry events; skipped in telemetry mode`,
      );
      continue;
    }

    const modelForPricing = telemetry?.model && telemetry.model !== 'unknown'
      ? telemetry.model
      : resolved.model;

    const modelPricing = getModelPricing(pricing, modelForPricing);
    const cost = calculateCost(usage.input_tokens, usage.output_tokens, modelPricing);

    if (!modelPricing) {
      coverageNotes.push(`No pricing entry for model "${modelForPricing}" (${finding.id})`);
    }

    lineItems.push({
      finding_id: finding.id,
      provider: finding.provider,
      model: modelForPricing,
      call_type: finding.call_type,
      location: finding.location,
      usage,
      cost,
      pricing_model_resolved: modelForPricing,
      notes: resolved.notes.length > 0 ? resolved.notes : undefined,
    });
  }

  const totals = sumLineItems(lineItems);
  const savings = buildSavingsOpportunities(lineItems, pricing, options.alternatives);

  if (mode === 'code_only') {
    coverageNotes.push(
      'Code-only mode: token volumes are assumed heuristics unless --assumptions is provided',
    );
  }

  return {
    estimate_metadata: {
      generated_at: new Date().toISOString(),
      schema_version: ESTIMATE_SCHEMA_VERSION,
      mode,
      findings_source: options.findingsPath,
      events_source: options.eventsPath,
      pricing_as_of: pricing.as_of,
      currency: pricing.currency,
      period: options.period ?? (mode === 'telemetry' ? 'event_window' : 'month'),
    },
    line_items: lineItems,
    totals,
    savings_opportunities: savings,
    coverage_notes: [...new Set(coverageNotes)],
  };
}

function sumLineItems(lineItems: EstimateLineItem[]) {
  const usage = lineItems.reduce(
    (acc, item) => {
      acc.calls += item.usage.calls;
      acc.input_tokens += item.usage.input_tokens;
      acc.output_tokens += item.usage.output_tokens;
      acc.total_usd = roundUsd(acc.total_usd + item.cost.total_usd);
      return acc;
    },
    {
      calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      source: 'mixed' as UsageSource,
      total_usd: 0,
    },
  );

  let source: UsageSource = 'mixed';
  if (lineItems.every((i) => i.usage.source === 'telemetry')) {
    source = 'telemetry';
  } else if (lineItems.every((i) => i.usage.source === 'assumed')) {
    source = 'assumed';
  }

  return { ...usage, source };
}
