# Input-aware analysis (`analyze-inputs`)

Offline **per-request what-if** report: classify each telemetry event's input, score quality by relevant benchmark metrics, and recommend cheaper models that pass your quality gates.

This is diagnostic analysis only — no live routing.

---

## Prerequisites

1. **Telemetry JSONL** with request `input` payloads (from [Observe phase](telemetry-setup.md))
2. Python + classifier deps (for input classification subprocess)

```bash
pip install -r input-analysis/python/requirements.txt
```

---

## Quick start

```bash
pnpm run analyze-inputs -- \
  --events examples/sample-events-input-analysis.jsonl
```

Write JSON report:

```bash
pnpm run analyze-inputs -- \
  --events examples/sample-events-input-analysis.jsonl \
  --output input-analysis.json \
  --json
```

Validate output:

```bash
pnpm run validate-analyze-inputs -- input-analysis.json
```

---

## How it works

For each telemetry event:

1. **Classify** the request input → relevant quality metric families (e.g. `code_completion`, `math`)
2. **Score** current and candidate models on those metrics using the committed quality matrix
3. **Cost** the request at current vs alternative model pricing (including open/self-hosted models by default)
4. **Recommend** the best cheaper alternative that passes:
   - **Quality floor** — alternative ≥ N% of the best model on those metrics (default 90%)
   - **Sacrifice tradeoff** — quality loss ≤ sacrifice_rate × cost savings %

---

## Quality presets

| Preset | Floor | Sacrifice rate |
|---|---|---|
| `conservative` | 95% | 0.2 pts per 1% saved |
| `balanced` (default) | 90% | 0.5 |
| `aggressive` | 85% | 1.0 |

```bash
pnpm run analyze-inputs -- \
  --events ~/.diagnostic_agent/events.jsonl \
  --preset conservative
```

Override manually:

```bash
pnpm run analyze-inputs -- \
  --events events.jsonl \
  --quality-floor 0.92 \
  --quality-sacrifice 0.4
```

---

## CLI options

| Flag | Description |
|---|---|
| `--events <path>` | Telemetry JSONL (default: `~/.diagnostic_agent/events.jsonl`) |
| `--output <path>` | Write `input-analysis.json` |
| `--preset` | `conservative` \| `balanced` \| `aggressive` |
| `--quality-floor` | Override floor (0–1) |
| `--quality-sacrifice` | Override sacrifice rate |
| `--alternatives a,b,c` | Limit candidate models |
| `--since` / `--until` | Filter events by ISO timestamp |
| `--no-open-pricing` | Exclude DeepSeek/Llama/Qwen etc. |
| `--pricing` / `--open-pricing` | Override pricing tables |
| `--quality-scores` | Override quality score snapshot |
| `--json` | Print full JSON to stdout |

---

## Report shape

```json
{
  "analysis_metadata": {
    "schema_version": "0.1.0",
    "quality_preset": "balanced",
    "quality_floor_pct": 0.9,
    "quality_sacrifice_per_cost": 0.5
  },
  "items": [
    {
      "event_id": "evt_sample002",
      "model": "gpt-4o",
      "classification": {
        "metric_ids": ["code_completion"],
        "primary_metric": "code_completion"
      },
      "current_cost_usd": 0.0075,
      "recommendation": {
        "alternative_model": "deepseek-chat",
        "savings_usd": 0.0061,
        "savings_percent": 81.3,
        "passes_quality_floor": true,
        "passes_sacrifice_tradeoff": true
      }
    }
  ],
  "summary": {
    "events_analyzed": 3,
    "events_with_recommendations": 2,
    "total_potential_savings_usd": 0.012
  }
}
```

---

## Events without input payloads

Events missing `input` are listed in the report with `skipped_reason: "missing_input_payload"`. Use the [telemetry wrappers](telemetry-setup.md) to capture request payloads.

---

## Related commands

| Command | Purpose |
|---|---|
| `pnpm run estimate` | Aggregate spend by call site (findings + telemetry) |
| `pnpm run classify-inputs` | Raw classifier subprocess (stdin/stdout JSON) |
| `pnpm run train-classifier` | Fine-tune DistilBERT head for higher accuracy |

See also [input-analysis/README.md](../input-analysis/README.md).
