#!/usr/bin/env node
/**
 * Validate input-analysis report against analyze-inputs.schema.json.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { createValidator, formatValidationErrors } from '../../lib/ajv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, '..', 'schema', 'analyze-inputs.schema.json');

function main(): void {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: validate-analyze-inputs <path/to/input-analysis.json>');
    process.exit(2);
  }

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

  console.log(
    `OK: ${inputPath} (${data.summary?.events_analyzed ?? 0} analyzed, $${data.summary?.total_potential_savings_usd ?? 0} potential savings)`,
  );
}

main();
