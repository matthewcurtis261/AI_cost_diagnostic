import fs from 'fs';
import path from 'path';

import {
  normalizeFindings,
  runStaticScan,
  writeFindingsDocument,
} from '../skills/ai-spend-discovery/lib/index.js';
import { runCheck, type CheckOptions } from './check.js';
import { ExitCode } from './lib/exit-codes.js';
import { repoMountName } from './lib/nanoclaw.js';
import { readState } from './lib/state.js';
import { runScan } from './scan.js';
import { runSetup } from './setup.js';

export interface DiscoverOptions {
  repo: string;
  nanoclawRoot?: string;
  mountName?: string;
  scope?: string[];
  output?: string;
  static?: boolean;
  ci?: boolean;
  skipSetup?: boolean;
  normalize?: boolean;
  waitTimeoutMs?: number;
  check?: CheckOptions;
  quiet?: boolean;
}

function log(msg: string, quiet?: boolean): void {
  if (!quiet) console.log(msg);
}

export async function runDiscover(options: DiscoverOptions): Promise<number> {
  const repoPath = path.resolve(options.repo);
  const outputPath =
    options.output ?? path.join(process.cwd(), 'ai-usage-findings.json');
  const mountName = options.mountName ?? repoMountName(repoPath);
  const ci = options.ci ?? false;
  const quiet = options.quiet ?? ci;

  if (!fs.existsSync(repoPath)) {
    throw new Error(`Repo path does not exist: ${repoPath}`);
  }

  const state = readState();
  const needsSetup =
    !options.skipSetup &&
    (!state || path.resolve(state.repoPath) !== repoPath);

  if (needsSetup && !options.static) {
    log('Running setup...', quiet);
    runSetup({
      repo: repoPath,
      nanoclawRoot: options.nanoclawRoot,
      mountName,
    });
  } else if (options.static) {
    log('Static mode — skipping Nanoclaw setup', quiet);
  }

  let findingsWritten = outputPath;

  if (options.static) {
    log(`Static Pass A scan: ${repoPath}`, quiet);
    const doc = runStaticScan({
      repoPath,
      scope: options.scope,
      mountName,
    });
    writeFindingsDocument(doc, outputPath);
    log(`Wrote ${outputPath} (${doc.findings.length} findings)`, quiet);
  } else {
    const scanCode = await runScan({
      scope: options.scope,
      nanoclawRoot: options.nanoclawRoot,
      ci,
      quiet,
      waitTimeoutMs: options.waitTimeoutMs,
      outputPath: ci ? outputPath : undefined,
    });

    if (scanCode !== ExitCode.OK) {
      return scanCode;
    }

    if (ci) {
      findingsWritten = outputPath;
    } else if (!ci) {
      log('', quiet);
      log('Discover triggered agent scan. For CI, pass --ci to wait for output.', quiet);
      log(`Expected findings: ${outputPath} (with --ci) or Nanoclaw groups folder`, quiet);
      return ExitCode.OK;
    }
  }

  if (options.normalize) {
    const raw = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    const normalized = normalizeFindings(raw);
    fs.writeFileSync(outputPath, `${JSON.stringify(normalized, null, 2)}\n`);
    findingsWritten = outputPath;
    log(`Normalized ${outputPath}`, quiet);
  }

  if (options.check) {
    const checkResult = runCheck({
      ...options.check,
      findingsPath: findingsWritten,
      quiet,
    });
    return checkResult.exitCode;
  }

  return ExitCode.OK;
}

export function parseDiscoverArgs(
  argv: string[],
): Partial<DiscoverOptions> & { checkArgs: string[] } {
  const parsed: Partial<DiscoverOptions> = {};
  const checkArgs: string[] = [];
  let inCheck = false;

  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];

    if (key === '--check') {
      inCheck = true;
      continue;
    }

    if (inCheck) {
      checkArgs.push(key);
      if (
        val &&
        (key === '--min-confidence' ||
          key === '--max-billable' ||
          key === '--min-billable')
      ) {
        checkArgs.push(val);
        i++;
      }
      continue;
    }
    if (key === '--repo' && val) {
      parsed.repo = val;
      i++;
    } else if (key === '--nanoclaw-root' && val) {
      parsed.nanoclawRoot = val;
      i++;
    } else if (key === '--mount-name' && val) {
      parsed.mountName = val;
      i++;
    } else if (key === '--scope' && val) {
      parsed.scope = val.split(',').map((s) => s.trim()).filter(Boolean);
      i++;
    } else if (key === '--output' && val) {
      parsed.output = val;
      i++;
    } else if (key === '--wait-timeout' && val) {
      parsed.waitTimeoutMs = Number(val);
      i++;
    } else if (key === '--static') {
      parsed.static = true;
    } else if (key === '--ci') {
      parsed.ci = true;
    } else if (key === '--skip-setup') {
      parsed.skipSetup = true;
    } else if (key === '--normalize') {
      parsed.normalize = true;
    } else if (key === '--quiet') {
      parsed.quiet = true;
    } else if (!key.startsWith('-') && !parsed.repo) {
      parsed.repo = key;
    }
  }

  return { ...parsed, checkArgs };
}
