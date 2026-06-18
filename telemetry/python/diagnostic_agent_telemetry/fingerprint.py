from __future__ import annotations

import hashlib
import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

FORBIDDEN_KEYS = {
    "output",
    "output_text",
    "output_content",
    "completion",
    "completion_text",
    "response_content",
    "response_text",
    "choices",
    "result",
    "answer",
}

TELEMETRY_FRAME_MARKERS = (
    "diagnostic_agent_telemetry",
    "diagnostic_agent/telemetry",
    "site-packages",
)


class ForbiddenOutputFieldError(ValueError):
    pass


def assert_no_output_fields(value: Any, path: str = "root", in_messages: bool = False) -> None:
    if value is None:
        return
    if isinstance(value, list):
        next_in_messages = in_messages or path.endswith(".messages")
        for i, item in enumerate(value):
            assert_no_output_fields(item, f"{path}[{i}]", next_in_messages)
        return
    if not isinstance(value, dict):
        return

    for key, child in value.items():
        child_path = f"{path}.{key}"
        if key in FORBIDDEN_KEYS:
            if key in {"content", "text"} and in_messages:
                assert_no_output_fields(child, child_path, True)
                continue
            raise ForbiddenOutputFieldError(f"Telemetry event must not contain output field at {child_path}")
        assert_no_output_fields(child, child_path, in_messages or key == "messages")


def clone_input(value: Any) -> dict[str, Any]:
    import json

    return json.loads(json.dumps(value if value is not None else {}))


def new_event_id() -> str:
    material = f"{time.time_ns()}-{os.urandom(8).hex()}"
    suffix = hashlib.sha256(material.encode()).hexdigest()[:10]
    return f"evt_{suffix}"


def resolve_correlation_id(*, finding_id: str | None = None, label: str | None = None) -> dict[str, str]:
    if finding_id:
        return {"finding_id": finding_id}

    import traceback

    stack = traceback.format_stack()
    frame = "unknown"
    for line in stack:
        stripped = line.strip()
        if stripped.startswith('File "') and not any(m in stripped for m in TELEMETRY_FRAME_MARKERS):
            frame = stripped
            break

    material = "|".join(part for part in (label or "", frame) if part)
    digest = hashlib.sha256(material.encode()).hexdigest()[:12]
    return {"call_site_fingerprint": f"cs_{digest}"}


EVENT_SCHEMA_VERSION = "0.1.0"
