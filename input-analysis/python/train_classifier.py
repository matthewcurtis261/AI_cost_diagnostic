#!/usr/bin/env python3
"""Train a multi-label DistilBERT metric classifier and commit head weights."""

from __future__ import annotations

import argparse
import json
import random
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from classifier_common import (
    CLASSIFIER_DIR,
    LABEL_MAP_PATH,
    TRAINING_SAMPLES_PATH,
    WEIGHTS_DIR,
    LabelMap,
    labels_to_vector,
    read_jsonl,
    write_jsonl,
)

try:
    import numpy as np
    import torch
    import torch.nn as nn
    from torch.utils.data import DataLoader, Dataset
    from transformers import AutoModel, AutoTokenizer, get_linear_schedule_with_warmup
except ImportError as exc:
    raise SystemExit(
        "Missing Python deps. Run: pip install -r input-analysis/python/requirements.txt"
    ) from exc


class MetricDataset(Dataset):
    def __init__(self, rows: list[dict[str, Any]], tokenizer, label_map: LabelMap):
        self.rows = rows
        self.tokenizer = tokenizer
        self.label_map = label_map

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, idx: int) -> dict[str, torch.Tensor]:
        row = self.rows[idx]
        encoded = self.tokenizer(
            row["text"],
            truncation=True,
            padding="max_length",
            max_length=self.label_map.max_length,
            return_tensors="pt",
        )
        labels = torch.tensor(labels_to_vector(row["labels"], self.label_map), dtype=torch.float)
        return {
            "input_ids": encoded["input_ids"].squeeze(0),
            "attention_mask": encoded["attention_mask"].squeeze(0),
            "labels": labels,
        }


class DistilBertMetricClassifier(nn.Module):
    def __init__(self, base_model: str, num_labels: int, dropout: float = 0.1):
        super().__init__()
        self.base_model_name = base_model
        self.encoder = AutoModel.from_pretrained(base_model)
        hidden = self.encoder.config.hidden_size
        self.dropout = nn.Dropout(dropout)
        self.classifier = nn.Linear(hidden, num_labels)

    def forward(self, input_ids: torch.Tensor, attention_mask: torch.Tensor) -> torch.Tensor:
        outputs = self.encoder(input_ids=input_ids, attention_mask=attention_mask)
        pooled = outputs.last_hidden_state[:, 0]
        pooled = self.dropout(pooled)
        return self.classifier(pooled)

    def save_head(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "base_model": self.base_model_name,
            "classifier_state_dict": self.classifier.state_dict(),
            "hidden_size": self.encoder.config.hidden_size,
            "num_labels": self.classifier.out_features,
        }
        torch.save(payload, path)

    @classmethod
    def load_head(cls, base_model: str, head_path: Path, num_labels: int) -> "DistilBertMetricClassifier":
        model = cls(base_model=base_model, num_labels=num_labels)
        payload = torch.load(head_path, map_location="cpu")
        model.classifier.load_state_dict(payload["classifier_state_dict"])
        return model


@dataclass
class TrainReport:
    schema_version: str
    trained_at: str
    base_model: str
    epochs: int
    train_rows: int
    val_rows: int
    threshold: float
    metrics: dict[str, float]
    label_support: dict[str, int]


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def split_rows(rows: list[dict[str, Any]], val_ratio: float, seed: int) -> tuple[list, list]:
    rng = random.Random(seed)
    rows = rows[:]
    rng.shuffle(rows)
    val_size = max(1, int(len(rows) * val_ratio))
    return rows[val_size:], rows[:val_size]


def multilabel_metrics(y_true: np.ndarray, y_prob: np.ndarray, threshold: float) -> dict[str, float]:
    y_pred = (y_prob >= threshold).astype(int)
    tp = ((y_true == 1) & (y_pred == 1)).sum()
    fp = ((y_true == 0) & (y_pred == 1)).sum()
    fn = ((y_true == 1) & (y_pred == 0)).sum()
    precision = tp / (tp + fp + 1e-9)
    recall = tp / (tp + fn + 1e-9)
    f1 = 2 * precision * recall / (precision + recall + 1e-9)
    exact = (y_pred == y_true).all(axis=1).mean()
    return {
        "precision_micro": float(precision),
        "recall_micro": float(recall),
        "f1_micro": float(f1),
        "subset_accuracy": float(exact),
    }


