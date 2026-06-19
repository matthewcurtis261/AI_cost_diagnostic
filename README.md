# diagnostic_agent

Open-source tooling to help teams understand their AI spend by analyzing the code they already have — no cloud billing access required.

## Goal

1. **Discover** — Find every place a codebase calls an AI/LLM API (models, providers, call sites).
2. **Observe** *(optional)* — Capture real request inputs and token counts via an opt-in telemetry layer.
3. **Estimate** — Predict potential savings from switching to alternative models.

Milestones 1–5 are implemented (discovery, reliability, telemetry, estimation). Milestone 3 adds one-command `discover`, CI `check`, and static scanning. See [docs/setup.md](docs/setup.md), [docs/ci-setup.md](docs/ci-setup.md), [docs/reliability.md](docs/reliability.md), [docs/false-positives.md](docs/false-positives.md), [docs/telemetry-setup.md](docs/telemetry-setup.md), and [docs/estimate-setup.md](docs/estimate-setup.md).

## Quick start

**Requires Node 22.x** (see `.nvmrc`; matches Nanoclaw).

**One command (Nanoclaw agent scan):**

```bash
pnpm install
pnpm run discover -- --repo /path/to/your/codebase
pnpm run estimate -- --findings ai-usage-findings.json
pnpm run analyze-inputs -- --events examples/sample-events-input-analysis.jsonl
```

**CI / no Docker (static Pass A scan):**

```bash
pnpm install
pnpm run discover -- --repo /path/to/your/codebase --static --ci --output ai-usage-findings.json
pnpm run check -- --findings ai-usage-findings.json
```

Full agent scans require a running [Nanoclaw](https://github.com/nanocoai/nanoclaw) install (`NANOCLAW_ROOT` or sibling `../nanoclaw-main`). Static mode does not.

## What's included

| Path | Purpose |
|---|---|
| `skills/ai-spend-discovery/` | Nanoclaw skill — multi-pass discovery protocol |
| `skills/ai-spend-discovery/patterns/providers.json` | Curated provider grep patterns (17 providers) |
| `skills/ai-spend-discovery/schema/findings.schema.json` | Structured scan output (v0.1.0) |
| `skills/ai-spend-discovery/lib/` | Dedup, confidence rubric, coverage, semantic validation |
| `skills/ai-spend-discovery/rules/` | Machine-readable confidence + dedup rules |
| `cli/` | Thin CLI: `discover`, `setup`, `scan`, `check`, `estimate` |
| `telemetry/` | Opt-in SDK wrappers + JSONL writer (Observe phase) |
| `estimate/` | Pricing tables + cost engine (Estimate phase) |
| `input-analysis/` | Quality score matrix, classifier, open-model pricing (Milestone 6) |
| `examples/sample-findings.json` | Reference scan output |
| `examples/sample-events.jsonl` | Reference telemetry event |
| `examples/assumptions.json` | Reference volume assumptions |
| `tests/fixtures/repos/` | Golden fixtures for pattern coverage |

## Approach

We assume:

- No access to AWS Cost Explorer, OpenAI usage dashboards, or other third-party billing data.
- We do not know upfront which models or providers the user employs.
- We **do** have access to the user's source code.
- Discovery runs through a **Nanoclaw-style agent** — a sandboxed container agent that reads and searches the mounted codebase on our behalf.
- **Optional telemetry** — users who opt in can record actual LLM *inputs* and token counts (input + output); output *content* is not stored.

Nanoclaw lives alongside this project (see `../nanoclaw-main`). This repo ships the diagnostic skill, scan orchestration, and structured output schema — not a fork of Nanoclaw itself.

## Status

| Milestone | Status |
|---|---|
| 1 — Discovery PoC | **Done** (skill, schema, CLI, fixtures) |
| 2 — Reliability | **Done** (dedup, confidence, validate, coverage, monorepo strategy) |
| 3 — Productization | **Done** (`discover`, static CI scan, `check` exit codes, docs) |
| 4 — Telemetry | **Done** (wrappers, writer, schema, docs) |
| 5 — Cost estimation | **Done** (pricing, code-only + telemetry modes, savings) |
| 6 — Input-aware analysis | **Done** (quality matrix, classifier, `analyze-inputs` CLI) |

## Docs

- [Setup guide](docs/setup.md) — install skill, configure mounts, run scans
- [CI setup](docs/ci-setup.md) — static scan, exit codes, GitHub Actions
- [False positives](docs/false-positives.md) — interpreting noisy findings
- [Reliability](docs/reliability.md) — dedup, confidence rubric, validate/normalize findings
- [Telemetry setup](docs/telemetry-setup.md) — opt-in SDK wrappers, event schema, privacy
- [Cost estimation](docs/estimate-setup.md) — pricing, assumptions, savings comparison
- [Input-aware analysis](docs/analyze-inputs-setup.md) — per-request what-if savings CLI
- [Discovery plan](docs/PLAN.md) — architecture and roadmap

## Development

Requires **Node 22.x** and **pnpm 10+** (see `.nvmrc` and `packageManager` in `package.json`).

```bash
node --version   # v22.x
pnpm install
pnpm test
pnpm run validate-findings -- examples/sample-findings.json
pnpm run normalize-findings -- examples/sample-findings.json
pnpm run validate-events -- examples/sample-events.jsonl
pnpm run validate-estimate -- examples/sample-estimate.json
pnpm run validate-quality-scores
pnpm run analyze-inputs -- --events examples/sample-events-input-analysis.jsonl --json
pnpm run validate-analyze-inputs -- input-analysis.json
pnpm run bootstrap-classifier   # rebuild bootstrap classifier weights
pnpm run train-classifier       # fine-tune DistilBERT head (optional, higher accuracy)
pnpm run build
```

## License

MIT
