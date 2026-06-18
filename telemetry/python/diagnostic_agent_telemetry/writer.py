from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from diagnostic_agent_telemetry.fingerprint import (
    EVENT_SCHEMA_VERSION,
    assert_no_output_fields,
    clone_input,
    new_event_id,
    resolve_correlation_id,
)

DEFAULT_MAX_BYTES = 50 * 1024 * 1024
DEFAULT_MAX_EVENTS = 100_000


def default_events_path() -> Path:
    override = os.environ.get("DIAGNOSTIC_AGENT_EVENTS_PATH")
    if override:
        return Path(override).expanduser().resolve()
    return Path.home() / ".diagnostic_agent" / "events.jsonl"


@dataclass
class EventWriter:
    file_path: Path | None = None
    max_bytes: int = DEFAULT_MAX_BYTES
    max_events: int = DEFAULT_MAX_EVENTS
    enabled: bool | None = None

    def __post_init__(self) -> None:
        if self.file_path is None:
            self.file_path = default_events_path()
        if self.enabled is None:
            self.enabled = os.environ.get("DIAGNOSTIC_AGENT_TELEMETRY", "1") != "0"
        self._event_count = self._count_existing_events()

    def write(self, event: dict[str, Any]) -> None:
        if not self.enabled:
            return

        assert_no_output_fields(event)
        assert self.file_path is not None
        self.file_path.parent.mkdir(parents=True, exist_ok=True)
        self._rotate_if_needed()
        with self.file_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(event, separators=(",", ":")) + "\n")
        self._event_count += 1

    def build_event(
        self,
        *,
        provider: str,
        model: str,
        call_type: str,
        input_payload: dict[str, Any],
        tokens: dict[str, Any],
        latency_ms: int | None = None,
        metadata: dict[str, Any] | None = None,
        finding_id: str | None = None,
        label: str | None = None,
    ) -> dict[str, Any]:
        correlation = resolve_correlation_id(finding_id=finding_id, label=label)
        event = {
            "event_id": new_event_id(),
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "schema_version": EVENT_SCHEMA_VERSION,
            "provider": provider,
            "model": model,
            "call_type": call_type,
            "input": clone_input(input_payload),
            "tokens": tokens,
            **correlation,
        }
        if latency_ms is not None:
            event["latency_ms"] = latency_ms
        if metadata:
            event["metadata"] = metadata
        assert_no_output_fields(event)
        return event

    def record(self, **kwargs: Any) -> dict[str, Any]:
        event = self.build_event(**kwargs)
        self.write(event)
        return event

    def _count_existing_events(self) -> int:
        if self.file_path is None or not self.file_path.exists():
            return 0
        text = self.file_path.read_text(encoding="utf-8")
        return len([line for line in text.splitlines() if line.strip()])

    def _rotate_if_needed(self) -> None:
        assert self.file_path is not None
        if not self.file_path.exists():
            return
        size = self.file_path.stat().st_size
        if size < self.max_bytes and self._event_count < self.max_events:
            return
        stamp = datetime.now(timezone.utc).isoformat().replace(":", "-").replace(".", "-")
        rotated = self.file_path.with_suffix(self.file_path.suffix + f".{stamp}")
        self.file_path.rename(rotated)
        self._event_count = 0


_default_writer: EventWriter | None = None


def get_default_writer() -> EventWriter:
    global _default_writer
    if _default_writer is None:
        _default_writer = EventWriter()
    return _default_writer
