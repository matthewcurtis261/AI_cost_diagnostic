#!/usr/bin/env python3
"""Classify telemetry inputs into quality metric families (stdin/stdout JSON)."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from classifier_common import (
    CLASSIFIER_DIR,
    LABEL_MAP_PATH,
    WEIGHTS_DIR,
    LabelMap,
    active_metrics,
    extract_text_from_telemetry_input,
    keyword_fallback_scores,
    lexicon_scores,
    preview_text,
)

try:
    import torch
    import torch.nn as nn
    from transformers import AutoModel, AutoTokenizer
except ImportError:
    torch = None  # type: ignore
    nn = None  # type: ignore
    AutoModel = None  # type: ignore
    AutoTokenizer = None  # type: ignore


class DistilBertMetricClassifier(nn.Module if nn is not None else object):
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

    @classmethod
    def load_head(cls, base_model: str, head_path: Path, num_labels: int) -> "DistilBertMetricClassifier":
        model = cls(base_model=base_model, num_labels=num_labels)
        payload = torch.load(head_path, map_location="cpu")
        model.classifier.load_state_dict(payload["classifier_state_dict"])
        model.eval()
        return model


class MetricClassifierRuntime:
    def __init__(self, label_map: LabelMap, weights_dir: Path, force_fallback: bool = False):
        self.label_map = label_map
        self.weights_dir = weights_dir
        self.force_fallback = force_fallback
        self.mode = "keyword_fallback"
        self.model = None
        self.tokenizer = None
        self.lexicon: dict[str, Any] | None = None

        head_pt = weights_dir / "classifier-head.pt"
        head_json = weights_dir / "classifier-head.json"
        meta_path = weights_dir / "model-meta.json"

        if not force_fallback and head_json.exists():
            payload = json.loads(head_json.read_text(encoding="utf-8"))
            if payload.get("format") == "keyword_lexicon":
                self.lexicon = payload
                self.mode = "keyword_lexicon"

        if (
            not force_fallback
            and self.lexicon is None
            and head_pt.exists()
            and meta_path.exists()
            and torch is not None
            and AutoModel is not None
            and AutoTokenizer is not None
        ):
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            base_model = meta.get("base_model", label_map.model)
            try:
                self.tokenizer = AutoTokenizer.from_pretrained(weights_dir)
                self.model = DistilBertMetricClassifier.load_head(
                    base_model=base_model,
                    head_path=head_pt,
                    num_labels=len(label_map.labels),
                )
                self.mode = "distilbert_head"
            except Exception:
                self.model = None
                self.tokenizer = None

    def predict_batch(self, texts: list[str]) -> list[dict[str, Any]]:
        threshold = self.label_map.threshold
        if self.mode == "keyword_lexicon" and self.lexicon is not None:
            return [
                self._format_prediction(
                    idx,
                    text,
                    lexicon_scores(text, self.lexicon, self.label_map),
                    threshold,
                )
                for idx, text in enumerate(texts)
            ]

        if self.mode == "keyword_fallback" or self.model is None or self.tokenizer is None:
            return [
                self._format_prediction(idx, text, keyword_fallback_scores(text, self.label_map, threshold), threshold)
                for idx, text in enumerate(texts)
            ]

        device = torch.device("cpu")
        self.model.to(device)
        encoded = self.tokenizer(
            texts,
            truncation=True,
            padding=True,
            max_length=self.label_map.max_length,
            return_tensors="pt",
        )
        with torch.no_grad():
            logits = self.model(encoded["input_ids"].to(device), encoded["attention_mask"].to(device))
            probs = torch.sigmoid(logits).cpu().numpy()

        out: list[dict[str, Any]] = []
        for idx, (text, row) in enumerate(zip(texts, probs)):
            scores = {label: float(row[i]) for i, label in enumerate(self.label_map.labels)}
            out.append(self._format_prediction(idx, text, scores, threshold))
        return out

    def _format_prediction(
        self,
        index: int,
        text: str,
        scores: dict[str, float],
        threshold: float,
    ) -> dict[str, Any]:
        metric_ids = active_metrics(scores, threshold)
        primary = metric_ids[0] if metric_ids else None
        return {
            "index": index,
            "text_preview": preview_text(text),
            "metric_ids": metric_ids,
            "scores": {k: round(v, 4) for k, v in scores.items() if v >= 0.2 or k in metric_ids},
            "primary_metric": primary,
        }


def parse_request(payload: dict[str, Any]) -> list[str]:
    if isinstance(payload.get("texts"), list):
        return [str(t) for t in payload["texts"]]

    if isinstance(payload.get("inputs"), list):
        texts: list[str] = []
        for item in payload["inputs"]:
            if isinstance(item, str):
                texts.append(item)
            elif isinstance(item, dict):
                if "text" in item and isinstance(item["text"], str):
                    texts.append(item["text"])
                elif "input" in item and isinstance(item["input"], dict):
                    texts.append(extract_text_from_telemetry_input(item["input"]))
                else:
                    texts.append(extract_text_from_telemetry_input(item))
        return texts

    if isinstance(payload.get("text"), str):
        return [payload["text"]]

    raise ValueError("Request must include texts[], inputs[], or text")


def classify_payload(
    payload: dict[str, Any],
    label_map: LabelMap,
    weights_dir: Path,
    force_fallback: bool = False,
) -> dict[str, Any]:
    texts = parse_request(payload)
    runtime = MetricClassifierRuntime(label_map, weights_dir, force_fallback=force_fallback)
    predictions = runtime.predict_batch(texts)
    warnings: list[str] = []
    if runtime.mode == "keyword_fallback":
        warnings.append(
            "Using keyword fallback classifier. Train weights with: pnpm run train-classifier"
        )
    return {
        "schema_version": "0.1.0",
        "model": {
            "base": label_map.model,
            "weights_path": str(weights_dir),
            "label_count": len(label_map.labels),
            "threshold": label_map.threshold,
            "runtime_mode": runtime.mode,
        },
        "predictions": predictions,
        "warnings": warnings,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Classify LLM inputs into quality metrics")
    parser.add_argument("--weights-dir", type=Path, default=WEIGHTS_DIR)
    parser.add_argument("--label-map", type=Path, default=LABEL_MAP_PATH)
    parser.add_argument("--fallback", action="store_true", help="Force keyword fallback mode")
    parser.add_argument("--input", type=Path, default=None, help="JSON file; default stdin")
    args = parser.parse_args()

    try:
        if args.input:
            payload = json.loads(args.input.read_text(encoding="utf-8"))
        else:
            raw = sys.stdin.read()
            payload = json.loads(raw) if raw.strip() else {"texts": []}
        label_map = LabelMap.load(args.label_map)
        result = classify_payload(payload, label_map, args.weights_dir, force_fallback=args.fallback)
        sys.stdout.write(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as exc:
        sys.stderr.write(f"classify error: {exc}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
