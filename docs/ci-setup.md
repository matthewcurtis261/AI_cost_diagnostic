# CI setup

Run AI usage discovery in CI without billing access or (optionally) without Nanoclaw.

## Recommended: static scan (no Docker)

Deterministic **Pass A** pattern scan — fast, no LLM agent, no Nanoclaw:

```bash
pnpm install
pnpm run discover -- --repo . --static --ci --output ai-usage-findings.json
pnpm run check -- --findings ai-usage-findings.json --min-confidence medium
```

Or as a one-liner with policy gate:

```bash
pnpm run discover -- --repo . --static --ci --output ai-usage-findings.json --check --max-billable 0
```

`--max-billable 0` fails (exit **3**) if any billable call site is found — useful for **“no unapproved LLM usage”** policies.

## Full agent scan (Nanoclaw required)

For higher-confidence Pass B–E results in CI:

1. Install Nanoclaw + Docker on the runner (or use a self-hosted runner with Nanoclaw already running).
2. One-time setup (or cache `~/.config/diagnostic_agent/state.json`):

```bash
pnpm run discover -- --repo . --skip-setup   # if already set up
pnpm run setup -- --repo .
```

3. CI scan with wait + output:

```bash
pnpm run scan -- --ci --output ai-usage-findings.json
pnpm run check -- --findings ai-usage-findings.json --strict
```

Or combined:

```bash
pnpm run discover -- --repo . --ci --output ai-usage-findings.json --normalize --check --strict
```

## Exit codes

| Code | Meaning |
|---|---|
| **0** | Success; policy checks passed |
| **1** | Error (I/O, schema validation, scan trigger failure) |
| **2** | CLI usage error (missing required args) |
| **3** | Policy check failed (`--fail-on-findings`, `--max-billable`, etc.) |
| **4** | Scan timeout waiting for agent output |

## Check command reference

```bash
diagnostic-agent check --findings ai-usage-findings.json [options]
```

| Flag | Effect |
|---|---|
| `--strict` | Semantic warnings (duplicates, summary drift) → error |
| `--fail-on-findings` | Exit 3 if any **billable** call site exists |
| `--min-confidence high` | Fail if billable findings below threshold |
| `--max-billable N` | Fail if more than N billable call sites |
| `--min-billable N` | Fail if fewer than N (sanity check for expected usage) |
| `--json` | Machine-readable result on stdout |

Billable call sites exclude dependency-only `agent_framework` rows and low-confidence chat hits.

## GitHub Actions example (static)

```yaml
name: ai-usage-discovery
on: [pull_request]

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install
        working-directory: path/to/diagnostic_agent

      - name: Static AI usage scan
        working-directory: path/to/diagnostic_agent
        run: |
          pnpm run discover -- \
            --repo ${{ github.workspace }} \
            --static --ci \
            --output "$RUNNER_TEMP/ai-usage-findings.json"

      - name: Validate findings
        working-directory: path/to/diagnostic_agent
        run: |
          pnpm run check -- \
            --findings "$RUNNER_TEMP/ai-usage-findings.json" \
            --json

      - name: Upload report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: ai-usage-findings
          path: ${{ runner.temp }}/ai-usage-findings.json
```

## Policy examples

**Inventory only (always pass):**

```bash
pnpm run discover -- --repo . --static --ci --output findings.json
pnpm run check -- --findings findings.json
```

**Block new LLM call sites on PR:**

```bash
pnpm run check -- --findings findings.json --fail-on-findings
# exit 3 → fail the job
```

**Require high-confidence hits only:**

```bash
pnpm run check -- --findings findings.json --min-confidence high --strict
```

## Post-scan cleanup

```bash
pnpm run normalize-findings -- findings.json --output findings.cleaned.json
pnpm run validate-findings -- --strict findings.cleaned.json
```

See [false-positives.md](false-positives.md) for interpreting static scan noise.
