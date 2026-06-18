#!/usr/bin/env python3
"""Fetch and normalize quality scores from Open LLM Leaderboard into a snapshot JSON."""

from __future__ import annotations

import json
import math
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
METRICS_PATH = ROOT / "metrics.json"
OUTPUT_PATH = ROOT / "data" / "quality-scores.snapshot.json"

OLL_DATASET = "open-llm-leaderboard/contents"
OLL_HF_ORG = "open-llm-leaderboard"

# Manual seeds for metrics not on OLL (representative published scores, normalized 0-1).
# Keys are leaderboard-style model ids; values are partial metric overrides.
MANUAL_SCORE_SEEDS: dict[str, dict[str, float]] = {
    "meta-llama/Llama-3.1-8B-Instruct": {
        "code_completion": 0.72,
        "commonsense": 0.79,
    },
    "meta-llama/Llama-3.1-70B-Instruct": {
        "code_completion": 0.84,
        "commonsense": 0.85,
    },
    "meta-llama/Llama-3.3-70B-Instruct": {
        "code_completion": 0.86,
        "commonsense": 0.86,
    },
    "deepseek-ai/DeepSeek-V3": {
        "code_completion": 0.90,
        "repo_engineering": 0.42,
    },
    "deepseek-ai/DeepSeek-R1": {
        "code_completion": 0.88,
        "math": 0.90,
    },
    "Qwen/Qwen2.5-7B-Instruct": {
        "code_completion": 0.78,
        "commonsense": 0.80,
    },
    "Qwen/Qwen2.5-72B-Instruct": {
        "code_completion": 0.88,
        "commonsense": 0.88,
    },
    "microsoft/phi-4": {
        "code_completion": 0.82,
        "math": 0.80,
    },
    "mistralai/Mistral-Small-Instruct-2409": {
        "code_completion": 0.75,
    },
    "mistralai/Mistral-Large-Instruct-2407": {
        "code_completion": 0.85,
    },
}


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def load_metrics() -> list[dict[str, Any]]:
    data = json.loads(METRICS_PATH.read_text(encoding="utf-8"))
    return data["metrics"]


def normalize_score(raw: Any, kind: str) -> float | None:
    if raw is None:
        return None
    if isinstance(raw, str):
        raw = raw.strip()
        if raw in {"", "N/A", "nan", "None"}:
            return None
        try:
            value = float(raw)
        except ValueError:
            return None
    elif isinstance(raw, (int, float)):
        value = float(raw)
    else:
        return None

    if math.isnan(value) or math.isinf(value):
        return None

    # OLL raw columns are typically 0-100 percentages.
    if kind in {"accuracy", "pass_at_k", "strict_pass", "resolve_rate", "ast_match", "recall", "task_success", "key_point_recall", "judge_score"}:
        if value > 1.0:
            return round(min(value / 100.0, 1.0), 4)
        return round(min(max(value, 0.0), 1.0), 4)

    return round(min(max(value, 0.0), 1.0), 4)


def slugify_model_id(name: str) -> str:
    cleaned = name.strip()
    if "/" in cleaned:
        return cleaned
    # OLL fullname often looks like "meta-llama/Llama-3.1-8B-Instruct" in Model field
    return cleaned


def infer_model_type(row: dict[str, Any]) -> str:
    model_type = str(row.get("Type") or row.get("type") or "").lower()
    if "proprietary" in model_type or row.get("Private") in {True, "true", "True"}:
        return "proprietary"
    if any(token in model_type for token in ("open", "fine-tuned", "fine tuned")):
        return "open"
    name = str(row.get("fullname") or row.get("Model") or "")
    if any(p in name.lower() for p in ("gpt-", "claude", "gemini", "o1", "o3")):
        return "proprietary"
    return "open"


def pick_column(row: dict[str, Any], candidates: list[str]) -> tuple[Any, str | None]:
    for col in candidates:
        if col in row and row[col] not in (None, "", "N/A"):
            return row[col], col
    return None, None


def combine_scores(values: list[float], mode: str) -> float | None:
    if not values:
        return None
    if mode == "max":
        return round(max(values), 4)
    return round(sum(values) / len(values), 4)


def metric_value_for_row(metric: dict[str, Any], row: dict[str, Any]) -> tuple[float | None, str | None]:
    columns = metric.get("oll_columns") or []
    if not columns:
        return None, None

    kind = metric.get("score_kind", "accuracy")
    combine = metric.get("combine", "first")

    if combine == "max":
        values: list[float] = []
        used_cols: list[str] = []
        for col in columns:
            raw = row.get(col)
            norm = normalize_score(raw, kind)
            if norm is not None:
                values.append(norm)
                used_cols.append(col)
        if not values:
            return None, None
        return combine_scores(values, "max"), "+".join(used_cols)

    raw, col = pick_column(row, columns)
    norm = normalize_score(raw, kind)
    return norm, col


