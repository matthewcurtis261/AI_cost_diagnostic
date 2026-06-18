#!/usr/bin/env node
/**
 * Validate ai-usage-findings.json against schema + semantic rules.
 *
 * Usage:
 *   pnpm run validate-findings -- [path/to/ai-usage-findings.json]
 *   pnpm run validate-findings -- --strict examples/sample-findings.json
 *   pnpm run validate-findings -- --json test-runs/rival-search/ai-usage-findings.json
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { createValidator, formatValidationErrors } from '../../../lib/ajv.js';
import {
  formatIssues,
  hasErrors,
  validateSemantics,
  type FindingsDocument,
} from '../lib/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, '..', 'schema', 'findings.schema.json');

interface CliOptions {
  inputPath: string;
  strict: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const flags = new Set(['--strict', '--json']);
  const positional: string[] = [];

  for (const arg of argv) {
    if (flags.has(arg)) continue;
    if (arg.startsWith('-')) continue;
    positional.push(arg);
  }

  return {
    inputPath: positional[0] ?? path.join(process.cwd(), 'ai-usage-findings.json'),
    strict: argv.includes('--strict'),
    json: argv.includes('--json'),
  };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(options.inputPath)) {
    console.error(`File not found: ${options.inputPath}`);
    process.exit(2);
  }

  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
  const data = JSON.parse(fs.readFileSync(options.inputPath, 'utf-8')) as FindingsDocument;

  const validate = createValidator(schema);

  if (!validate(data)) {
    console.error(`Schema validation failed for ${options.inputPath}:`);
    for (const line of formatValidationErrors(validate.errors)) {
      console.error(`  ${line}`);
    }
    process.exit(1);
  }

  const issues = validateSemantics(data, { strict: options.strict });

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ok: !hasErrors(issues),
          path: options.inputPath,
          findings: data.findings.length,
          issues,
        },
        null,
        2,
      ),
    );
    process.exit(hasErrors(issues) ? 1 : 0);
  }

  if (issues.length > 0) {
    console.log(`Schema OK: ${options.inputPath} (${data.findings.length} findings)`);
    console.log('');
    console.log('Semantic checks:');
    for (const line of formatIssues(issues)) {
      console.log(`  ${line}`);
    }
    console.log('');
    if (hasErrors(issues)) {
      console.error('Validation failed (use --strict to treat warnings as errors).');
      process.exit(1);
    }
    console.log('Completed with warnings.');
    process.exit(0);
  }

  console.log(`OK: ${options.inputPath} (${data.findings.length} findings)`);
}

main();
