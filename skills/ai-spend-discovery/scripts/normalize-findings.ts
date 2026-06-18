#!/usr/bin/env node
/**
 * Post-process findings: dedupe call sites, reconcile summary, enrich coverage.
 *
 * Usage:
 *   pnpm run normalize-findings -- input.json --output cleaned.json
 *   pnpm run normalize-findings -- input.json   # prints to stdout
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { createValidator, formatValidationErrors } from '../../../lib/ajv.js';
import { normalizeFindings, type FindingsDocument } from '../lib/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, '..', 'schema', 'findings.schema.json');

function parseArgs(argv: string[]): { inputPath?: string; outputPath?: string } {
  let inputPath: string | undefined;
  let outputPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--output' && argv[i + 1]) {
      outputPath = argv[i + 1];
      i++;
    } else if (!arg.startsWith('-')) {
      inputPath = arg;
    }
  }

  return { inputPath, outputPath };
}

function main(): void {
  const { inputPath, outputPath } = parseArgs(process.argv.slice(2));
  const resolvedInput = inputPath ?? path.join(process.cwd(), 'ai-usage-findings.json');

  if (!fs.existsSync(resolvedInput)) {
    console.error(`File not found: ${resolvedInput}`);
    process.exit(2);
  }

  const doc = JSON.parse(fs.readFileSync(resolvedInput, 'utf-8')) as FindingsDocument;
  const normalized = normalizeFindings(doc);

  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
  const validate = createValidator(schema);
  if (!validate(normalized)) {
    console.error('Normalized output failed schema validation:');
    for (const line of formatValidationErrors(validate.errors)) {
      console.error(`  ${line}`);
    }
    process.exit(1);
  }

  const json = `${JSON.stringify(normalized, null, 2)}\n`;

  if (outputPath) {
    const out = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, json);
    console.log(
      `Wrote ${out} (${doc.findings.length} → ${normalized.findings.length} findings)`,
    );
  } else {
    process.stdout.write(json);
  }
}

main();
