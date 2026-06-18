# Reliability (Milestone 2)

Discovery output is only useful if it is **consistent, deduplicated, and honest about blind spots**. Milestone 2 adds deterministic post-processing rules, semantic validation, and structured coverage reporting.

## Confidence scoring

Every finding must set `confidence` using the rubric in `skills/ai-spend-discovery/rules/confidence-rubric.json`:

| Level | Typical signal |
|---|---|
| **high** | Direct SDK/HTTP call in evidence |
| **medium** | Wrapper, import-only, or runtime model |
| **low** | Weak pattern match, no API method |

The validator warns when assigned confidence is more than one tier away from the automated rubric score.

## Dedup

Duplicate call sites are merged by `{file}::{call_type}`, keeping the finding with the highest score (direct `.create(` beats import-only). Dependency declarations stay separate from billable call sites.

Rules: `skills/ai-spend-discovery/rules/dedup-rules.json`

## Validate findings

Schema + semantic checks:

```bash
pnpm run validate-findings -- examples/sample-findings.json
pnpm run validate-findings -- --strict test-runs/rival-search/ai-usage-findings.json
pnpm run validate-findings -- --json ai-usage-findings.json
```

`--strict` treats warnings (duplicate call sites, summary mismatch, missing coverage) as errors.

## Normalize (post-scan cleanup)

After a Nanoclaw scan, normalize dedupes findings, reconciles summary, and fills `summary.coverage`:

```bash
pnpm run normalize-findings -- ai-usage-findings.json --output ai-usage-findings.cleaned.json
pnpm run validate-findings -- --strict ai-usage-findings.cleaned.json
```

## Coverage self-report

Structured coverage lives in `summary.coverage`:

```json
"coverage": {
  "scan_mode": "full",
  "excluded": [
    {
      "path": "node_modules",
      "reason": "Third-party dependencies; not application source",
      "category": "standard_exclude"
    }
  ],
  "blind_spots": [
    "Runtime-only model selection (DB or feature flags)"
  ],
  "files_scanned": 842,
  "passes_completed": ["A", "B", "E"]
}
```

Human-readable notes remain in `summary.coverage_notes`.

## Monorepos

For repos with multiple packages, use subagent fan-out. See [monorepo strategy](../skills/ai-spend-discovery/docs/monorepo-strategy.md).

## Library API

Post-processing logic is exported from `skills/ai-spend-discovery/lib/` and reused by the estimate engine for billable dedup:

```typescript
import { dedupeFindings, selectBillableFindings, normalizeFindings } from './skills/ai-spend-discovery/lib/index.js';
```
