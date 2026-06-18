# Telemetry setup (Observe phase)

The telemetry layer is **opt-in**. It records what your app sends to LLM APIs (messages, prompts, parameters) plus **token counts** from provider usage metadata. It never stores model **output text**.

Use this after running a code scan (`ai-usage-findings.json`) so you can link live traffic to discovered call sites via `finding_id`.

---

## What gets captured

| Captured | Not captured |
|---|---|
| Request messages / prompts | Completion / response text |
| Tools and generation params | Tool results from the model |
| `input_tokens`, `output_tokens` | Raw API response bodies |
| Latency, model id, provider | Secrets from `.env` (not read) |

Events append to a local JSONL file (default: `~/.diagnostic_agent/events.jsonl`).

---

## Quick start — Python (OpenAI)

After scanning your repo, note the finding id for the call site (e.g. `f001` for `backend/app/agent.py`).

```bash
pip install -e ./telemetry/python
```

```python
from openai import OpenAI
from diagnostic_agent_telemetry import instrument_openai

client = OpenAI()
instrument_openai(client, finding_id="f001")

# Existing code unchanged below
response = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Hello"}],
)
```

Run your app normally. Each LLM call appends one event.

Validate events:

```bash
pnpm run validate-events -- ~/.diagnostic_agent/events.jsonl
```

---

## Quick start — TypeScript (OpenAI)

```typescript
import OpenAI from 'openai';
import { instrumentOpenAI } from 'diagnostic-agent/telemetry';

const client = instrumentOpenAI(new OpenAI(), { findingId: 'f001' });

const response = await client.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Hello' }],
});
```

Build the package first (`pnpm run build`) or use `tsx` during development.

---

## Anthropic

**Python**

```python
from anthropic import Anthropic
from diagnostic_agent_telemetry import instrument_anthropic

client = instrument_anthropic(Anthropic(), finding_id="f002")
client.messages.create(
    model="claude-3-5-sonnet-20241022",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}],
)
```

**TypeScript**

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { instrumentAnthropic } from 'diagnostic-agent/telemetry';

const client = instrumentAnthropic(new Anthropic(), { findingId: 'f002' });
```

---

## Linking events to code findings

| Method | When to use |
|---|---|
| `finding_id="f001"` | Best — copy id from `ai-usage-findings.json` after a scan |
| `label="generate_answer"` | Human-readable tag; combined with stack frame for fingerprint |
| *(auto)* | If neither is set, a `call_site_fingerprint` (`cs_…`) is derived from the call stack |

Example for **rival-search** after scan:

```python
instrument_openai(client, finding_id="f001")  # backend/app/agent.py chat.completions.create
```

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DIAGNOSTIC_AGENT_TELEMETRY` | `1` | Set to `0` to disable writes (wrapper still returns API responses) |
| `DIAGNOSTIC_AGENT_EVENTS_PATH` | `~/.diagnostic_agent/events.jsonl` | Override event file location |

---

## Privacy and security

- **Local-first** — events stay on disk unless you copy them elsewhere.
- **Inputs may contain PII** — prompts often include user data. Do not enable telemetry in production without reviewing retention policy.
- **No output content** — wrappers discard completion bodies before persistence; the schema validator rejects forbidden output fields.
- **Separate from Nanoclaw mounts** — telemetry files are not mounted into scan containers unless you explicitly allowlist them.
- **Rotation** — files rotate when they exceed 50 MB or 100k events (timestamped backup alongside the original path).

Redaction hooks (regex scrubbing of emails, API keys) are planned for a future release.

---

## Event schema

Schema: `telemetry/schema/event.schema.json`

Example line (pretty-printed):

```json
{
  "event_id": "evt_abc123",
  "timestamp": "2026-06-18T14:32:01.123Z",
  "schema_version": "0.1.0",
  "finding_id": "f001",
  "provider": "openai",
  "model": "gpt-4o-mini",
  "call_type": "chat_completion",
  "input": {
    "messages": [
      { "role": "system", "content": "You are a research assistant." },
      { "role": "user", "content": "What is rival-search?" }
    ],
    "parameters": { "temperature": 0.3 }
  },
  "tokens": {
    "input_tokens": 847,
    "output_tokens": 312,
    "total_tokens": 1159,
    "source": "provider"
  },
  "latency_ms": 2340,
  "metadata": { "sdk": "openai-python", "label": "generate_answer" }
}
```

See also: `examples/sample-events.jsonl`

---

## Correlating telemetry with scans (Nanoclaw)

To let the diagnostic agent analyze telemetry alongside code findings:

1. Add the telemetry directory parent to your Nanoclaw mount allowlist.
2. Add a read-only mount, e.g. host `~/.diagnostic_agent` → container `/workspace/extra/telemetry`.
3. Ask the agent to correlate `finding_id` entries with event volume.

The agent **analyzes** telemetry files; it does not collect them at runtime.

---

## Troubleshooting

| Issue | Fix |
|---|---|
| No events written | Check `DIAGNOSTIC_AGENT_TELEMETRY` is not `0`; confirm wrapper is applied before API calls |
| Validation fails on `content` | Allowed inside `input.messages` only — not at top level |
| Wrong finding rollup | Pass explicit `finding_id` from your scan output |
| Permission error on Windows | Ensure `%USERPROFILE%\.diagnostic_agent` is writable |

---

## Next: cost estimation

Once you have findings + telemetry, Milestone 5 will aggregate token usage per finding/model and compare against pricing tables for savings predictions.
