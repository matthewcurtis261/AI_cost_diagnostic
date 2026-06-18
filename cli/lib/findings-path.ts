import fs from 'fs';
import path from 'path';

import { ExitCode } from './exit-codes.js';
import { DIAGNOSTIC_GROUP_FOLDER } from './nanoclaw.js';
import { readState } from './state.js';

export function defaultFindingsFilename(): string {
  return 'ai-usage-findings.json';
}

/** Host path where Nanoclaw syncs agent workspace output. */
export function nanoclawFindingsPath(nanoclawRoot: string, folder?: string): string {
  const groupFolder = folder ?? readState()?.folder ?? DIAGNOSTIC_GROUP_FOLDER;
  return path.join(nanoclawRoot, 'groups', groupFolder, defaultFindingsFilename());
}

export function copyFindings(source: string, dest: string): void {
  const resolved = path.resolve(dest);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.copyFileSync(source, resolved);
}

export function waitForFile(
  filePath: string,
  timeoutMs: number,
  pollMs = 2000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve) => {
    const tick = (): void => {
      if (fs.existsSync(filePath)) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

export async function resolveAgentFindings(
  nanoclawRoot: string,
  outputPath: string,
  timeoutMs: number,
  quiet?: boolean,
): Promise<number> {
  const expected = nanoclawFindingsPath(nanoclawRoot);
  if (!quiet) {
    console.log(`Waiting for findings (timeout ${Math.round(timeoutMs / 1000)}s)...`);
    console.log(`  ${expected}`);
  }

  const found = await waitForFile(expected, timeoutMs);
  if (!found) {
    console.error(`Timed out waiting for ${expected}`);
    return ExitCode.SCAN_TIMEOUT;
  }

  copyFindings(expected, outputPath);
  if (!quiet) console.log(`Copied findings to ${outputPath}`);
  return ExitCode.OK;
}