def fetch_oll_rows() -> list[dict[str, Any]]:
    try:
        import datasets  # type: ignore
    except ImportError as exc:
        raise RuntimeError(
            "Missing Python deps. Run: pip install -r input-analysis/python/requirements.txt"
        ) from exc

    print(f"Loading HuggingFace dataset: {OLL_DATASET}")
    ds = datasets.load_dataset(OLL_DATASET, split="train")
    rows = [dict(record) for record in ds]
    print(f"Loaded {len(rows)} leaderboard rows")
    return rows


def build_model_entry(
    model_id: str,
    display_name: str,
    model_type: str,
    scores: dict[str, float | None],
    score_sources: dict[str, str],
) -> dict[str, Any]:
    return {
        "display_name": display_name,
        "oll_id": model_id,
        "type": model_type,
        "scores": scores,
        "score_sources": score_sources,
    }


def apply_manual_seeds(models: dict[str, dict[str, Any]]) -> None:
    for model_id, seeds in MANUAL_SCORE_SEEDS.items():
        entry = models.setdefault(
            model_id,
            build_model_entry(model_id, model_id, "open", {}, {}),
        )
        for metric_id, value in seeds.items():
            entry["scores"][metric_id] = value
            entry["score_sources"][metric_id] = "manual_seed_v0.1.0"


def build_snapshot(rows: list[dict[str, Any]], metrics: list[dict[str, Any]]) -> dict[str, Any]:
    metric_ids = [m["id"] for m in metrics]
    models: dict[str, dict[str, Any]] = {}

    for row in rows:
        display = str(row.get("fullname") or row.get("Model") or "").strip()
        if not display:
            continue

        model_id = slugify_model_id(display)
        model_type = infer_model_type(row)
        scores: dict[str, float | None] = {mid: None for mid in metric_ids}
        score_sources: dict[str, str] = {}

        for metric in metrics:
            value, source_col = metric_value_for_row(metric, row)
            if value is not None and source_col:
                scores[metric["id"]] = value
                score_sources[metric["id"]] = f"oll:{source_col}"

        if not any(v is not None for v in scores.values()):
            continue

        models[model_id] = build_model_entry(model_id, display, model_type, scores, score_sources)

    apply_manual_seeds(models)

    metrics_with_data: dict[str, int] = {}
    for metric_id in metric_ids:
        count = sum(1 for m in models.values() if m["scores"].get(metric_id) is not None)
        metrics_with_data[metric_id] = count

    coverage_notes = [
        "Scores normalized to 0-1. OLL raw percentage columns divided by 100 when > 1.",
        "Arena, BFCL, SWE-bench, and several MT-Bench categories are not in OLL v2; manual seeds used where noted.",
        "This snapshot is for diagnostic what-if analysis, not production routing.",
    ]

    for metric in metrics:
        if not metric.get("oll_columns"):
            note = metric.get("coverage_note")
            if note:
                coverage_notes.append(f"{metric['id']}: {note}")

    return {
        "schema_version": "0.1.0",
        "generated_at": utc_now(),
        "sources": [
            {
                "id": "open-llm-leaderboard-v2",
                "url": f"https://huggingface.co/datasets/{OLL_DATASET}",
                "fetched_at": utc_now(),
                "notes": "Primary source for IFEval, BBH, MATH Lvl 5, GPQA, MUSR, MMLU-Pro",
            }
        ],
        "metrics": [
            {
                "id": m["id"],
                "label": m["label"],
                "benchmarks": m.get("benchmarks", []),
                "score_kind": m.get("score_kind", "accuracy"),
            }
            for m in metrics
        ],
        "normalization": {
            "accuracy_scale": "0-1",
            "arena_elo": {
                "min": None,
                "max": None,
                "per_category": True,
            },
        },
        "models": models,
        "coverage": {
            "total_models": len(models),
            "metrics_with_data": metrics_with_data,
            "notes": coverage_notes,
        },
    }


def write_snapshot(snapshot: dict[str, Any], output_path: Path = OUTPUT_PATH) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(snapshot, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {output_path} ({snapshot['coverage']['total_models']} models)")


def main() -> int:
    metrics = load_metrics()
    try:
        rows = fetch_oll_rows()
    except Exception as exc:
        print(f"WARN: HuggingFace fetch failed: {exc}", file=sys.stderr)
        seed_path = ROOT / "data" / "quality-scores.seed.json"
        if seed_path.exists():
            print(f"Falling back to seed: {seed_path}")
            snapshot = json.loads(seed_path.read_text(encoding="utf-8"))
            snapshot["generated_at"] = utc_now()
            snapshot["sources"].append(
                {
                    "id": "quality-scores.seed.json",
                    "url": str(seed_path),
                    "fetched_at": utc_now(),
                    "notes": f"Offline fallback because live fetch failed: {exc}",
                }
            )
            write_snapshot(snapshot)
            return 0
        print("ERROR: no seed fallback available", file=sys.stderr)
        return 1

    snapshot = build_snapshot(rows, metrics)
    write_snapshot(snapshot)

    covered = sum(1 for c in snapshot["coverage"]["metrics_with_data"].values() if c > 0)
    print(f"Metrics with data: {covered}/{len(metrics)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
