# diagnostic_agent

Open-source tooling to help teams understand their AI spend by analyzing the code they already have — no cloud billing access required.

## Goal

1. **Discover** — Find every place a codebase calls an AI/LLM API (models, providers, call sites).
2. **Observe** *(optional)* — Capture real request inputs and token counts via an opt-in telemetry layer.
3. **Estimate** — Predict potential savings from switching to alternative models.

Milestone 1 (discovery) and Milestone 4 (telemetry) are implemented. Milestone 5 (cost estimation) adds the `estimate` command. See [docs/setup.md](docs/setup.md), [docs/telemetry-setup.md](docs/telemetry-setup.md), and [docs/estimate-setup.md](docs/estimate-setup.md).

## Quick start

```bash
pnpm install
pnpm run setup -- --repo /path/to/your/codebase
pnpm run scan
pnpm run estimate -- --findings ai-usage-findings.json
```

Requires a running [Nanoclaw](https://github.com/nanocoai/nanoclaw) install (`NANOCLAW_ROOT` or sibling `../nanoclaw-main`).

## What's included

| Path | Purpose |
|---|---|
| `skills/ai-spend-discovery/` | Nanoclaw skill — multi-pass discovery protocol |
| `skills/ai-spend-discovery/patterns/providers.json` | Curated provider grep patterns (17 providers) |
| `skills/ai-spend-discovery/schema/findings.schema.json` | Structured scan output (v0.1.0) |
| `cli/` | Thin CLI: `setup`, `scan` |
| `telemetry/` | Opt-in SDK wrappers + JSONL writer (Observe phase) |
| `estimate/` | Pricing tables + cost engine (Estimate phase) |
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
| 2 — Reliability | Planned |
| 3 — Productization | Partial (setup CLI done) |
| 4 — Telemetry | **Done** (wrappers, writer, schema, docs) |
| 5 — Cost estimation | **Done** (pricing, code-only + telemetry modes, savings) |
| 6 — Input-aware analysis | Planned |

## Docs

- [Setup guide](docs/setup.md) — install skill, configure mounts, run scans
- [Telemetry setup](docs/telemetry-setup.md) — opt-in SDK wrappers, event schema, privacy
- [Cost estimation](docs/estimate-setup.md) — pricing, assumptions, savings comparison
- [Discovery plan](docs/PLAN.md) — architecture and roadmap

## Development

```bash
pnpm test
pnpm run validate-findings -- examples/sample-findings.json
pnpm run validate-events -- examples/sample-events.jsonl
pnpm run validate-estimate -- examples/sample-estimate.json
pnpm run build
```

## License

MIT
