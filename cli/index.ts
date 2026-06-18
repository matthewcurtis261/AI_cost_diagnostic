#!/usr/bin/env node
import { defaultEventsPath, parseEstimateArgs, runEstimate } from './estimate.js';
import { runScan } from './scan.js';
import { runSetup } from './setup.js';

function printUsage(): void {
  console.log(`diagnostic-agent — discover AI/LLM API usage in your codebase

Usage:
  diagnostic-agent setup --repo <path> [--nanoclaw-root <path>] [--mount-name <name>]
  diagnostic-agent scan [--scope dir1,dir2] [--nanoclaw-root <path>]
  diagnostic-agent estimate --findings <path> [options]

Commands:
  setup     Install skill, configure mount allowlist, register diagnostic agent group
  scan      Trigger ai-spend-discovery scan via Nanoclaw CLI channel
  estimate  Estimate AI spend from findings ± telemetry events

Estimate options:
  --findings <path>         ai-usage-findings.json from scan (required)
  --events <path>           Telemetry JSONL (default: ~/.diagnostic_agent/events.jsonl if --telemetry)
  --telemetry               Use telemetry mode (requires events file)
  --output <path>           Write spend-estimate.json
  --assumptions <path>      Volume/token assumptions for code-only mode
  --calls-per-month <n>     Default monthly call volume (code-only, default: 10000)
  --default-model <id>      Fallback model for config_ref/dynamic findings
  --alternatives <a,b,c>    Models to compare for savings
  --since / --until         Filter telemetry events by ISO timestamp
  --json                    Print full JSON report to stdout

Environment:
  NANOCLAW_ROOT   Path to Nanoclaw installation (auto-detected if sibling ../nanoclaw-main)
`);
}

function parseGlobalArgs(argv: string[]): {
  command: string | undefined;
  repo?: string;
  nanoclawRoot?: string;
  mountName?: string;
  scope?: string[];
  estimateArgs: string[];
} {
  const command = argv[0];
  let repo: string | undefined;
  let nanoclawRoot: string | undefined;
  let mountName: string | undefined;
  let scope: string[] | undefined;
  const estimateArgs: string[] = [];

  for (let i = 1; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (command === 'estimate') {
      estimateArgs.push(key);
      if (val && !key.startsWith('--json')) {
        if (
          key === '--repo' ||
          key === '--nanoclaw-root' ||
          key === '--mount-name' ||
          key === '--scope' ||
          key === '--findings' ||
          key === '--events' ||
          key === '--output' ||
          key === '--assumptions' ||
          key === '--pricing' ||
          key === '--calls-per-month' ||
          key === '--default-model' ||
          key === '--alternatives' ||
          key === '--since' ||
          key === '--until' ||
          key === '--period'
        ) {
          estimateArgs.push(val);
          i++;
        }
      }
      continue;
    }
    if (key === '--repo' && val) {
      repo = val;
      i++;
    } else if (key === '--nanoclaw-root' && val) {
      nanoclawRoot = val;
      i++;
    } else if (key === '--mount-name' && val) {
      mountName = val;
      i++;
    } else if (key === '--scope' && val) {
      scope = val.split(',').map((s) => s.trim()).filter(Boolean);
      i++;
    }
  }

  return { command, repo, nanoclawRoot, mountName, scope, estimateArgs };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printUsage();
    process.exit(0);
  }

  const { command, repo, nanoclawRoot, mountName, scope, estimateArgs } = parseGlobalArgs(argv);

  try {
    if (command === 'setup') {
      if (!repo) {
        console.error('setup requires --repo <path>');
        process.exit(2);
      }
      runSetup({ repo, nanoclawRoot, mountName });
    } else if (command === 'scan') {
      const code = await runScan({ scope, nanoclawRoot });
      process.exit(code);
    } else if (command === 'estimate') {
      const parsed = parseEstimateArgs(estimateArgs);
      if (!parsed.findings) {
        console.error('estimate requires --findings <path>');
        process.exit(2);
      }

      const useTelemetry =
        estimateArgs.includes('--telemetry') ||
        (parsed.events !== undefined && parsed.events.length > 0);

      runEstimate({
        findingsPath: parsed.findings,
        eventsPath: useTelemetry ? (parsed.events ?? defaultEventsPath()) : undefined,
        outputPath: parsed.output,
        assumptionsPath: parsed.assumptions,
        pricingPath: parsed.pricing,
        callsPerMonth: parsed.callsPerMonth,
        defaultModel: parsed.defaultModel,
        alternatives: parsed.alternatives,
        since: parsed.since,
        until: parsed.until,
        period: parsed.period,
        json: parsed.json,
      });
    } else {
      printUsage();
      process.exit(2);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
