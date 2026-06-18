# Setup Guide

This guide wires `diagnostic_agent` to your Nanoclaw install so a sandboxed agent can scan your codebase for AI/LLM API usage.

## Prerequisites

- [Nanoclaw](https://github.com/nanocoai/nanoclaw) installed and running (`pnpm run dev` or systemd/launchctl service)
- Node.js 20+
- Docker (for Nanoclaw agent containers)
- Your target repo on disk

## Quick start

From the `diagnostic_agent` directory:

```bash
pnpm install
pnpm run setup -- --repo /path/to/your/repo
pnpm run scan
```

Or after building:

```bash
pnpm run build
npx diagnostic-agent setup --repo /path/to/your/repo
npx diagnostic-agent scan
```

### Optional: narrow scan scope

```bash
pnpm run scan -- --scope src/services,backend/llm
```

## What `setup` does

1. **Mount allowlist** — Adds the repo's parent directory to `~/.config/nanoclaw/mount-allowlist.json` (merged, not overwritten).
2. **Skill install** — Copies `skills/ai-spend-discovery/` into `$NANOCLAW_ROOT/container/skills/ai-spend-discovery/`.
3. **Agent group** — Creates or updates a `diagnostic-agent` group with:
   - Read-only mount: your repo → `/workspace/extra/<mount-name>`
   - Skills: `["ai-spend-discovery"]` only
   - CLI channel wiring for `pnpm run chat`

## Environment variables

| Variable | Purpose |
|---|---|
| `NANOCLAW_ROOT` | Path to Nanoclaw install. Auto-detected as sibling `../nanoclaw-main` if unset. |

## Output

The agent writes `ai-usage-findings.json` to its workspace (`groups/diagnostic-agent/` in Nanoclaw) and may send it via chat. Validate locally:

```bash
pnpm run validate-findings -- path/to/ai-usage-findings.json
```

Schema: `skills/ai-spend-discovery/schema/findings.schema.json`

## Manual Nanoclaw configuration

If you prefer not to use the CLI:

1. Add your repo parent to the mount allowlist (see Nanoclaw `manage-mounts` skill).
2. Copy `skills/ai-spend-discovery/` to `container/skills/ai-spend-discovery/`.
3. From Nanoclaw root, register the agent:

```bash
pnpm exec tsx ../diagnostic_agent/scripts/register-diagnostic-agent.ts \
  --repo /path/to/your/repo \
  --mount-name my-repo
```

4. Restart the group: `pnpm run ncl groups restart --id <group-id>`
5. Trigger scan: `pnpm run scan` (uses `ncl groups restart --message` on the diagnostic group)

## Recommended integration test repos

These public repos are good manual validation targets (not bundled):

| Repo | Why |
|---|---|
| [openai/openai-node](https://github.com/openai/openai-node) | Official OpenAI SDK examples |
| [anthropics/anthropic-sdk-typescript](https://github.com/anthropics/anthropic-sdk-typescript) | Anthropic SDK usage patterns |
| [langchain-ai/langchainjs](https://github.com/langchain-ai/langchainjs) | Multi-provider agent framework |

Run `setup --repo` against a checkout of any of these, then `scan`.

## Troubleshooting

| Issue | Fix |
|---|---|
| `Could not find Nanoclaw` | Set `NANOCLAW_ROOT` to your Nanoclaw clone |
| `CLI socket not reachable` | Start Nanoclaw service; confirm `data/cli.sock` exists |
| Mount blocked at spawn | Ensure repo path is under an allowlisted root |
| Scan goes to wrong agent | Diagnostic group must be wired to `cli/local`; re-run `setup` |
| Container slow first start | Cold start can take ~60s; wait for first reply |

## Security notes

- Mounts are **read-only** by default.
- `.env` and credential paths are blocked by Nanoclaw mount security.
- Discovery infers usage from **code**, not secrets files.
