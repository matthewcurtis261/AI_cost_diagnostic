# Plan: Using Nanoclaw to Discover AI API Usage in a Codebase

This document describes how `diagnostic_agent` would use [Nanoclaw](https://github.com/nanocoai/nanoclaw) to find AI/LLM API call sites in a user-provided codebase — without billing dashboards or prior knowledge of which providers they use.

---

## What Nanoclaw Gives Us

After reading through `nanoclaw-main`, the relevant capabilities are:

| Capability | How it helps discovery |
|---|---|
| **Container isolation** | User code is mounted read-only into a sandbox; the agent searches it without touching the host. |
| **`additionalMounts`** | User repos bind-mount to `/workspace/extra/{name}` and become `additionalDirectories` for Claude Code. |
| **Claude Agent SDK tools** | `Grep`, `Glob`, `Read`, `Bash`, `Task` (subagents), `WebSearch` — a full static-analysis toolkit. |
| **Skills model** | We package the diagnostic workflow as a Nanoclaw skill (instructions + optional scripts), not core edits. |
| **Mount security** | Allowlist at `~/.config/nanoclaw/mount-allowlist.json`; blocks `.env`, credentials, SSH keys by default. |
| **Structured delivery** | Agent can write JSON reports to workspace and deliver via `send_file`. |

Nanoclaw is **not** a static analyzer. It is an orchestration layer that runs a capable coding agent inside a container with controlled filesystem access. Discovery quality depends on the agent following a systematic scan protocol — which we define via skill + output schema.

---

## End-to-End Flow

```
User clones diagnostic_agent + has Nanoclaw installed
        │
        ▼
User adds their repo path to mount allowlist (read-only)
        │
        ▼
User registers a "diagnostic" agent group with additionalMount → their repo
        │
        ▼
User triggers scan (CLI message or one-shot task)
        │
        ▼
Nanoclaw container agent runs discovery skill against /workspace/extra/<repo>
        │
        ▼
Agent emits structured findings JSON (+ optional human summary)
        │
        ├─► (Optional) Telemetry layer records live LLM inputs + token counts
        │
        ▼
(Future) Cost estimator consumes findings JSON ± telemetry events
```

---

## Phase 1 — Setup (one-time per user)

### 1. Mount the target codebase

Nanoclaw mounts extra directories via `container_configs.additional_mounts` (persisted in central DB, materialized at spawn):

```json
{
  "hostPath": "/path/to/user/repo",
  "containerPath": "target-repo",
  "readonly": true
}
```

Inside the container this appears at `/workspace/extra/target-repo` and is registered as an `additionalDirectory` for Claude Code ([`container/agent-runner/src/index.ts`](../nanoclaw-main/container/agent-runner/src/index.ts)).

**Requirements:**

- Host path must exist and sit under an entry in `~/.config/nanoclaw/mount-allowlist.json`.
- Read-only mount is strongly preferred — discovery should not mutate user code.
- `.env` and credential paths are blocked by mount security (intentional; we infer usage from code, not secrets).

### 2. Create a dedicated diagnostic agent group

A separate agent group (not the user's daily assistant) with:

- **`CLAUDE.md`** — identity: "You are an AI spend auditor. Your job is exhaustive, evidence-based discovery of LLM API usage."
- **`container.json` skills** — include the `ai-spend-discovery` skill from this repo.
- **No write access** to the mounted repo.

This keeps scan behavior deterministic and separate from conversational agent memory.

---

## Phase 2 — Discovery Protocol (what the agent actually does)

The skill instructs the agent to run a **multi-pass pipeline**. Each finding must cite evidence (file path, line range, matched pattern).

### Pass A — Broad static sweep (Grep + Glob)

Run parallel searches across `/workspace/extra/target-repo` for known signal categories:

**A1. SDK / library imports**

```
openai, anthropic, @anthropic-ai, google.generativeai, vertexai,
boto3.client("bedrock"), langchain, llama_index, litellm, together,
cohere, mistralai, replicate, huggingface, ollama, azure.ai,
@google-cloud/aiplatform, ai21, fireworks, groq, ...
```

Language-aware: `import`, `require`, `from X import`, `go get`, `use`, `gem`, etc.

**A2. HTTP endpoints**

```
api.openai.com, api.anthropic.com, generativelanguage.googleapis.com,
bedrock-runtime, api.cohere.ai, api.together.xyz, api.groq.com,
openrouter.ai, api.replicate.com, ...
```

**A3. Environment variable references**

```
OPENAI_API_KEY, ANTHROPIC_API_KEY, AZURE_OPENAI_*, GOOGLE_API_KEY,
AWS_BEDROCK_*, COHERE_API_KEY, LITELLM_*, ...
```

(Code references only — `.env` files won't be mounted.)

**A4. Model identifier strings**

Heuristic grep for model name patterns:

```
gpt-4, gpt-3.5, claude-3, claude-sonnet, gemini-, llama-, mistral-,
text-embedding-, dall-e, whisper-, o1-, o3-, ...
```

**A5. Config / IaC**

Search `*.yaml`, `*.yml`, `*.tf`, `*.json`, `docker-compose*`, `k8s/`, `.github/workflows/` for model declarations.

**A6. Dependency manifests**

Parse `package.json`, `requirements.txt`, `pyproject.toml`, `go.mod`, `Gemfile`, `Cargo.toml` for AI-related packages.

Use `Glob` first to understand repo layout (monorepo? polyglot?) then scope greps to relevant trees, excluding `node_modules`, `.git`, `vendor`, `dist`, `build`, etc.

### Pass B — Deep read of candidates

For every hit from Pass A, `Read` the surrounding context and classify:

| Field | Example |
|---|---|
| `provider` | `openai`, `anthropic`, `aws-bedrock`, `google-vertex`, `unknown` |
| `call_type` | `chat_completion`, `embedding`, `image`, `speech`, `agent_framework` |
| `model` | literal string if statically known, else `dynamic` / `config_ref` |
| `file` | path relative to repo root |
| `lines` | start–end |
| `confidence` | `high` / `medium` / `low` |
| `evidence` | the matching import, URL, or env var reference |
| `wrapper` | if call goes through an internal abstraction, note the wrapper name |

Follow indirection: if `services/llm.py` wraps OpenAI, trace callers upward one level to estimate blast radius.

### Pass C — Subagent fan-out (large repos)

For monorepos (> N files or > M grep hits), use Nanoclaw's `Task` tool to spawn explore subagents:

- One subagent per top-level package / service directory.
- Each returns a partial findings list.
- Coordinator agent merges and deduplicates.

This maps directly to Nanoclaw's existing `Task` allowlist in the Claude provider.

### Pass D — Gap fill (semantic search)

For files that smell like AI usage but didn't match patterns (e.g., generic `fetch("/v1/chat/completions")` via a variable URL):

- Agent reads shared HTTP client utilities.
- Agent searches for `messages`, `prompt`, `completion`, `temperature`, `max_tokens` co-occurring in the same function.

This is where the LLM adds value over pure regex — but it must still cite line evidence, not guess.

### Pass E — Emit structured report

Write `ai-usage-findings.json` conforming to a schema (to be defined in this repo). Example shape:

```json
{
  "scan_metadata": {
    "repo_path": "/workspace/extra/target-repo",
    "scanned_at": "2026-06-18T...",
    "files_scanned": 842,
    "agent_version": "..."
  },
  "findings": [
    {
      "id": "f001",
      "provider": "anthropic",
      "model": "claude-3-5-sonnet-20241022",
      "call_type": "chat_completion",
      "location": { "file": "src/agents/support.ts", "lines": [44, 67] },
      "confidence": "high",
      "evidence": "anthropic.messages.create({ model: 'claude-3-5-sonnet-20241022', ... })"
    }
  ],
  "summary": {
    "providers": ["anthropic", "openai"],
    "models_detected": ["claude-3-5-sonnet-20241022", "gpt-4o"],
    "likely_dynamic_models": 3,
    "coverage_notes": []
  }
}
```

Deliver via `send_file` to the user.

---

## What We Build in `diagnostic_agent` (not in Nanoclaw core)

Following Nanoclaw's "skills over features" philosophy:

| Artifact | Purpose |
|---|---|
| `skills/ai-spend-discovery/SKILL.md` | Agent instructions: the Pass A–E protocol |
| `skills/ai-spend-discovery/patterns/` | Curated grep patterns per provider (maintainable list) |
| `skills/ai-spend-discovery/schema/findings.schema.json` | Output validation |
| `skills/ai-spend-discovery/scripts/validate-findings.ts` | Post-scan schema check (optional, run in container) |
| `docs/setup.md` | How to wire mounts + agent group |
| `examples/sample-findings.json` | Reference output |

We do **not** fork Nanoclaw trunk. We ship a skill users install into their Nanoclaw fork, plus standalone docs for running a one-shot scan.

---

## Optional Telemetry Layer

Spend estimation works without telemetry (code + user assumptions). For accurate cost math and for **later project phases that need to understand what is actually being sent to models**, users can opt into a telemetry path.

### Design principles

| Principle | Detail |
|---|---|
| **Opt-in only** | Telemetry is off by default. No silent capture. |
| **Capture inputs, not outputs** | Store the full request input (messages, system prompt, tool definitions sent to the model). Store output **token count only** — never output text. |
| **Token counts always** | Every event records `input_tokens` and `output_tokens` (from provider response metadata when available; otherwise estimated). |
| **Link to discovery** | Each event references a `finding_id` or call-site fingerprint from the code scan so telemetry rolls up to known call sites. |
| **Local-first** | Events land in a user-owned store (JSONL/SQLite on disk). No required cloud upload. |
| **PII-aware** | Document what inputs may contain; offer optional redaction hooks before persistence (future). |

### What each telemetry event contains

```json
{
  "event_id": "evt_abc123",
  "timestamp": "2026-06-18T14:32:01.123Z",
  "finding_id": "f001",
  "provider": "anthropic",
  "model": "claude-3-5-sonnet-20241022",
  "call_type": "chat_completion",
  "input": {
    "messages": [
      { "role": "system", "content": "You are a support agent..." },
      { "role": "user", "content": "My order #48291 hasn't arrived" }
    ],
    "tools": null,
    "parameters": { "max_tokens": 1024, "temperature": 0.2 }
  },
  "tokens": {
    "input_tokens": 847,
    "output_tokens": 312,
    "total_tokens": 1159,
    "source": "provider"
  },
  "latency_ms": 2340,
  "metadata": {
    "environment": "staging",
    "trace_id": "req-xyz",
    "sdk": "anthropic-python@0.40.0"
  }
}
```

**Explicitly absent:** `output.content`, `output.text`, tool results from the model, or any completion body. Only `output_tokens` (and related usage fields) are kept.

For non-chat call types, `input` adapts by shape:

| `call_type` | `input` captures |
|---|---|
| `chat_completion` | `messages`, optional `tools`, generation params |
| `embedding` | `text` or `input` array sent to the embed endpoint |
| `image` | Prompt string + image reference metadata (not raw bytes by default) |
| `speech` | Transcript or text sent (if applicable) |

### Collection mechanisms (pick one or combine)

We ship multiple ingestion paths so users aren't forced to rewrite their app:

**1. Thin SDK wrapper (recommended for greenfield / easy refactors)**

A drop-in wrapper around common SDKs (`openai`, `anthropic`, `litellm`, etc.) that:

- Delegates to the real client unchanged.
- On each call: serializes the **request payload** (pre-send), awaits the response, extracts usage from response headers/body metadata, discards output body, writes one event.

The code scan (phase 1) identifies wrapper insertion points; a future skill can suggest minimal diffs ("wrap this client in `diagnostic_agent.instrument(...)`").

**2. Proxy / gateway tap**

For apps already routing through LiteLLM, a custom gateway, or an API proxy:

- Configure the proxy to emit our event schema on each upstream request.
- Proxy sees full request + usage metadata naturally; enforce "no output body in log" at the proxy layer.

Good when users can't or won't change application code.

**3. Log export ingestion (batch)**

For existing structured logs (LangSmith export, Helicone JSON, custom JSON logs):

- `diagnostic_agent ingest --format langsmith ./export/` normalizes third-party formats into our schema.
- Ingestion strips output content if present; keeps token counts and inputs where the source log includes them.

Good for historical analysis without runtime instrumentation.

**4. Nanoclaw-mounted telemetry directory (analysis only)**

Telemetry files written by (1) or (2) on the host can be mounted read-only into the diagnostic agent group at `/workspace/extra/telemetry/` so the Nanoclaw agent can correlate events with code findings during reporting. The agent analyzes telemetry; it does not collect it at runtime.

### Architecture

```
Application code
      │
      ├─► [Optional] SDK wrapper / proxy ──► telemetry-writer ──► ~/.diagnostic_agent/events.jsonl
      │
      └─► LLM provider API
                │
                └── usage metadata (input_tokens, output_tokens) returned; output body discarded by wrapper

Code scan findings JSON ──┐
                          ├──► spend estimator + later input-analysis features
Telemetry events JSONL ───┘
```

### Privacy and security

Inputs often contain PII, secrets, or customer data. The telemetry layer must:

- Default to **local disk only** with clear documentation.
- Never mount telemetry into Nanoclaw containers unless the user explicitly allows it (separate allowlist entry from source code).
- Support a **`--redact`** pipeline stage (future): regex/LLM-based scrubbing of emails, API keys, etc. before write — opt-in, documented tradeoffs.
- Document retention: user controls rotation (`max_events`, `max_age_days`).

Output omission is intentional: spend math only needs token counts; storing completions adds risk with little benefit for this project.

### Why input content matters later

Token counts alone answer "how much did we spend?" Input content answers:

- Which prompts are bloated vs. lean (optimization targets).
- Whether a cheaper model could handle a subset of traffic (task complexity classification).
- How RAG context contributes to cost (system vs. retrieved vs. user message breakdown).
- Per–call-site cost attribution when the same model serves different product features.

Phase 1 findings tell you **where**; telemetry tells you **what** and **how much**; later phases combine both for savings recommendations grounded in real usage patterns.

### Telemetry artifacts (this repo)

| Artifact | Purpose |
|---|---|
| `telemetry/schema/event.schema.json` | Validates event shape; enforces no output-content fields |
| `telemetry/wrappers/` | Thin instrumentation for Python + TypeScript SDKs (start with OpenAI + Anthropic) |
| `telemetry/writer/` | Append-only JSONL writer with rotation |
| `telemetry/ingest/` | Normalizers for common log export formats |
| `docs/telemetry-setup.md` | Opt-in install, privacy notes, mount for analysis |

---

## Is "Find Every Instance" Possible?

**Short answer:** Nanoclaw can get you *very high coverage with evidence*, but not a mathematical guarantee of 100% completeness. That is a limitation of static + agentic analysis in general, not a Nanoclaw blocker.

### What Nanoclaw handles well

- Polyglot repos (agent adapts grep/read strategy per language).
- SDK and direct HTTP usage.
- Config-driven model selection (reads config files, traces references).
- Internal wrappers (agent follows indirection with Read).
- Large repos (Task subagents).
- Safe execution (read-only mount, credential paths blocked).

### Known blind spots

| Blind spot | Mitigation |
|---|---|
| **Runtime-only model selection** (DB-stored model names) | Flag `dynamic` confidence; note "requires runtime/config access" in report. |
| **Obfuscated / encoded calls** | Low confidence; likely rare in normal app code. |
| **External microservices** (AI calls happen in another repo) | Out of scope unless that repo is also mounted. |
| **Serverless without source** (deployed zip only) | Out of scope — we only have source. |
| **Prompt-as-data in DB** | Detect API client; cannot infer volume without runtime. |
| **Agent misses a pattern** | Maintain pattern list in repo; version scans; allow re-run. |
| **Agent hallucinates a finding** | Require evidence field; validate file:line exists; schema lint. |
| **`.env` blocked** | Acceptable — we want call sites, not keys. Note env-var *references* in code. |

### Why Nanoclaw is a good fit (vs. rolling our own agent)

- Filesystem sandbox + mount allowlist already solved.
- Claude Code's Grep/Glob/Read/Bash are battle-tested for code exploration.
- Skills packaging matches our "open-source tool users install" goal.
- Users already trust Nanoclaw's security model for giving an agent code access.

### Alternatives considered

| Approach | Tradeoff |
|---|---|
| Pure regex/semgrep (no agent) | Faster, deterministic, but misses wrappers and novel providers. Good as **Pass A automation**, not the whole product. |
| Custom Docker + Claude SDK | Reimplements Nanoclaw's mount/orchestration/security. |
| IDE plugin | Requires IDE install; Nanoclaw is headless/CI-friendly. |

**Recommended hybrid:** Pass A patterns can be a deterministic script; Nanoclaw agent handles Pass B–E and produces the final report. Best of both worlds.

---

## Implementation Roadmap

### Milestone 1 — Proof of concept
- [x] Skill with manual trigger via Nanoclaw CLI channel.
- [x] Pattern list covering top 10 providers.
- [x] JSON findings schema v0.
- [x] Test against 2–3 open-source repos with known AI usage (fixture repos + documented OSS targets).

### Milestone 2 — Reliability
- [ ] Dedup + confidence scoring rules.
- [ ] Monorepo subagent strategy.
- [ ] `validate-findings` script.
- [ ] Coverage self-report (what was excluded and why).

### Milestone 3 — Productization
- [ ] One-command setup script (`diagnostic_agent setup --repo /path/to/code`).
- [ ] CI-friendly mode (non-interactive, exit codes on findings).
- [ ] Documentation for common false positives.

### Milestone 4 — Telemetry layer *(optional, user opt-in)*
- [x] `event.schema.json` — input payload + token counts; schema rejects output-content fields.
- [x] JSONL writer with local rotation (`~/.diagnostic_agent/events.jsonl`).
- [x] Python wrapper: `anthropic` + `openai` (capture request, usage metadata, discard response body).
- [x] TypeScript wrapper: same for `@anthropic-ai/sdk` + `openai`.
- [x] `finding_id` correlation: explicit id or call-site fingerprint from stack + label.
- [x] `docs/telemetry-setup.md` — privacy, opt-in, no cloud requirement.
- [ ] Ingest adapter for at least one log export format (e.g. JSONL with OpenAI-style `usage` blocks).

### Milestone 5 — Cost estimation
- [x] Map findings → pricing tables.
- [x] **Code-only mode:** token heuristics + user-supplied volume assumptions.
- [x] **Telemetry mode:** aggregate real `input_tokens` / `output_tokens` per finding, model, and time window.
- [x] Savings prediction: compare observed input profiles (from telemetry) against alternative model pricing.

### Milestone 6 — Input-aware analysis *(depends on telemetry)*
- [ ] Prompt size breakdown (system vs. user vs. tool context).
- [ ] Identify high-cost input patterns (long RAG chunks, redundant system prompts).
- [ ] Model-downgrade candidates based on input complexity heuristics.

---

## Open Questions

1. **Distribution model** — Nanoclaw skill only, or also a thin CLI wrapper that configures Nanoclaw programmatically?
2. **Scan scope default** — whole repo vs. user-specified subdirectories?
3. **Pattern maintenance** — community-contributed provider patterns (like Renovate rules)?
4. **Verification** — golden-file tests on public repos (e.g., LangChain, OpenAI SDK examples)?
5. **Telemetry redaction** — ship basic regex redaction in v1, or defer until a user asks?
6. **Wrapper vs. monkey-patch** — require explicit wrapper import, or offer zero-code `diagnostic_agent patch` for dev/staging only?

---

## Summary

Using Nanoclaw to find AI API usage is **feasible and well-aligned** with the project's constraints. The agent mounts the user's repo read-only, runs a structured multi-pass discovery protocol via Grep/Glob/Read/Task, and outputs evidence-backed JSON findings.

Spend estimation starts code-only; users who opt in add a **telemetry layer** that records actual LLM inputs and token counts (output tokens yes, output content no). That split keeps the default path simple and privacy-preserving while unlocking accurate cost math and later input-aware optimization.

Next step: Milestone 6 (input-aware analysis) using telemetry inputs, or Milestone 2 reliability polish.
