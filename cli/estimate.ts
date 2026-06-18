import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AssumptionsFile, EstimateOptions, FindingsDocument } from '../estimate/lib/types.js';
import { buildEstimate } from '../estimate/index.js';

export interface RunEstimateOptions extends EstimateOptions {
  json?: boolean;
}

export interface EstimateCliOptions {
  findings?: string;
  events?: string;
  output?: string;
  assumptions?: string;
  pricing?: string;
  callsPerMonth?: number;
  defaultModel?: string;
  alternatives?: string[];
  since?: string;
  until?: string;
  period?: 'month' | 'day' | 'event_window';
  json?: boolean;
}

export function parseEstimateArgs(argv: string[]): EstimateCliOptions {
  const options: EstimateCliOptions = {};

  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--findings' && val) {
      options.findings = val;
      i++;
    } else if (key === '--events' && val) {
      options.events = val;
      i++;
    } else if (key === '--output' && val) {
      options.output = val;
      i++;
    } else if (key === '--assumptions' && val) {
      options.assumptions = val;
      i++;
    } else if (key === '--pricing' && val) {
      options.pricing = val;
      i++;
    } else if (key === '--calls-per-month' && val) {
      options.callsPerMonth = Number(val);
      i++;
    } else if (key === '--default-model' && val) {
      options.defaultModel = val;
      i++;
    } else if (key === '--alternatives' && val) {
      options.alternatives = val.split(',').map((s) => s.trim()).filter(Boolean);
      i++;
    } else if (key === '--since' && val) {
      options.since = val;
      i++;
    } else if (key === '--until' && val) {
      options.until = val;
      i++;
    } else if (key === '--period' && val) {
      options.period = val as EstimateCliOptions['period'];
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

export function runEstimate(options: RunEstimateOptions): void {
  if (!fs.existsSync(options.findingsPath)) {
    throw new Error(`Findings file not found: ${options.findingsPath}`);
  }

  if (options.eventsPath && !fs.existsSync(options.eventsPath)) {
    throw new Error(`Events file not found: ${options.eventsPath}`);
  }

  const findingsDoc = JSON.parse(
    fs.readFileSync(options.findingsPath, 'utf-8'),
  ) as FindingsDocument;

  let assumptions: AssumptionsFile | undefined;
  if (options.assumptionsPath) {
    if (!fs.existsSync(options.assumptionsPath)) {
      throw new Error(`Assumptions file not found: ${options.assumptionsPath}`);
    }
    assumptions = JSON.parse(fs.readFileSync(options.assumptionsPath, 'utf-8')) as AssumptionsFile;
  }

  const report = buildEstimate(findingsDoc, options, assumptions);

  if (options.outputPath) {
    const resolved = path.resolve(options.outputPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printSummary(report);

  if (options.outputPath) {
    console.log('');
    console.log(`Wrote ${options.outputPath}`);
  }
}

function printSummary(report: ReturnType<typeof buildEstimate>): void {
  const { estimate_metadata: meta, totals, line_items, savings_opportunities } = report;

  console.log(`AI spend estimate (${meta.mode}, ${meta.currency})`);
  console.log(`Pricing as of: ${meta.pricing_as_of}`);
  console.log(`Findings:      ${meta.findings_source}`);
  if (meta.events_source) console.log(`Events:        ${meta.events_source}`);
  console.log('');

  for (const item of line_items) {
    console.log(
      `${item.finding_id}  ${item.model.padEnd(28)}  $${item.cost.total_usd.toFixed(4)}  (${item.usage.calls} calls, ${item.usage.source})`,
    );
    console.log(`  ${item.location.file}:${item.location.lines.join('-')}`);
  }

  console.log('');
  console.log(
    `Total: $${totals.total_usd.toFixed(4)}  |  ${totals.calls} calls  |  ${totals.input_tokens} in / ${totals.output_tokens} out tokens`,
  );

  if (savings_opportunities.length > 0) {
    console.log('');
    console.log('Top savings opportunities:');
    for (const opp of savings_opportunities.slice(0, 5)) {
      console.log(
        `  ${opp.finding_id}: ${opp.current_model} → ${opp.alternative_model}  save $${opp.savings_usd.toFixed(4)} (${opp.savings_percent}%)`,
      );
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
