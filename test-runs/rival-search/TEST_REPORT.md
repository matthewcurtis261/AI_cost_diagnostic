# rival-search live test

**Date:** 2026-06-18  
**Repo:** `C:\Users\MATTH\rival-search`  
**Mode:** Static Pass A+B (Nanoclaw agent scan blocked — Windows sandbox could not run shell/npm)

## Result

| Check | Status |
|---|---|
| OpenAI call site in `agent.py` | Found (f001) |
| Config model `gpt-4o-mini` | Found (f003) |
| Dependency `openai==1.58.1` | Found (f004) |
| Indirection via `main.py` → `generate_answer` | Found (f005) |
| Brave Search excluded from LLM findings | Correct |
| Frontend has no direct LLM calls | Confirmed |

## Findings file

`ai-usage-findings.json` in this directory — 5 findings, 1 provider (openai).

## Run the full Nanoclaw live test locally

```powershell
# Terminal 1 — start Nanoclaw (if not already running)
cd C:\Users\MATTH\nanoclaw-main
pnpm run dev

# Terminal 2 — setup + scan
cd C:\Users\MATTH\diagnostic_agent
pnpm install
pnpm run setup -- --repo C:\Users\MATTH\rival-search
pnpm run scan
```

Findings should appear in:
`C:\Users\MATTH\nanoclaw-main\groups\diagnostic-agent\ai-usage-findings.json`

Validate:
```powershell
pnpm run validate-findings path\to\ai-usage-findings.json
```

## Compare to this static baseline

The Nanoclaw agent should produce ≥3 high-confidence findings matching f001, f003, f004.
It may merge or split findings differently (e.g. combine import + call into one).
It should **not** report Brave Search as an LLM provider.
