import { ExitCode } from './lib/exit-codes.js';
import { findNanoclawRoot } from './lib/nanoclaw.js';
import {
  formatNclFailure,
  isNanoclawHostRunning,
  printScanTroubleshooting,
  runNcl,
  sendNanoclawChat,
} from './lib/nanoclaw-cli.js';
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
      : 'Scope: scan the whole mounted repo; exclude node_modules, .git, dist, and similar dirs.';

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

  if (!isNanoclawHostRunning(nanoclawRoot)) {
    console.error('Nanoclaw host is not running (missing data/ncl.sock).');
    console.error(`Start it from ${nanoclawRoot} with: pnpm run dev`);
    printScanTroubleshooting();
    return ExitCode.ERROR;
  }

  const prompt = options.message ?? buildScanPrompt(options.scope, options.ci);
  const timeoutMs = options.waitTimeoutMs ?? (options.ci ? DEFAULT_CI_WAIT_MS : DEFAULT_TIMEOUT_MS);

  if (!quiet) {
    console.log(`Triggering scan on agent group ${agentGroupId}...`);
    console.log(`Prompt: ${prompt}`);
    console.log('(Container cold start may take up to ~60s on first run)');
    console.log('');
  }

  const restart = runNcl(nanoclawRoot, [
    'groups',
    'restart',
    '--id',
    agentGroupId,
    '--message',
    prompt,
  ]);

  let useChat = false;

  if (restart.response?.ok) {
    const restarted = (restart.response.data as { restarted?: number } | undefined)?.restarted ?? 0;
    if (restarted === 0) {
      if (!quiet) {
        console.log('No running container for this group; sending prompt via CLI chat instead.');
      }
      useChat = true;
    } else if (!quiet) {
      console.log(`Restarted ${restarted} container(s) with scan prompt.`);
    }
  } else {
    if (!quiet) {
      console.error(`groups restart failed: ${formatNclFailure(restart.stdout, restart.stderr, restart.response)}`);
      console.log('Trying CLI chat instead...');
    }
    useChat = true;
  }

  if (useChat) {
    const chatStatus = sendNanoclawChat(nanoclawRoot, prompt, { quiet, timeoutMs });
    if (chatStatus !== 0) {
      if (!quiet) {
        console.error('');
        console.error('Scan trigger failed via CLI chat.');
        printScanTroubleshooting();
      }
      return chatStatus === 2 || chatStatus === 3 ? chatStatus : ExitCode.ERROR;
    }
  } else if (restart.status !== 0) {
    if (!quiet) {
      console.error('');
      console.error(`Scan trigger failed: ${formatNclFailure(restart.stdout, restart.stderr, restart.response)}`);
      printScanTroubleshooting();
    }
    return restart.status ?? ExitCode.ERROR;
  }

  if (options.ci && options.outputPath) {
    return resolveAgentFindings(nanoclawRoot, options.outputPath, timeoutMs, quiet);
  }

  if (!quiet) {
    console.log('');
    console.log('Scan complete or in progress. Check agent output in Nanoclaw logs.');
    console.log('Expected output: ai-usage-findings.json in groups/diagnostic-agent/');
    console.log('Tip: pass --ci --output path for non-interactive wait + copy.');
  }

  return ExitCode.OK;
}
