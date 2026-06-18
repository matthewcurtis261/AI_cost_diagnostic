import { spawnSync } from 'child_process';

import { findNanoclawRoot } from './lib/nanoclaw.js';
import { readState } from './lib/state.js';

const TOTAL_TIMEOUT_MS = 600_000;

export interface ScanOptions {
  scope?: string[];
  nanoclawRoot?: string;
  message?: string;
}

function buildScanPrompt(scope?: string[]): string {
  const scopeLine =
    scope && scope.length > 0
      ? `Scope: scan only these subdirectories: ${scope.join(', ')}.`
      : 'Scope: scan the whole mounted repo (exclude node_modules, .git, dist, etc.).';

  return (
    'Run the ai-spend-discovery skill now. ' +
    scopeLine +
    ' Write findings to /workspace/agent/ai-usage-findings.json conforming to the schema, ' +
    'then send the file to me.'
  );
}

export async function runScan(options: ScanOptions): Promise<number> {
  const state = readState();
  const nanoclawRoot = findNanoclawRoot(options.nanoclawRoot ?? state?.nanoclawRoot);
  const agentGroupId = state?.agentGroupId;

  if (!agentGroupId) {
    throw new Error('No diagnostic agent registered. Run: diagnostic-agent setup --repo <path>');
  }

  const prompt = options.message ?? buildScanPrompt(options.scope);

  console.log(`Triggering scan on agent group ${agentGroupId}...`);
  console.log(`Prompt: ${prompt}`);
  console.log('(Container restart + cold start may take up to ~60s)');
  console.log('');

  const result = spawnSync(
    'pnpm',
    ['run', 'ncl', 'groups', 'restart', '--id', agentGroupId, '--message', prompt],
    {
      cwd: nanoclawRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      timeout: TOTAL_TIMEOUT_MS,
    },
  );

  if (result.status !== 0) {
    console.error('');
    console.error('Scan trigger failed. Check Nanoclaw logs.');
    console.error('Findings are written to groups/diagnostic-agent/ in Nanoclaw after the agent completes.');
  } else {
    console.log('');
    console.log('Scan triggered. Check agent output in Nanoclaw logs or chat.');
    console.log('Expected output: ai-usage-findings.json in the agent workspace.');
  }

  return result.status ?? 1;
}
