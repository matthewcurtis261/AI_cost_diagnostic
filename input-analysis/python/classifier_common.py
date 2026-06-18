"""Shared utilities for the input metric classifier (Milestone 6c)."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CLASSIFIER_DIR = ROOT / "classifier"
LABEL_MAP_PATH = CLASSIFIER_DIR / "label_map.json"
WEIGHTS_DIR = CLASSIFIER_DIR / "weights"
SEED_SAMPLES_PATH = ROOT / "data" / "training-samples.seed.jsonl"
TRAINING_SAMPLES_PATH = ROOT / "data" / "training-samples.jsonl"
METRICS_PATH = ROOT / "metrics.json"


@dataclass(frozen=True)
class LabelMap:
    schema_version: str
    model: str
    task: str
    max_length: int
    threshold: float
    labels: list[str]

    @classmethod
    def load(cls, path: Path = LABEL_MAP_PATH) -> "LabelMap":
        data = json.loads(path.read_text(encoding="utf-8"))
        return cls(
            schema_version=data["schema_version"],
            model=data["model"],
            task=data["task"],
            max_length=int(data.get("max_length", 256)),
            threshold=float(data.get("threshold", 0.35)),
            labels=list(data["labels"]),
        )

    def label_to_index(self) -> dict[str, int]:
        return {label: idx for idx, label in enumerate(self.labels)}


def load_metrics() -> list[dict[str, Any]]:
    data = json.loads(METRICS_PATH.read_text(encoding="utf-8"))
    return data["metrics"]


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        rows.append(json.loads(line))
    return rows


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def normalize_labels(raw: Any, label_map: LabelMap) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list):
        return []
    valid = set(label_map.labels)
    out: list[str] = []
    for item in raw:
        if isinstance(item, str) and item in valid and item not in out:
            out.append(item)
    return out


def labels_to_vector(labels: list[str], label_map: LabelMap) -> list[int]:
    vec = [0] * len(label_map.labels)
    idx = label_map.label_to_index()
    for label in labels:
        if label in idx:
            vec[idx[label]] = 1
    return vec


def truncate_text(text: str, max_chars: int = 4000) -> str:
    text = text.strip()
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 3] + "..."


def preview_text(text: str, max_chars: int = 120) -> str:
    text = re.sub(r"\s+", " ", text.strip())
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 3] + "..."


def extract_text_from_telemetry_input(payload: dict[str, Any]) -> str:
    """Flatten telemetry event input payloads into classifier text."""
    parts: list[str] = []

    messages = payload.get("messages")
    if isinstance(messages, list):
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            role = msg.get("role", "unknown")
            content = msg.get("content")
            if isinstance(content, str):
                parts.append(f"{role}: {content}")
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, dict):
                        text = block.get("text") or block.get("input_text")
                        if isinstance(text, str):
                            parts.append(f"{role}: {text}")

    for key in ("prompt", "text", "input", "question", "instruction"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            parts.append(value.strip())

    tools = payload.get("tools")
    if isinstance(tools, list) and tools:
        parts.append("tools:")
        for tool in tools[:8]:
            if isinstance(tool, dict):
                fn = tool.get("function") if isinstance(tool.get("function"), dict) else tool
                name = fn.get("name") if isinstance(fn, dict) else None
                desc = fn.get("description") if isinstance(fn, dict) else None
                if name:
                    parts.append(f"- {name}: {desc or ''}".strip())

    params = payload.get("parameters")
    if isinstance(params, dict) and params:
        param_bits = []
        for k in ("temperature", "max_tokens", "response_format"):
            if k in params:
                param_bits.append(f"{k}={params[k]}")
        if param_bits:
            parts.append("params: " + ", ".join(param_bits))

    if not parts:
        return json.dumps(payload, ensure_ascii=False)

    return "\n".join(parts)


def keyword_fallback_scores(text: str, label_map: LabelMap, threshold: float) -> dict[str, float]:
    """Heuristic fallback when model weights are unavailable."""
    lower = text.lower()
    scores: dict[str, float] = {label: 0.05 for label in label_map.labels}

    rules: list[tuple[str, list[str], float]] = [
        ("mcq_knowledge", ["multiple choice", "which of the following", "select the correct", "mmlu"], 0.82),
        ("expert_science", ["quantum", "biochemistry", "physics", "gpqa", "molecule"], 0.78),
        ("math", ["solve for", "equation", "calculate", "integral", "gsm8k", "math problem"], 0.84),
        ("multi_step_reasoning", ["step by step", "chain of thought", "reason through", "deduce"], 0.76),
        ("code_completion", ["def ", "function(", "implement ", "python code", "javascript", "humaneval"], 0.86),
        ("repo_engineering", ["pull request", "fix the bug in", "repository", "swe-bench", "patch"], 0.8),
        ("tool_call", ["function call", "tool call", "json schema", "invoke tool", "bfcl"], 0.83),
        ("instruction_following", ["follow these instructions", "ifeval", "output format", "must include"], 0.8),
        ("writing", ["write a poem", "creative writing", "story about", "blog post"], 0.78),
        ("roleplay", ["you are a", "stay in character", "roleplay as", "persona"], 0.77),
        ("extraction", ["extract", "return json", "parse the following", "structured output"], 0.79),
        ("reasoning_chat", ["explain why", "think carefully", "reason about"], 0.74),
        ("coding_chat", ["debug this code", "refactor", "code review", "explain this function"], 0.8),
        ("stem_chat", ["science question", "biology", "chemistry", "engineering"], 0.72),
        ("humanities_chat", ["history", "philosophy", "literature", "humanities"], 0.72),
        ("factuality", ["true or false", "fact check", "truthful", "accurate statement"], 0.76),
        ("long_context_retrieval", ["needle", "long document", "context window", "retrieve from"], 0.75),
        ("rag_synthesis", ["based on the documents", "summarize the sources", "rag", "retrieved context"], 0.8),
        ("agentic", ["multi-step task", "browse", "terminal", "agent", "autonomous"], 0.77),
        ("commonsense", ["commonsense", "most likely", "hellaswag", "everyday situation"], 0.73),
    ]

    for label, cues, weight in rules:
        if any(cue in lower for cue in cues):
            scores[label] = max(scores[label], weight)

    # Light boost for generic chat when nothing else fired strongly.
    if max(scores.values()) < threshold:
        scores["reasoning_chat"] = 0.45
        scores["instruction_following"] = 0.4

    return scores


def lexicon_scores(text: str, lexicon: dict[str, Any], label_map: LabelMap) -> dict[str, float]:
    lower = text.lower()
    default_score = float(lexicon.get("default_score", 0.05))
    match_weight = float(lexicon.get("match_weight", 0.77))
    scores: dict[str, float] = {label: default_score for label in label_map.labels}
    labels = lexicon.get("labels", {})
    if not isinstance(labels, dict):
        return keyword_fallback_scores(text, label_map, label_map.threshold)

    for label, spec in labels.items():
        if label not in scores or not isinstance(spec, dict):
            continue
        keywords = spec.get("keywords", [])
        bias = float(spec.get("bias", 0.0))
        if isinstance(keywords, list) and any(isinstance(k, str) and k.lower() in lower for k in keywords):
            scores[label] = max(scores[label], min(0.99, match_weight + bias))
    return scores


def active_metrics(scores: dict[str, float], threshold: float) -> list[str]:
    active = [k for k, v in scores.items() if v >= threshold]
    if active:
        return sorted(active, key=lambda k: scores[k], reverse=True)
    if not scores:
        return []
    best = max(scores, key=lambda k: scores[k])
    return [best]
