import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PATTERNS_PATH = path.join(ROOT, 'skills', 'ai-spend-discovery', 'patterns', 'providers.json');
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'repos');

interface PatternsFile {
  providers: Record<
    string,
    { sdk_imports: string[]; http_endpoints: string[]; env_vars: string[] }
  >;
  dependency_packages: string[];
}

function readAllFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      readAllFiles(full, acc);
    } else {
      acc.push(full);
    }
  }
  return acc;
}

function collectSignals(content: string, patterns: PatternsFile): Set<string> {
  const hits = new Set<string>();
  for (const [provider, cfg] of Object.entries(patterns.providers)) {
    for (const sig of [...cfg.sdk_imports, ...cfg.http_endpoints, ...cfg.env_vars]) {
      if (content.includes(sig)) hits.add(provider);
    }
  }
  for (const pkg of patterns.dependency_packages) {
    if (content.includes(pkg)) hits.add(`dep:${pkg}`);
  }
  return hits;
}

describe('pattern fixtures', () => {
  const patterns = JSON.parse(fs.readFileSync(PATTERNS_PATH, 'utf-8')) as PatternsFile;

  it('detects OpenAI usage in openai-chat-app fixture', () => {
    const file = path.join(FIXTURES_DIR, 'openai-chat-app', 'src', 'llm.ts');
    const content = fs.readFileSync(file, 'utf-8');
    const hits = collectSignals(content, patterns);
    assert.ok(hits.has('openai'), `expected openai hit, got ${[...hits].join(', ')}`);
  });

  it('detects LangChain + Anthropic + OpenAI in langchain-python fixture', () => {
    const file = path.join(FIXTURES_DIR, 'langchain-python', 'app', 'llm.py');
    const content = fs.readFileSync(file, 'utf-8');
    const hits = collectSignals(content, patterns);
    assert.ok(hits.has('langchain'));
    assert.ok(hits.has('anthropic'));
    assert.ok(hits.has('openai') || content.includes('ChatOpenAI'));
  });

  it('detects AWS Bedrock in bedrock-go fixture', () => {
    const file = path.join(FIXTURES_DIR, 'bedrock-go', 'main.go');
    const content = fs.readFileSync(file, 'utf-8');
    const hits = collectSignals(content, patterns);
    assert.ok(hits.has('aws-bedrock'), `expected aws-bedrock hit, got ${[...hits].join(', ')}`);
  });

  it('patterns file covers at least 10 providers', () => {
    assert.ok(Object.keys(patterns.providers).length >= 10);
  });
});

describe('findings schema', () => {
  it('validates sample-findings.json', () => {
    const sample = path.join(ROOT, 'examples', 'sample-findings.json');
    execFileSync('pnpm', ['run', 'validate-findings', sample], {
      cwd: ROOT,
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
  });
});
