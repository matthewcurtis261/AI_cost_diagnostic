#!/usr/bin/env python3
"""Build classifier training data from public benchmarks + local seed."""

from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path
from typing import Any

from classifier_common import (
    LABEL_MAP_PATH,
    SEED_SAMPLES_PATH,
    TRAINING_SAMPLES_PATH,
    LabelMap,
    normalize_labels,
    truncate_text,
    write_jsonl,
)

# HuggingFace dataset specs: (dataset, config, split, text_fn, label_fn, max_rows)
HF_SPECS: list[dict[str, Any]] = [
    {
        "dataset": "cais/mmlu",
        "config": "all",
        "split": "test",
        "labels": ["mcq_knowledge"],
        "max_rows": 400,
        "text": lambda row: (
            f"Question: {row['question']}\n"
            + "\n".join(f"{chr(65+i)}. {choice}" for i, choice in enumerate(row["choices"]))
            + "\nAnswer:"
        ),
    },
    {
        "dataset": "gsm8k",
        "config": "main",
        "split": "train",
        "labels": ["math"],
        "max_rows": 400,
        "text": lambda row: f"Math problem: {row['question']}",
    },
    {
        "dataset": "openai_humaneval",
        "config": None,
        "split": "test",
        "labels": ["code_completion"],
        "max_rows": 164,
        "text": lambda row: f"Complete this Python function:\n{row['prompt']}",
    },
    {
        "dataset": "google-research-datasets/mbpp",
        "config": "full",
        "split": "train",
        "labels": ["code_completion"],
        "max_rows": 300,
        "text": lambda row: f"Write Python code: {row['text']}",
    },
    {
        "dataset": "allenai/ifeval",
        "config": None,
        "split": "train",
        "labels": ["instruction_following"],
        "max_rows": 400,
        "text": lambda row: f"Instruction: {row.get('prompt') or row.get('instruction')}",
    },
    {
        "dataset": "truthful_qa",
        "config": "generation",
        "split": "validation",
        "labels": ["factuality"],
        "max_rows": 200,
        "text": lambda row: f"Question: {row['question']}\nProvide a truthful answer.",
    },
    {
        "dataset": "Rowan/hellaswag",
        "config": None,
        "split": "validation",
        "labels": ["commonsense"],
        "max_rows": 300,
        "text": lambda row: (
            f"Context: {row['ctx']}\n"
            f"Ending A: {row['endings'][0]}\n"
            f"Ending B: {row['endings'][1]}\n"
            f"Ending C: {row['endings'][2]}\n"
            f"Ending D: {row['endings'][3]}\n"
            "Pick the most plausible ending."
        ),
    },
]


def load_hf_rows(spec: dict[str, Any], rng: random.Random) -> list[dict[str, Any]]:
    try:
        from datasets import load_dataset
    except ImportError as exc:
        raise RuntimeError(
            "Missing Python deps. Run: pip install -r input-analysis/python/requirements.txt"
        ) from exc

    kwargs: dict[str, Any] = {"split": spec["split"]}
    if spec.get("config"):
        ds = load_dataset(spec["dataset"], spec["config"], **kwargs)
    else:
        ds = load_dataset(spec["dataset"], **kwargs)

    rows = list(ds)
    rng.shuffle(rows)
    max_rows = int(spec["max_rows"])
    rows = rows[:max_rows]

    out: list[dict[str, Any]] = []
    text_fn = spec["text"]
    for row in rows:
        try:
            text = truncate_text(str(text_fn(row)))
        except Exception:
            continue
        if not text.strip():
            continue
        out.append(
            {
                "text": text,
                "labels": spec["labels"],
                "source": f"hf:{spec['dataset']}",
            }
        )
    return out


def dedupe_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for row in rows:
        key = row["text"][:200]
        if key in seen:
            continue
        seen.add(key)
        out.append(row)
    return out


def normalize_seed_rows(rows: list[dict[str, Any]], label_map: LabelMap) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in rows:
        labels = normalize_labels(row.get("labels"), label_map)
        text = truncate_text(str(row.get("text", "")))
        if not text or not labels:
            continue
        out.append(
            {
                "text": text,
                "labels": labels,
                "source": row.get("source", "seed"),
            }
        )
    return out


def build_training_data(seed_only: bool = False, max_total: int | None = None) -> list[dict[str, Any]]:
    label_map = LabelMap.load()
    rng = random.Random(42)

    rows = normalize_seed_rows(
        [json.loads(line) for line in SEED_SAMPLES_PATH.read_text(encoding="utf-8").splitlines() if line.strip()],
        label_map,
    )

    if not seed_only:
        for spec in HF_SPECS:
            try:
                rows.extend(load_hf_rows(spec, rng))
            except Exception as exc:
                print(f"warn: skipped {spec['dataset']}: {exc}", file=sys.stderr)

    rows = dedupe_rows(rows)
    rng.shuffle(rows)
    if max_total is not None:
        rows = rows[:max_total]
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description="Build classifier training JSONL")
    parser.add_argument("--seed-only", action="store_true", help="Use committed seed samples only")
    parser.add_argument("--output", type=Path, default=TRAINING_SAMPLES_PATH)
    parser.add_argument("--max-total", type=int, default=None)
    args = parser.parse_args()

    rows = build_training_data(seed_only=args.seed_only, max_total=args.max_total)
    write_jsonl(args.output, rows)

    by_label: dict[str, int] = {}
    for row in rows:
        for label in row["labels"]:
            by_label[label] = by_label.get(label, 0) + 1

    print(
        json.dumps(
            {
                "output": str(args.output),
                "total_rows": len(rows),
                "labels_covered": len(by_label),
                "by_label": by_label,
                "label_map": str(LABEL_MAP_PATH),
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
