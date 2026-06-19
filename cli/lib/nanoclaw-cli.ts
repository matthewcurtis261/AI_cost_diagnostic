import fs from 'fs';
import path from 'path';

import { spawnPnpm } from './spawn-pnpm.js';

export interface NclResponse {
  id?: string;
  ok: boolean;
  error?: { code: string; message: string };
  data?: unknown;
}

export function nanoclawDataDir(nanoclawRoot: string): string {
  return path.join(nanoclawRoot, 'data');
}

export function isNanoclawHostRunning(nanoclawRoot: string): boolean {
  return fs.existsSync(path.join(nanoclawDataDir(nanoclawRoot), 'ncl.sock'));
}

export function runNcl(
  nanoclawRoot: string,
  args: string[],
): { status: number | null; response?: NclResponse; stdout: string; stderr: string } {
  const result = spawnPnpm(['run', 'ncl', ...args, '--json'], {
    cwd: nanoclawRoot,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  let response: NclResponse | undefined;
  try {
    response = JSON.parse(stdout.trim()) as NclResponse;
  } catch {
    // Non-JSON output (transport errors may land on stderr).
  }

  return { status: result.status, response, stdout, stderr };
}

export function sendNanoclawChat(
  nanoclawRoot: string,
  message: string,
  options: { quiet?: boolean; timeoutMs?: number } = {},
): number {
  const result = spawnPnpm(['run', 'chat', '--', message], {
    cwd: nanoclawRoot,
    stdio: options.quiet ? 'pipe' : 'inherit',
    timeout: options.timeoutMs,
  });
  return result.status ?? 1;
}

export function formatNclFailure(stdout: string, stderr: string, response?: NclResponse): string {
  if (response && !response.ok && response.error) {
    return `error (${response.error.code}): ${response.error.message}`;
  }
  const combined = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n');
  return combined || 'unknown ncl error';
}

export function printScanTroubleshooting(): void {
  console.error('');
  console.error('Troubleshooting:');
  console.error('  1. Start Nanoclaw:  cd nanoclaw-main && pnpm run dev');
  console.error('  2. Docker Desktop must be running (agent containers)');
  console.error('  3. Re-register if needed:  pnpm run setup -- --repo <path>');
  console.error('  4. Check logs:  nanoclaw-main/logs/');
}
