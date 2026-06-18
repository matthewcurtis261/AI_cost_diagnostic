# Common false positives

Static (Pass A) scans and even agent scans can flag code that is **not** billable LLM usage. Use this guide to interpret findings and tune CI policy.

## Import or client init only

**Signal:** `from openai import OpenAI`, `import anthropic`, `new OpenAI(...)`

**Why it appears:** Pass A greps SDK imports.

**Billable?** Usually **no** — unless the same finding evidence includes `.create(` or `messages.create`.

**Action:** Agent Pass B should split init vs call site. In static mode, expect low confidence. Use `check --min-confidence medium` or normalize + dedup.

## Dependency manifest lines

**Signal:** `openai==1.58.1` in `requirements.txt`, `"openai": "^4.0.0"` in `package.json`

**Why:** Listed in `dependency_packages` patterns.

**Billable?** **No** — `call_type: agent_framework`. Declares the SDK is installed, not that it is invoked.

**Action:** Keep for inventory; exclude from spend via estimate engine (already filtered).

## Model name strings in non-LLM context

**Signal:** `gpt-4`, `claude-3`, `gemini-pro` in comments, docs, test fixtures, or UI copy

**Why:** Pass A model regex matches string literals.

**Billable?** **No** unless co-located with an API client call.

**Action:** Mark `confidence: low`; omit in agent Pass B when evidence is clearly documentation.

## Environment variable references

**Signal:** `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` in code

**Why:** Pass A greps env var names (not `.env` files — those are mount-blocked).

**Billable?** **No** by itself — indicates configuration, not a call.

**Action:** Useful for provider attribution; link to actual call sites via `env_refs`.

## LangChain / LlamaIndex / LiteLLM imports

**Signal:** `from langchain`, `import litellm`, `llama_index`

**Why:** Framework packages in dependency list.

**Billable?** **Indirect** — real spend happens inside framework calls. Agent should trace to underlying provider calls where possible.

**Action:** `call_type: agent_framework`; note wrapper name. Estimate may need telemetry for accurate volume.

## Wrapper / HTTP handler delegation

**Signal:** `generate_answer(...)` in FastAPI route without OpenAI in evidence snippet

**Why:** Pass B traces one level of indirection.

**Billable?** **Yes**, indirectly — the handler delegates to an LLM-backed function.

**Action:** Set `wrapper` field; prefer finding on the module that calls `.create(`.

## Brave Search / non-LLM APIs

**Signal:** `api.search.brave.com`, generic `fetch(url)` with non-LLM endpoints

**Why:** Generic HTTP patterns or user-noted exclusions.

**Billable?** **No** for LLM spend tracking.

**Action:** Document in `coverage_notes` (see rival-search example).

## Config defaults without runtime proof

**Signal:** `openai_model: str = "gpt-4o-mini"` in settings class

**Why:** Model string in config file.

**Billable?** **Maybe** — declares default model but not call volume.

**Action:** `model: gpt-4o-mini` or `config_ref`; note in coverage that runtime may override via env.

## Test mocks and fixtures

**Signal:** `jest.mock('openai')`, `@patch('openai.ChatCompletion')`, VCR cassettes

**Why:** Test code imports or strings match patterns.

**Billable?** **No** for production spend.

**Action:** Exclude test dirs in `--scope` for CI, or accept low-confidence hits in test trees.

## Static vs agent scan

| Mode | False positive rate | Best for |
|---|---|---|
| `--static` | Higher | CI gates, quick inventory, no Docker |
| Agent scan | Lower | Accurate call sites, wrappers, config tracing |

**Recommendation:** Use static scan in CI for speed; run full agent scan locally or nightly for authoritative inventory.

## Tuning CI policy

| Goal | Suggested flags |
|---|---|
| Report only, never fail | `check --findings f.json` |
| Fail on any likely API usage | `check --fail-on-findings` |
| Ignore weak static hits | `check --min-confidence medium` |
| Catch schema/summary issues | add `--strict` |

See [reliability.md](reliability.md) for dedup/normalize and [ci-setup.md](ci-setup.md) for workflow examples.
