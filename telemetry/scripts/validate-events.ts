#!/usr/bin/env node
/**
 * Validate telemetry events JSONL against event.schema.json.
 *
 * Usage:
 *   pnpm run validate-events [path/to/events.jsonl]
 *   pnpm run validate-events -- examples/sample-events.jsonl
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { createValidator, formatValidationErrors } from '../../lib/ajv.js';

import { assertNoOutputFields } from '../../telemetry/lib/sanitize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, '..', 'schema', 'event.schema.json');

function main(): void {
  const inputPath =
    process.argv[2] ||
    path.join(os.homedir(), '.diagnostic_agent', 'events.jsonl');

  if (!fs.existsSync(inputPath)) {
    console.error(`File not found: ${inputPath}`);
    process.exit(2);
  }

  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
  const validate = createValidator(schema);

  const lines = fs
    .readFileSync(inputPath, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  let ok = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    let event: unknown;
    try {
      event = JSON.parse(lines[i]!);
    } catch {
      console.error(`Line ${lineNo}: invalid JSON`);
      process.exit(1);
    }

    try {
      assertNoOutputFields(event);
    } catch (err) {
      console.error(`Line ${lineNo}: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }

    if (!validate(event)) {
      console.error(`Line ${lineNo}: schema validation failed`);
      for (const line of formatValidationErrors(validate.errors)) {
        console.error(`  ${line}`);
      }
      process.exit(1);
    }
    ok += 1;
  }

  console.log(`OK: ${inputPath} (${ok} event(s))`);
}

main();
