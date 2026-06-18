# Monorepo scan strategy

When the target repo is large or split into packages, use **Pass C — subagent fan-out** so each package is scanned in parallel and results are merged deterministically.

## When to fan out

Trigger subagents when **any** of these hold:

| Signal | Threshold |
|---|---|
| Source files | > 500 (excluding `exclude_dirs`) |
| Pass A grep hits | > 100 |
| Top-level packages | ≥ 3 sibling app/service directories |

Common monorepo layouts:

- `packages/*` (npm/pnpm/yarn workspaces)
- `apps/*` + `libs/*` (Nx, Turborepo)
- `services/*` (microservices)
- `frontend/` + `backend/` (polyglot split)

## Subagent assignment

Spawn one **explore** subagent per top-level package or service directory:

```
Task explore → packages/api
Task explore → packages/web
Task explore → services/worker
```

Each subagent prompt must include:

1. **Scope path** — only that directory under the mount.
2. **Output shape** — partial findings array (same schema fields as final report).
3. **Pass protocol** — run Pass A + B for scoped tree; skip Pass C (coordinator handles merge).
4. **Evidence rule** — file paths relative to repo root, not subagent scope root.

Example subagent instruction:

> Scan only `packages/api/` under the mounted repo. Run Pass A–B of ai-spend-discovery. Return JSON `{ "findings": [...] }` with paths relative to repo root. Do not spawn nested subagents.

## Coordinator merge (Pass C → E)

After subagents return:

1. **Concatenate** all partial `findings` arrays.
2. **Dedupe** using `rules/dedup-rules.json`:
   - Same `{file}::{call_type}` → keep highest-scoring finding.
   - Dependency-only (`agent_framework`) vs billable call → keep both.
3. **Renumber** ids sequentially (`f001`, `f002`, …).
4. **Reconcile summary** — recompute `providers`, `models_detected`, `likely_dynamic_models`, `call_types`.
5. **Build coverage** — union of excluded paths, note scoped subagent coverage in `summary.coverage_notes`.
6. **Validate** — run `pnpm run validate-findings` semantics mentally; fix duplicate call sites.

## Coverage for partial scans

When subagents cover disjoint trees, set:

```json
"summary": {
  "coverage": {
    "scan_mode": "full",
    "excluded": [...],
    "blind_spots": ["packages/legacy/ not scanned — excluded by user scope"],
    "passes_completed": ["A", "B", "C", "E"]
  }
}
```

If any top-level package was skipped (time budget, empty tree), add a `coverage_notes` entry explaining why.

## Failure handling

| Situation | Action |
|---|---|
| Subagent times out | Retry once with narrower scope; note gap in coverage |
| Duplicate ids across partials | Coordinator renumbers — ids from subagents are discarded |
| Conflicting provider for same file | Keep finding with higher confidence score; note conflict |
| Subagent returns invalid JSON | Coordinator re-runs Pass B on that scope directly |

## Post-scan normalization

On the host (outside the container):

```bash
pnpm run normalize-findings -- ai-usage-findings.json --output ai-usage-findings.cleaned.json
pnpm run validate-findings -- --strict ai-usage-findings.cleaned.json
```

This applies the same dedup and summary reconciliation the coordinator should perform in-agent.