def train(
    rows: list[dict[str, Any]],
    label_map: LabelMap,
    epochs: int,
    batch_size: int,
    learning_rate: float,
    val_ratio: float,
    seed: int,
) -> tuple[DistilBertMetricClassifier, Any, TrainReport]:
    train_rows, val_rows = split_rows(rows, val_ratio=val_ratio, seed=seed)
    tokenizer = AutoTokenizer.from_pretrained(label_map.model)
    model = DistilBertMetricClassifier(label_map.model, num_labels=len(label_map.labels))

    train_loader = DataLoader(MetricDataset(train_rows, tokenizer, label_map), batch_size=batch_size, shuffle=True)
    val_loader = DataLoader(MetricDataset(val_rows, tokenizer, label_map), batch_size=batch_size)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model.to(device)

    optimizer = torch.optim.AdamW(model.parameters(), lr=learning_rate)
    total_steps = max(1, len(train_loader) * epochs)
    scheduler = get_linear_schedule_with_warmup(
        optimizer,
        num_warmup_steps=max(1, total_steps // 10),
        num_training_steps=total_steps,
    )
    loss_fn = nn.BCEWithLogitsLoss()

    model.train()
    for _epoch in range(epochs):
        for batch in train_loader:
            optimizer.zero_grad()
            logits = model(
                batch["input_ids"].to(device),
                batch["attention_mask"].to(device),
            )
            loss = loss_fn(logits, batch["labels"].to(device))
            loss.backward()
            optimizer.step()
            scheduler.step()

    model.eval()
    probs: list[np.ndarray] = []
    labels: list[np.ndarray] = []
    with torch.no_grad():
        for batch in val_loader:
            logits = model(
                batch["input_ids"].to(device),
                batch["attention_mask"].to(device),
            )
            batch_probs = torch.sigmoid(logits).cpu().numpy()
            probs.append(batch_probs)
            labels.append(batch["labels"].cpu().numpy())

    y_prob = np.vstack(probs)
    y_true = np.vstack(labels)
    metrics = multilabel_metrics(y_true, y_prob, label_map.threshold)

    label_support: dict[str, int] = {}
    for row in rows:
        for label in row["labels"]:
            label_support[label] = label_support.get(label, 0) + 1

    report = TrainReport(
        schema_version="0.1.0",
        trained_at=utc_now(),
        base_model=label_map.model,
        epochs=epochs,
        train_rows=len(train_rows),
        val_rows=len(val_rows),
        threshold=label_map.threshold,
        metrics=metrics,
        label_support=label_support,
    )
    return model, tokenizer, report


def save_artifacts(
    model: DistilBertMetricClassifier,
    tokenizer,
    label_map: LabelMap,
    report: TrainReport,
    weights_dir: Path,
) -> None:
    weights_dir.mkdir(parents=True, exist_ok=True)
    model.save_head(weights_dir / "classifier-head.pt")
    tokenizer.save_pretrained(weights_dir)
    (weights_dir / "model-meta.json").write_text(
        json.dumps(
            {
                "schema_version": "0.1.0",
                "base_model": label_map.model,
                "num_labels": len(label_map.labels),
                "max_length": label_map.max_length,
                "threshold": label_map.threshold,
                "labels": label_map.labels,
                "head_file": "classifier-head.pt",
                "trained": True,
                "notes": "Fine-tuned DistilBERT classification head. Takes precedence over classifier-head.json.",
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (CLASSIFIER_DIR / "training-report.json").write_text(
        json.dumps(asdict(report), indent=2) + "\n",
        encoding="utf-8",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Train DistilBERT metric classifier")
    parser.add_argument("--data", type=Path, default=TRAINING_SAMPLES_PATH)
    parser.add_argument("--weights-dir", type=Path, default=WEIGHTS_DIR)
    parser.add_argument("--epochs", type=int, default=4)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--learning-rate", type=float, default=2e-5)
    parser.add_argument("--val-ratio", type=float, default=0.15)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--build-data", action="store_true", help="Run build_training_data first")
    parser.add_argument("--seed-only", action="store_true", help="Build data from seed only")
    args = parser.parse_args()

    if args.build_data or not args.data.exists():
        from build_training_data import build_training_data

        rows = build_training_data(seed_only=args.seed_only)
        write_jsonl(args.data, rows)
        print(f"Built training data: {args.data} ({len(rows)} rows)", file=sys.stderr)

    rows = read_jsonl(args.data)
    if len(rows) < 20:
        print("error: need at least 20 training rows", file=sys.stderr)
        return 1

    label_map = LabelMap.load(LABEL_MAP_PATH)
    model, tokenizer, report = train(
        rows=rows,
        label_map=label_map,
        epochs=args.epochs,
        batch_size=args.batch_size,
        learning_rate=args.learning_rate,
        val_ratio=args.val_ratio,
        seed=args.seed,
    )
    save_artifacts(model, tokenizer, label_map, report, args.weights_dir)
    print(json.dumps(asdict(report), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
