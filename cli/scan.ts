import { spawnSync } from 'child_process';

import { ExitCode } from './lib/exit-codes.js';
import { findNanoclawRoot } from './lib/nanoclaw.js';
import { readState } from './lib/state.js';
import { resolveAgentFindings } from './lib/findings-path.js';

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_CI_WAIT_MS = 600_000;

export interface ScanOptions {
  scope?: string[];
  nanoclawRoot?: string;
  message?: string;
  ci?: boolean;
  quiet?: boolean;
  waitTimeoutMs?: number;
  outputPath?: string;
}

function buildScanPrompt(scope?: string[], ci?: boolean): string {
  const scopeLine =
    scope && scope.length > 0
      ? `Scope: scan only these subdirectories: ${scope.join(', ')}.`
      : 'Scope: scan the whole mounted repo (exclude node_modules, .git, dist, etc.).';

  const ciLine = ci
    ? ' CI mode: write complete findings to /workspace/agent/ai-usage-findings.json without interactive questions.'
    : '';

  return (
    'Run the ai-spend-discovery skill now.' +
    ciLine +
    ' ' +
    scopeLine +
    ' Write findings to /workspace/agent/ai-usage-findings.json conforming to the schema, ' +
    'populate summary.coverage, then send the file to me.'
  );
}

export async function runScan(options: ScanOptions): Promise<number> {
  const state = readState();
  const nanoclawRoot = findNanoclawRoot(options.nanoclawRoot ?? state?.nanoclawRoot);
  const agentGroupId = state?.agentGroupId;
  const quiet = options.quiet ?? false;

  if (!agentGroupId) {
    throw new Error('No diagnostic agent registered. Run: diagnostic-agent setup --repo <path>');
  }

  const prompt = options.message ?? buildScanPrompt(options.scope, options.ci);
  const timeoutMs = options.waitTimeoutMs ?? (options.ci ? DEFAULT_CI_WAIT_MS : DEFAULT_TIMEOUT_MS);

  if (!quiet) {
    console.log(`Triggering scan on agent group ${agentGroupId}...`);
    console.log(`Prompt: ${prompt}`);
    console.log('(Container restart + cold start may take up to ~60s)');
    console.log('');
  }

  const result = spawnSync(
    'pnpm',
    ['run', 'ncl', 'groups', 'restart', '--id', agentGroupId, '--message', prompt],
    {
      cwd: nanoclawRoot,
      stdio: quiet ? 'pipe' : 'inherit',
      shell: process.platform === 'win32',
      timeout: timeoutMs,
    },
  );

  if (result.status !== 0) {
    if (!quiet) {
      console.error('');
      console.error('Scan trigger failed. Check Nanoclaw logs.');
      console.error('Findings are written to groups/diagnostic-agent/ in Nanoclaw after the agent completes.');
    }
    return result.status ?? ExitCode.ERROR;
  }

  if (options.ci && options.outputPath) {
    return resolveAgentFindings(nanoclawRoot, options.outputPath, timeoutMs, quiet);
  }

  if (!quiet) {
    console.log('');
    console.log('Scan triggered. Check agent output in Nanoclaw logs or chat.');
    console.log('Expected output: ai-usage-findings.json in the agent workspace.');
    console.log('Tip: pass --ci --output path for non-interactive wait + copy.');
  }

  return ExitCode.OK;
}
