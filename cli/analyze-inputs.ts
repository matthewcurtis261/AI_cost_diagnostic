import fs from 'fs';
import os from 'os';
import path from 'path';

import { analyzeInputs } from '../input-analysis/lib/analyze-inputs.js';
import type { AnalyzeInputsOptions, QualityPreferences } from '../input-analysis/lib/types.js';

export interface AnalyzeInputsCliOptions {
  events?: string;
  output?: string;
  since?: string;
  until?: string;
  pricing?: string;
  openPricing?: string;
  includeOpenPricing?: boolean;
  qualityScores?: string;
  alternatives?: string[];
  preset?: QualityPreferences['preset'];
  qualityFloor?: number;
  qualitySacrifice?: number;
  json?: boolean;
}

export function parseAnalyzeInputsArgs(argv: string[]): AnalyzeInputsCliOptions {
  const options: AnalyzeInputsCliOptions = {};

  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];

    if (key === '--events' && val) {
      options.events = val;
      i++;
    } else if (key === '--output' && val) {
      options.output = val;
      i++;
    } else if (key === '--since' && val) {
      options.since = val;
      i++;
    } else if (key === '--until' && val) {
      options.until = val;
      i++;
    } else if (key === '--pricing' && val) {
      options.pricing = val;
      i++;
    } else if (key === '--open-pricing' && val) {
      options.openPricing = val;
      i++;
    } else if (key === '--no-open-pricing') {
      options.includeOpenPricing = false;
    } else if (key === '--quality-scores' && val) {
      options.qualityScores = val;
      i++;
    } else if (key === '--alternatives' && val) {
      options.alternatives = val.split(',').map((s) => s.trim()).filter(Boolean);
      i++;
    } else if (key === '--preset' && val) {
      options.preset = val as AnalyzeInputsCliOptions['preset'];
      i++;
    } else if (key === '--quality-floor' && val) {
      options.qualityFloor = Number(val);
      i++;
    } else if (key === '--quality-sacrifice' && val) {
      options.qualitySacrifice = Number(val);
      i++;
    } else if (key === '--json') {
      options.json = true;
    }
  }

  return options;
}

export function defaultEventsPath(): string {
  return path.join(os.homedir(), '.diagnostic_agent', 'events.jsonl');
}

export function runAnalyzeInputs(cli: AnalyzeInputsCliOptions): void {
  const eventsPath = cli.events ?? defaultEventsPath();

  if (!fs.existsSync(eventsPath)) {
    throw new Error(`Events file not found: ${eventsPath}`);
  }

  const options: AnalyzeInputsOptions = {
    eventsPath,
    outputPath: cli.output,
    since: cli.since,
    until: cli.until,
    pricingPath: cli.pricing,
    openPricingPath: cli.openPricing,
    includeOpenPricing: cli.includeOpenPricing,
    qualityScoresPath: cli.qualityScores,
    alternatives: cli.alternatives,
    qualityPreferences: {
      preset: cli.preset,
      quality_floor_pct: cli.qualityFloor,
      quality_sacrifice_per_cost: cli.qualitySacrifice,
    },
  };

  const report = analyzeInputs(options);

  if (cli.output) {
    const resolved = path.resolve(cli.output);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (cli.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printSummary(report);

  if (cli.output) {
    console.log('');
    console.log(`Wrote ${cli.output}`);
  }
}

function printSummary(report: ReturnType<typeof analyzeInputs>): void {
  const { analysis_metadata: meta, summary, items } = report;

  console.log('Input-aware what-if analysis (offline)');
  console.log(`Events:         ${meta.events_source}`);
  console.log(`Pricing as of:  ${meta.pricing_as_of}`);
  console.log(
    `Quality preset: ${meta.quality_preset} (floor ${(meta.quality_floor_pct * 100).toFixed(0)}%, sacrifice ${meta.quality_sacrifice_per_cost})`,
  );
  if (meta.classifier_runtime) {
    console.log(`Classifier:     ${meta.classifier_runtime}`);
  }
  console.log('');

  const actionable = items.filter((item) => item.recommendation);
  for (const item of actionable.slice(0, 10)) {
    const rec = item.recommendation!;
    console.log(
      `${item.event_id}  ${item.model} → ${rec.alternative_model}  save $${rec.savings_usd.toFixed(6)} (${rec.savings_percent}%)`,
    );
    console.log(
      `  metrics: ${item.classification.metric_ids.join(', ') || 'none'}  quality ${formatQuality(item.current_quality)} → ${formatQuality(rec.alternative_quality)}`,
    );
  }

  if (actionable.length > 10) {
    console.log(`  ... and ${actionable.length - 10} more recommendations`);
  }

  console.log('');
  console.log(
    `Analyzed ${summary.events_analyzed}/${summary.events_total} events  |  current $${summary.total_current_usd.toFixed(6)}  |  potential savings $${summary.total_potential_savings_usd.toFixed(6)}`,
  );
  console.log(
    `Recommendations: ${summary.events_with_recommendations}  |  skipped: ${summary.events_skipped}`,
  );

  const altEntries = Object.entries(summary.by_alternative_model).sort(
    (a, b) => b[1].savings_usd - a[1].savings_usd,
  );
  if (altEntries.length > 0) {
    console.log('');
    console.log('Top alternative models:');
    for (const [model, stats] of altEntries.slice(0, 5)) {
      console.log(`  ${model}: ${stats.count} events, $${stats.savings_usd.toFixed(6)} savings`);
    }
  }

  if (report.coverage_notes.length > 0) {
    console.log('');
    console.log('Notes:');
    for (const note of report.coverage_notes.slice(0, 5)) {
      console.log(`  - ${note}`);
    }
  }
}

function formatQuality(value: number | null | undefined): string {
  if (value == null) return 'n/a';
  return value.toFixed(3);
}
