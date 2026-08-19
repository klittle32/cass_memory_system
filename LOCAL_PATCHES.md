# Local patches (kyle)

## 2026-07-14 — omit `temperature` for Sonnet 5+

**Problem:** Anthropic API returns HTTP 400  
`temperature is deprecated for this model`  
when `cm reflect` uses `provider=anthropic` + `model=claude-sonnet-5`.  
Upstream `cm` 0.2.12 always passes `temperature: 0.3` / `0.35`.

**Fix:** `src/llm.ts` — `samplingOptionsForModel()` omits temperature for
Sonnet 5 / recent Opus / Fable IDs. Env force: `CM_LLM_NO_TEMPERATURE=1`.

**Install:**
```bash
cd ~/Code/cass_memory_system
bun run build
cp -p dist/cass-memory ~/.local/bin/cm
```

**Backup of pre-patch binary:** `~/.local/bin/cm.bak-0.2.12-pre-notemp-*`

## 2026-08-19 — workspace-scoped session discovery

**Problem:** `cm reflect --workspace` used the global cass timeline, so
unrelated sessions (e.g. `~/scripts`) drained into this workspace's
processed log while the real workspace backlog never moved. Deleted
index rows ("ghost" sessions) also kept getting selected.

**Fix:**
- `src/cass.ts` — `cassSessionsForWorkspace()` via `cass sessions --workspace`
- `src/orchestrator.ts` — pass `options.workspace` into discovery
- skip session paths that no longer exist on disk
- `test/cass.test.ts` — workspace discovery uses `sessions`, not timeline
