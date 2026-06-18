from __future__ import annotations

import os
import time
from typing import Any

from diagnostic_agent_telemetry.writer import EventWriter, get_default_writer


def _usage_from_anthropic(usage: Any) -> dict[str, Any]:
    if usage is None:
        return {
            "input_tokens": 0,
            "output_tokens": 0,
            "source": "unknown",
        }
    input_tokens = getattr(usage, "input_tokens", None) or usage.get("input_tokens", 0)
    output_tokens = getattr(usage, "output_tokens", None) or usage.get("output_tokens", 0)
    return {
        "input_tokens": int(input_tokens or 0),
        "output_tokens": int(output_tokens or 0),
        "total_tokens": int(input_tokens or 0) + int(output_tokens or 0),
        "source": "provider",
    }


def _extract_model(request: dict[str, Any], response: Any) -> str:
    model = request.get("model")
    if isinstance(model, str) and model:
        return model
    response_model = getattr(response, "model", None)
    if isinstance(response_model, str) and response_model:
        return response_model
    return "unknown"


def instrument_anthropic(
    client: Any,
    *,
    finding_id: str | None = None,
    label: str | None = None,
    writer: EventWriter | None = None,
    environment: str | None = None,
) -> Any:
    """Wrap Anthropic messages.create to emit telemetry events."""
    event_writer = writer or get_default_writer()
    original_create = client.messages.create

    def wrapped_create(*args: Any, **kwargs: Any) -> Any:
        started = time.time()
        response = original_create(*args, **kwargs)
        request = kwargs if kwargs else (args[0] if args else {})
        if not isinstance(request, dict):
            request = {}

        event_writer.record(
            provider="anthropic",
            model=_extract_model(request, response),
            call_type="chat_completion",
            input_payload={
                "messages": request.get("messages", []),
                "system": request.get("system"),
                "tools": request.get("tools"),
                "parameters": {
                    "max_tokens": request.get("max_tokens"),
                    "temperature": request.get("temperature"),
                    "top_p": request.get("top_p"),
                },
            },
            tokens=_usage_from_anthropic(getattr(response, "usage", None)),
            latency_ms=int((time.time() - started) * 1000),
            metadata={
                "sdk": "anthropic-python",
                "environment": environment or os.environ.get("ENVIRONMENT") or os.environ.get("NODE_ENV"),
                "label": label,
            },
            finding_id=finding_id,
            label=label,
        )
        return response

    client.messages.create = wrapped_create
    return client
