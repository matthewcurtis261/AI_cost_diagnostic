#!/usr/bin/env tsx
/** Validate quality-scores.snapshot.json against schema and basic invariants. */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { createValidator } from '../../lib/ajv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCHEMA_PATH = path.join(ROOT, 'schema', 'quality-scores.schema.json');
const SNAPSHOT_PATH = path.join(ROOT, 'data', 'quality-scores.snapshot.json');

interface CliArgs {
  file: string;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const fileIdx = argv.indexOf('--file');
  return {
    file: fileIdx >= 0 && argv[fileIdx + 1] ? argv[fileIdx + 1] : SNAPSHOT_PATH,
    json: argv.includes('--json'),
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
  const snapshot = JSON.parse(fs.readFileSync(args.file, 'utf-8'));

  const validate = createValidator(schema);

  if (!validate(snapshot)) {
    console.error('Schema validation failed:');
    console.error(JSON.stringify(validate.errors, null, 2));
    process.exit(1);
  }

  const issues: string[] = [];
  const metricIds = new Set(snapshot.metrics.map((m: { id: string }) => m.id));
  const modelCount = Object.keys(snapshot.models).length;

  if (modelCount === 0) {
    issues.push('No models in snapshot');
  }

  for (const [modelId, entry] of Object.entries(snapshot.models) as [string, { scores: Record<string, number | null> }][]) {
    for (const [metricId, score] of Object.entries(entry.scores)) {
      if (!metricIds.has(metricId)) {
        issues.push(`${modelId}: unknown metric ${metricId}`);
      }
      if (score !== null && (score < 0 || score > 1)) {
        issues.push(`${modelId}.${metricId}: score ${score} out of range [0,1]`);
      }
    }
  }

  if (issues.length > 0) {
    console.error('Semantic validation failed:');
    for (const issue of issues) console.error(`  - ${issue}`);
    process.exit(1);
  }

  if (args.json) {
    console.log(
      JSON.stringify({
        ok: true,
        file: args.file,
        models: modelCount,
        metrics: snapshot.metrics.length,
        generated_at: snapshot.generated_at,
      }),
    );
    return;
  }

  console.log(`OK: ${args.file}`);
  console.log(`  models: ${modelCount}`);
  console.log(`  metrics: ${snapshot.metrics.length}`);
  console.log(`  generated_at: ${snapshot.generated_at}`);
}

main();
