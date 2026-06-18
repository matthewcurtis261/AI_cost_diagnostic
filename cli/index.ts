#!/usr/bin/env node
import { parseCheckArgs, runCheck } from './check.js';
import { parseDiscoverArgs, runDiscover } from './discover.js';
import { defaultEventsPath, parseEstimateArgs, runEstimate } from './estimate.js';
import { ExitCode } from './lib/exit-codes.js';
import { runScan } from './scan.js';
import { runSetup } from './setup.js';

function printUsage(): void {
  console.log(`diagnostic-agent — discover AI/LLM API usage in your codebase

Usage:
  diagnostic-agent discover --repo <path> [options]
  diagnostic-agent setup --repo <path> [--nanoclaw-root <path>] [--mount-name <name>]
  diagnostic-agent scan [--scope dir1,dir2] [--ci] [--output <path>] [--nanoclaw-root <path>]
  diagnostic-agent check --findings <path> [options]
  diagnostic-agent estimate --findings <path> [options]

Commands:
  discover  One-command setup + scan (or static CI scan)
  setup     Install skill, configure mount allowlist, register diagnostic agent group
  scan      Trigger ai-spend-discovery scan via Nanoclaw CLI channel
  check     Validate findings + optional policy gates (CI exit codes)
  estimate  Estimate AI spend from findings ± telemetry events

Discover options:
  --repo <path>             Target codebase (required)
  --static                  Pass A only — no Nanoclaw/Docker (CI-friendly)
  --ci                      Non-interactive; wait for agent output when not --static
  --output <path>           Write ai-usage-findings.json (default: ./ai-usage-findings.json)
  --scope dir1,dir2         Limit scan to subdirectories
  --skip-setup              Skip Nanoclaw setup if already configured
  --normalize               Dedupe + reconcile summary after scan
  --check [check opts]      Run check after scan (e.g. --check --fail-on-findings)
  --quiet                   Minimal logging

Scan options:
  --ci                      Wait for findings and copy to --output
  --output <path>           Destination for findings (requires --ci)
  --wait-timeout <ms>       Max wait for agent output (default: 600000)

Check options:
  --findings <path>         ai-usage-findings.json (required)
  --strict                  Treat semantic warnings as errors
  --fail-on-findings        Exit 3 if any billable call site exists
  --min-confidence <level>  Fail if billable findings below high|medium|low
  --max-billable <n>        Fail if billable count exceeds n
  --min-billable <n>        Fail if billable count below n
  --json                    Print JSON result

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

Exit codes:
  0  Success / policy passed
  1  Error (validation, scan trigger, I/O)
  2  Usage error
  3  Policy check failed (--fail-on-findings, thresholds)
  4  Scan timeout waiting for agent output

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
  checkArgs: string[];
  discoverArgs: string[];
  scanCi?: boolean;
  scanOutput?: string;
  scanWaitTimeout?: number;
  scanQuiet?: boolean;
} {
  const command = argv[0];
  let repo: string | undefined;
  let nanoclawRoot: string | undefined;
  let mountName: string | undefined;
  let scope: string[] | undefined;
  const estimateArgs: string[] = [];
  const checkArgs: string[] = [];
  const discoverArgs: string[] = [];
  let scanCi: boolean | undefined;
  let scanOutput: string | undefined;
  let scanWaitTimeout: number | undefined;
  let scanQuiet: boolean | undefined;

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

    if (command === 'check') {
      checkArgs.push(key);
      if (
        val &&
        (key === '--findings' ||
          key === '--min-confidence' ||
          key === '--max-billable' ||
          key === '--min-billable')
      ) {
        checkArgs.push(val);
        i++;
      }
      continue;
    }

    if (command === 'discover') {
      discoverArgs.push(key);
      if (
        val &&
        (key === '--repo' ||
          key === '--nanoclaw-root' ||
          key === '--mount-name' ||
          key === '--scope' ||
          key === '--output' ||
          key === '--wait-timeout' ||
          key === '--min-confidence' ||
          key === '--max-billable' ||
          key === '--min-billable')
      ) {
        discoverArgs.push(val);
        i++;
      }
      continue;
    }

    if (command === 'scan') {
      if (key === '--ci') scanCi = true;
      else if (key === '--quiet') scanQuiet = true;
      else if (key === '--output' && val) {
        scanOutput = val;
        i++;
      } else if (key === '--wait-timeout' && val) {
        scanWaitTimeout = Number(val);
        i++;
      } else if (key === '--nanoclaw-root' && val) {
        nanoclawRoot = val;
        i++;
      } else if (key === '--scope' && val) {
        scope = val.split(',').map((s) => s.trim()).filter(Boolean);
        i++;
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

  return {
    command,
    repo,
    nanoclawRoot,
    mountName,
    scope,
    estimateArgs,
    checkArgs,
    discoverArgs,
    scanCi,
    scanOutput,
    scanWaitTimeout,
    scanQuiet,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printUsage();
    process.exit(ExitCode.OK);
  }

  const {
    command,
    repo,
    nanoclawRoot,
    mountName,
    scope,
    estimateArgs,
    checkArgs,
    discoverArgs,
    scanCi,
    scanOutput,
    scanWaitTimeout,
    scanQuiet,
  } = parseGlobalArgs(argv);

  try {
    if (command === 'discover') {
      const parsed = parseDiscoverArgs(discoverArgs);
      if (!parsed.repo) {
        console.error('discover requires --repo <path>');
        process.exit(ExitCode.USAGE);
      }

      const hasCheckFlag = discoverArgs.includes('--check');
      const checkParsed = hasCheckFlag ? parseCheckArgs(parsed.checkArgs) : undefined;

      const code = await runDiscover({
        repo: parsed.repo,
        nanoclawRoot: parsed.nanoclawRoot ?? nanoclawRoot,
        mountName: parsed.mountName ?? mountName,
        scope: parsed.scope ?? scope,
        output: parsed.output,
        static: parsed.static,
        ci: parsed.ci,
        skipSetup: parsed.skipSetup,
        normalize: parsed.normalize,
        waitTimeoutMs: parsed.waitTimeoutMs,
        quiet: parsed.quiet,
        check: hasCheckFlag
          ? { findingsPath: parsed.output ?? '', ...checkParsed }
          : undefined,
      });
      process.exit(code);
    } else if (command === 'setup') {
      if (!repo) {
        console.error('setup requires --repo <path>');
        process.exit(ExitCode.USAGE);
      }
      runSetup({ repo, nanoclawRoot, mountName });
    } else if (command === 'scan') {
      if (scanCi && !scanOutput) {
        console.error('scan --ci requires --output <path>');
        process.exit(ExitCode.USAGE);
      }
      const code = await runScan({
        scope,
        nanoclawRoot,
        ci: scanCi,
        quiet: scanQuiet,
        waitTimeoutMs: scanWaitTimeout,
        outputPath: scanOutput,
      });
      process.exit(code);
    } else if (command === 'check') {
      const parsed = parseCheckArgs(checkArgs);
      if (!parsed.findings) {
        console.error('check requires --findings <path>');
        process.exit(ExitCode.USAGE);
      }
      const result = runCheck({
        findingsPath: parsed.findings,
        strict: parsed.strict,
        failOnFindings: parsed.failOnFindings,
        minConfidence: parsed.minConfidence,
        maxBillable: parsed.maxBillable,
        minBillable: parsed.minBillable,
        json: parsed.json,
        quiet: parsed.quiet,
      });
      process.exit(result.exitCode);
    } else if (command === 'estimate') {
      const parsed = parseEstimateArgs(estimateArgs);
      if (!parsed.findings) {
        console.error('estimate requires --findings <path>');
        process.exit(ExitCode.USAGE);
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
      process.exit(ExitCode.USAGE);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(ExitCode.ERROR);
  }
}

main();
