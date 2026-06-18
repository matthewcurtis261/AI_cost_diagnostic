---
name: ai-spend-discovery
description: Scan a mounted codebase for AI/LLM API usage. Triggers on "scan", "ai spend", "find llm", "discover ai api", "ai-spend-discovery".
---

# AI Spend Discovery

Exhaustively find every AI/LLM API call site in the mounted target repo. Output structured JSON conforming to `schema/findings.schema.json`.

## Before you start

1. Locate the target repo under `/workspace/extra/`. If multiple mounts exist, use the one named in the user's message or the largest source tree.
2. Read `/app/skills/ai-spend-discovery/patterns/providers.json` for curated search patterns.
3. If the user passed a **scope** (subdirectories), limit all passes to those paths under the repo root. Otherwise scan the **whole repo**, excluding standard dirs from `exclude_dirs` in the patterns file.

## Multi-pass protocol

### Pass A — Broad static sweep

Use `Glob` to map repo layout, then run parallel `Grep` searches.

**A1. SDK / library imports** — For each provider in `patterns/providers.json`, grep `sdk_imports`.

**A2. HTTP endpoints** — Grep `http_endpoints` strings.

**A3. Environment variable references** — Grep `env_vars` in code (not `.env` files — they are not mounted).

**A4. Model identifier strings** — Grep `model_patterns` (regex).

**A5. Config / IaC** — Search `*.yaml`, `*.yml`, `*.tf`, `*.json`, `docker-compose*`, `.github/workflows/` for model declarations.

**A6. Dependency manifests** — Read `package.json`, `requirements.txt`, `pyproject.toml`, `go.mod`, `Gemfile`, `Cargo.toml` and flag packages from `dependency_packages`.

Exclude: `node_modules`, `.git`, `vendor`, `dist`, `build`, and other dirs listed in patterns.

### Pass B — Deep read

For each Pass A hit, `Read` surrounding context (±30 lines) and classify:

| Field | Values |
|---|---|
| `provider` | e.g. `openai`, `anthropic`, `aws-bedrock`, `unknown` |
| `call_type` | `chat_completion`, `embedding`, `image`, `speech`, `agent_framework`, `unknown` |
| `model` | literal string if static; else `dynamic`, `config_ref`, or `unknown` |
| `confidence` | `high` / `medium` / `low` |
| `wrapper` | internal abstraction name if call is indirect |

Trace one level of indirection when calls go through internal wrappers.

### Pass C — Subagent fan-out (large repos)

If the repo has **>500 source files** or **>100 Pass A hits**, spawn `Task` explore subagents — one per top-level package/service directory. See `docs/monorepo-strategy.md` for the full protocol.

Each subagent returns partial findings; the coordinator:

1. Concatenates and **dedupes** per `rules/dedup-rules.json` (same file + call_type → keep highest-scoring finding).
2. Keeps **dependency** findings (`agent_framework`) separate from billable call sites.
3. Renumbers ids `f001`, `f002`, … and **reconciles** `summary` from findings.

### Pass D — Gap fill

For generic HTTP clients or unmatched files that smell like LLM usage, search for co-occurring signals from `semantic_signals` in the same function/file. Still require line evidence.

### Pass E — Emit report

1. Write `/workspace/agent/ai-usage-findings.json` matching the schema.
2. Assign finding ids `f001`, `f002`, … (zero-padded, min 3 digits).
3. Populate `summary.providers`, `summary.models_detected`, `summary.likely_dynamic_models`, `summary.call_types`.
4. Add **`summary.coverage`** (structured) and **`summary.coverage_notes`** (human-readable):
   - `coverage.excluded` — every excluded path with `reason` and `category` (see schema).
   - `coverage.blind_spots` — runtime model selection, unmounted `.env`, external services, etc.
   - `coverage.scan_mode` — `full`, `scoped`, or `partial`.
5. Apply **confidence rubric** (`rules/confidence-rubric.json`) — see table below.
6. **Deduplicate** before emit — same call site = one finding.
7. Validate mentally against schema rules — every finding needs `evidence` quoting actual code.
8. Send the file to the user via `send_file` (or equivalent MCP tool).

## Confidence rubric

| Level | When to use |
|---|---|
| **high** | Direct API method in evidence (`.create(`, `messages.create`, etc.); static model or `config_ref` with config evidence |
| **medium** | Wrapper/delegate (`wrapper` set); import/client init only; `dynamic` model; indirect HTTP reference |
| **low** | Model-name grep only; env var reference only; ambiguous/generic fetch; `call_type: unknown` |

Dependency lines in `requirements.txt` / `package.json` may be **high** with `call_type: agent_framework` when evidence is the manifest line.

## Dedup rules

- Same `{file}::{call_type}` with overlapping lines → **one finding** (keep direct call over import/wrapper).
- Dependency manifest + runtime call in same file → **two findings** (different `call_type`).
- After subagent merge, renumber ids and reconcile summary counts.

## Output rules

- **Evidence required** — No finding without file:line and a verbatim snippet.
- **No hallucination** — If unsure, omit or mark `confidence: low` with a note.
- **Read-only** — Do not edit mounted repo files.
- **Deduplicate** — Same call site = one finding; dependency-only hits can be separate with `call_type: agent_framework`.

## Example finding

```json
{
  "id": "f001",
  "provider": "anthropic",
  "model": "claude-3-5-sonnet-20241022",
  "call_type": "chat_completion",
  "location": { "file": "src/agents/support.ts", "lines": [44, 67] },
  "confidence": "high",
  "evidence": "anthropic.messages.create({ model: 'claude-3-5-sonnet-20241022', ... })"
}
```

## Scan metadata

Set `scan_metadata.schema_version` to `"0.1.0"`, `scanned_at` to ISO-8601 now, `repo_path` to the container path (e.g. `/workspace/extra/my-repo`), and `repo_mount_name` to the mount folder name.
