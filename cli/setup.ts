import fs from 'fs';
import path from 'path';

import {
  DIAGNOSTIC_AGENT_ROOT,
  DIAGNOSTIC_GROUP_FOLDER,
  findNanoclawRoot,
  installSkill,
  mergeMountAllowlist,
  repoMountName,
  writeMountAllowlist,
} from './lib/nanoclaw.js';
import { spawnPnpm } from './lib/spawn-pnpm.js';
import { writeState } from './lib/state.js';

export interface SetupOptions {
  repo: string;
  nanoclawRoot?: string;
  mountName?: string;
  skipAllowlist?: boolean;
}

export function runSetup(options: SetupOptions): void {
  const repoPath = path.resolve(options.repo);
  if (!fs.existsSync(repoPath)) {
    throw new Error(`Repo path does not exist: ${repoPath}`);
  }
  if (!fs.statSync(repoPath).isDirectory()) {
    throw new Error(`Repo path is not a directory: ${repoPath}`);
  }

  const nanoclawRoot = findNanoclawRoot(options.nanoclawRoot);
  const mountName = options.mountName ?? repoMountName(repoPath);

  console.log(`Nanoclaw root: ${nanoclawRoot}`);
  console.log(`Target repo:   ${repoPath}`);
  console.log(`Mount name:    ${mountName}`);

  if (!options.skipAllowlist) {
    const allowlist = mergeMountAllowlist(repoPath, true);
    writeMountAllowlist(allowlist);
    console.log(`Updated mount allowlist: ${allowlist.allowedRoots.length} root(s)`);
  }

  const skillDest = installSkill(nanoclawRoot);
  console.log(`Installed skill: ${skillDest}`);

  const registerScript = path.join(DIAGNOSTIC_AGENT_ROOT, 'scripts', 'register-diagnostic-agent.ts');
  const args = [
    'exec',
    'tsx',
    registerScript,
    '--repo',
    repoPath,
    '--mount-name',
    mountName,
    '--json',
  ];

  const result = spawnPnpm(args, {
    cwd: nanoclawRoot,
    stdio: ['inherit', 'pipe', 'pipe'],
    encoding: 'utf-8',
    env: { ...process.env, NANOCLAW_ROOT: nanoclawRoot },
  });

  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    const hint =
      detail.includes('better_sqlite3') || detail.includes('better-sqlite3')
        ? '\n\nHint: Nanoclaw needs a working better-sqlite3 native binding for Node 22 on Windows.\n' +
          '  cd nanoclaw-main\n' +
          '  node --version   # must be v22.x\n' +
          '  pnpm rebuild better-sqlite3\n' +
          'If rebuild fails, install Visual Studio Build Tools (Desktop development with C++) and retry.'
        : '';
    throw new Error(
      `Failed to register diagnostic agent group in Nanoclaw${detail ? `:\n${detail}` : ''}${hint}`,
    );
  }

  const stdout = String(result.stdout ?? '');
  const jsonLine = stdout
    .split('\n')
    .map((l: string) => l.trim())
    .filter((l: string) => l.startsWith('{'))
    .pop();
  if (!jsonLine) {
    throw new Error('Register script did not return JSON state (--json)');
  }
  const registered = JSON.parse(jsonLine) as {
    agentGroupId: string;
    folder: string;
    mountName: string;
    repoPath: string;
  };

  writeState({
    nanoclawRoot,
    agentGroupId: registered.agentGroupId,
    folder: registered.folder ?? DIAGNOSTIC_GROUP_FOLDER,
    repoPath: registered.repoPath,
    mountName: registered.mountName,
    updatedAt: new Date().toISOString(),
  });

  console.log('');
  console.log('Setup complete.');
  console.log('');
  console.log('Next steps:');
  console.log('  1. Ensure Nanoclaw service is running');
  console.log('  2. Run: pnpm run scan');
  console.log(`     (targets agent ${registered.agentGroupId})`);
}
