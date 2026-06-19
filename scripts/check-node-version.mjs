#!/usr/bin/env node
/**
 * Enforce Node 22 (matches Nanoclaw .nvmrc and better-sqlite3 prebuilds).
 */
const MIN_MAJOR = 22;
const MAX_MAJOR = 22;

const raw = process.version;
const match = /^v(\d+)\./.exec(raw);
const major = match ? Number(match[1]) : NaN;

if (!Number.isFinite(major) || major < MIN_MAJOR || major > MAX_MAJOR) {
  console.error(
    `diagnostic_agent requires Node ${MIN_MAJOR}.x (same as Nanoclaw). Current: ${raw}`,
  );
  console.error('');
  console.error('Fix:');
  console.error('  nvm install 22 && nvm use 22     # nvm / nvm-windows');
  console.error('  fnm use 22                       # fnm');
  console.error('  See https://nodejs.org/ for Node 22 LTS');
  process.exit(1);
}
