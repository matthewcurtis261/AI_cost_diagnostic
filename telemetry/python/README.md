# diagnostic-agent-telemetry (Python)

Opt-in LLM telemetry for [diagnostic_agent](https://github.com/diagnostic-agent/diagnostic_agent).

Captures **request inputs** and **token counts**. Never stores model output text.

```python
from openai import OpenAI
from diagnostic_agent_telemetry import instrument_openai

client = OpenAI()
instrument_openai(client, finding_id="f001")  # from ai-usage-findings.json

response = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Hello"}],
)
```

Events append to `~/.diagnostic_agent/events.jsonl` by default.

See the main repo `docs/telemetry-setup.md` for full setup and privacy notes.
