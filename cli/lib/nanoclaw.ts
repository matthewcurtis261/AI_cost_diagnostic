import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveProjectRoot(): string {
  const candidates = [
    path.resolve(__dirname, '..', '..', '..'),
    path.resolve(__dirname, '..', '..'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return candidate;
    }
  }
  return path.resolve(__dirname, '..', '..');
}

export const DIAGNOSTIC_AGENT_ROOT = resolveProjectRoot();
export const SKILL_NAME = 'ai-spend-discovery';
export const SKILL_SOURCE_DIR = path.join(DIAGNOSTIC_AGENT_ROOT, 'skills', SKILL_NAME);
export const DIAGNOSTIC_GROUP_FOLDER = 'diagnostic-agent';

export function findNanoclawRoot(explicit?: string): string {
  const candidates = [
    explicit,
    process.env.NANOCLAW_ROOT,
    path.resolve(DIAGNOSTIC_AGENT_ROOT, '..', 'nanoclaw-main'),
    path.resolve(DIAGNOSTIC_AGENT_ROOT, '..', 'nanoclaw'),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (
      fs.existsSync(path.join(resolved, 'package.json')) &&
      fs.existsSync(path.join(resolved, 'container', 'skills'))
    ) {
      return resolved;
    }
  }

  throw new Error(
    'Could not find Nanoclaw installation. Set NANOCLAW_ROOT or pass --nanoclaw-root.',
  );
}

export function nanoclawDataDir(nanoclawRoot: string): string {
  return path.join(nanoclawRoot, 'data');
}

export function cliSocketPath(nanoclawRoot: string): string {
  return path.join(nanoclawDataDir(nanoclawRoot), 'cli.sock');
}

export function mountAllowlistPath(): string {
  return path.join(os.homedir(), '.config', 'nanoclaw', 'mount-allowlist.json');
}

export interface MountAllowlist {
  allowedRoots: Array<{
    path: string;
    allowReadWrite?: boolean;
    description?: string;
  }>;
  blockedPatterns: string[];
  nonMainReadOnly?: boolean;
}

export function readMountAllowlist(): MountAllowlist | null {
  const file = mountAllowlistPath();
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as MountAllowlist;
}

export function mergeMountAllowlist(repoPath: string, readOnly = true): MountAllowlist {
  const resolvedRepo = path.resolve(repoPath);
  const parentRoot = path.dirname(resolvedRepo);

  const existing = readMountAllowlist() ?? {
    allowedRoots: [],
    blockedPatterns: [],
    nonMainReadOnly: true,
  };

  const roots = existing.allowedRoots ?? [];
  const alreadyAllowed = roots.some(
    (r) => resolvedRepo.startsWith(path.resolve(r.path)) || path.resolve(r.path) === parentRoot,
  );

  if (!alreadyAllowed) {
    roots.push({
      path: parentRoot,
      allowReadWrite: !readOnly,
      description: 'diagnostic_agent setup',
    });
  }

  return {
    ...existing,
    allowedRoots: roots,
    nonMainReadOnly: existing.nonMainReadOnly ?? true,
  };
}

export function writeMountAllowlist(config: MountAllowlist): void {
  const file = mountAllowlistPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
}

export function repoMountName(repoPath: string): string {
  return path.basename(path.resolve(repoPath)).replace(/[^a-zA-Z0-9._-]/g, '-');
}

export function installSkill(nanoclawRoot: string): string {
  const dest = path.join(nanoclawRoot, 'container', 'skills', SKILL_NAME);
  fs.cpSync(SKILL_SOURCE_DIR, dest, { recursive: true, force: true });
  return dest;
}
