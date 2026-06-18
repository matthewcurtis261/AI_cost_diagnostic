# Input-aware analysis (Milestone 6)

Offline diagnostic tooling to estimate **what-if savings** from routing requests to smaller/open models (DeepSeek, Llama, Qwen, etc.) using public benchmark quality scores.

This is **not** production routing. No models are called at analysis time.

## Milestone 6a — Quality score matrix

### Files

| Path | Purpose |
|---|---|
| `metrics.json` | 20 granular quality metric families + OLL column mapping |
| `data/quality-scores.snapshot.json` | Committed normalized score matrix (0–1 per metric) |
| `data/quality-scores.seed.json` | Offline fallback seed for fetch script |
| `pricing/models-open.json` | API list prices + `$0.20/Mtok` self-hosted compute baseline |
| `pricing/model-aliases.json` | Map telemetry model ids → leaderboard keys |
| `python/fetch_quality_scores.py` | Refresh snapshot from HuggingFace Open LLM Leaderboard |
| `scripts/validate-quality-scores.ts` | Schema + range validation |

### Refresh scores from live leaderboard

```bash
pip install -r input-analysis/python/requirements.txt
pnpm run fetch-quality-scores
pnpm run validate-quality-scores
```

If HuggingFace is unreachable, `fetch-quality-scores` falls back to `data/quality-scores.seed.json`.

Rebuild snapshot from seed only:

```bash
python input-analysis/python/build_snapshot_from_seed.py
```

## Milestone 6b — Open pricing in estimate engine

Open/self-hosted model pricing is merged into `estimate` by default. Use `--no-open-pricing` to disable.

## Milestone 6c — DistilBERT input classifier

Multi-label classifier that maps LLM request text → relevant quality metric families (20 labels from `metrics.json`).

### Files

| Path | Purpose |
|---|---|
| `classifier/label_map.json` | Label order + DistilBERT config |
| `classifier/weights/` | Committed bootstrap weights (`classifier-head.json`) |
| `classifier/schema/classifier-output.schema.json` | Inference output schema |
| `data/training-samples.seed.jsonl` | Offline training seed (66 examples, all 20 metrics) |
| `python/build_training_data.py` | Build training JSONL from seed + HuggingFace benchmarks |
| `python/train_classifier.py` | Fine-tune DistilBERT head; writes `classifier-head.pt` |
| `python/classify.py` | Stdin/stdout JSON inference subprocess |
| `lib/classifier.ts` | TypeScript wrapper (`classifyTexts`, `classifyTelemetryInputs`) |

### Committed weights

The repo ships **bootstrap weights** (`classifier/weights/classifier-head.json`, `keyword_lexicon` format) so classification works offline without downloading DistilBERT. For higher accuracy, fine-tune:

```bash
pip install -r input-analysis/python/requirements.txt
pnpm run build-classifier-data          # seed + HF benchmarks
pnpm run train-classifier               # writes classifier-head.pt (takes precedence)
```

Rebuild bootstrap weights only:

```bash
pnpm run bootstrap-classifier
```

### Classify a prompt (CLI)

```bash
echo '{"texts":["Complete this Python function:\\ndef merge(intervals):"]}' | pnpm run classify-inputs
```

### Classify from TypeScript

```ts
import { classifyTexts } from './input-analysis/lib/classifier.js';

const result = classifyTexts(['Solve for x: 3x + 7 = 22']);
console.log(result.predictions[0].metric_ids); // e.g. ['math']
```

### Quality presets (for 6d analyze-inputs)

| Preset | Quality floor | Sacrifice rate |
|---|---|---|
| `conservative` | 95% of top model | 0.2 pts per 1% cost saved |
| `balanced` (default) | 90% | 0.5 |
| `aggressive` | 85% | 1.0 |

### Pricing assumptions

- **API models:** list prices in `pricing/models-open.json` (DeepSeek API, Together, Mistral, etc.)
- **Self-hosted:** `$0.20` per million input tokens and `$0.20` per million output tokens (`self_hosted_compute` in `models-open.json`)

### Next phases

- Prompt size breakdown (system vs. user vs. tool context)
- Identify high-cost input patterns (long RAG chunks, redundant system prompts)

## Milestone 6d — `analyze-inputs` CLI

Standalone offline command for per-request what-if savings.

```bash
pnpm run analyze-inputs -- --events examples/sample-events-input-analysis.jsonl
```

See [docs/analyze-inputs-setup.md](../docs/analyze-inputs-setup.md).
