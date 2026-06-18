"""Opt-in LLM telemetry: request inputs + token counts, never output content."""

from diagnostic_agent_telemetry.writer import EventWriter, default_events_path, get_default_writer
from diagnostic_agent_telemetry.fingerprint import new_event_id, resolve_correlation_id
from diagnostic_agent_telemetry.openai_wrapper import instrument_openai
from diagnostic_agent_telemetry.anthropic_wrapper import instrument_anthropic

__all__ = [
    "EventWriter",
    "default_events_path",
    "get_default_writer",
    "new_event_id",
    "resolve_correlation_id",
    "instrument_openai",
    "instrument_anthropic",
]
