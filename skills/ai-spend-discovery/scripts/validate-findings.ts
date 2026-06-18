#!/usr/bin/env node
/**
 * Validate ai-usage-findings.json against the findings schema.
 *
 * Usage:
 *   pnpm run validate-findings [path/to/ai-usage-findings.json]
 *   pnpm run validate-findings -- examples/sample-findings.json
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { createValidator, formatValidationErrors } from '../../../lib/ajv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, '..', 'schema', 'findings.schema.json');

function main(): void {
  const inputPath =
    process.argv[2] ||
    path.join(process.cwd(), 'ai-usage-findings.json');

  if (!fs.existsSync(inputPath)) {
    console.error(`File not found: ${inputPath}`);
    process.exit(2);
  }

  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
  const data = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));

  const validate = createValidator(schema);

  if (!validate(data)) {
    console.error(`Validation failed for ${inputPath}:`);
    for (const line of formatValidationErrors(validate.errors)) {
      console.error(`  ${line}`);
    }
    process.exit(1);
  }

  console.log(`OK: ${inputPath} (${data.findings?.length ?? 0} findings)`);
}

main();
