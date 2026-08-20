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

## 2026-08-19 — reflector sees the gold core

**Problem:** `cm reflect` stuffed every playbook bullet (including retired)
into `<existing_playbook>`, then middle-truncated to 20k chars. With ~22k
rules the reflector never saw proven/established ids, so it emitted `add`
instead of `helpful`/`replace`.

**Fix:**
- `src/reflect.ts` — `selectBulletsForReflectorPrompt()`: active proven +
  established always, plus top ~30 remaining by Jaccard vs the diary blob
  (accomplishments/decisions/challenges/keyLearnings). Retired/deprecated
  excluded via `getActiveBullets`. Similar drafts drop first if the
  formatted prompt would exceed 20k chars. `runReflector` truncation stays
  as a backstop.
- `src/llm.ts` — reflector RULES: prefer helpful on an existing id over add.
- `test/reflect-selector.test.ts` — proven-in-the-middle, no retired,
  similar-draft inclusion, char-budget trim.

**Install:**
```bash
cd ~/Code/cass_memory_system
cp -p ~/.local/bin/cm ~/.local/bin/cm.bak-0.2.13-pre-reflector-gold-$(date +%Y%m%d%H%M%S)
bun run build
cp -p dist/cass-memory ~/.local/bin/cm
```

## 2026-08-19 — diary vs playbook gate

**Problem:** Reflector `add` deltas for one-SKU / one-bead / one-session
recaps (e.g. Kraft Tool `store_sku 48040689`, `codex-zdml`) entered the
playbook as drafts. Diaries are the right layer for those recaps;
the playbook should only hold reusable next-agent rules.

**Fix:**
- `src/curate.ts` — `isSessionSpecificAdd()` fail-closed skip on `add`
  (`store_sku`, `codex-[a-z0-9]{3,}`, 8+ digit tokens, `SKU \d{5,}`).
  Does not insert and does not reinforce similar. Decision reason:
  `session-specific add rejected`. Generic "bead"/"enrichment" text still
  adds. Does **not** skip those sessions in the reflect picker — diaries
  still write.
- `src/llm.ts` — reflector RULES: do not `add` SKU/bead/session-outcome
  recaps; they belong in the diary; prefer `helpful` on an existing id.
- `test/curate.test.ts` — helper + curator skip/allow cases.

**Install:**
```bash
cd ~/Code/cass_memory_system
cp -p ~/.local/bin/cm ~/.local/bin/cm.bak-0.2.13-pre-diary-playbook-$(date +%Y%m%d%H%M%S)
bun run build
cp -p dist/cass-memory ~/.local/bin/cm
```

## 2026-08-20 — playbook hygiene (A1/A2/A3/A5/A6)

**Problem:** AE workspace rules were invisible to `cm context` (stored
`workspace: agentic-enrichment` never equalled the canonical cwd); reflector
adds filed under 20+ free-text workspace spellings; `cm reflect` merges
minted a zero-event global successor and retired voted sources; the
reflector core (368 proven/established, ~186k chars) blew the 20k prompt
block so relevant ids were never seen; Grok/Prime/Letta diaries were
`agent: unknown`; Codex `<recommended_plugins>` junk polluted history.

**Fix:**
- A1 `src/orchestrator.ts` — `diary.workspace` = canonical `--workspace`
  (expand `~`, resolve, best-effort realpath) only when supplied; not resaved.
  `src/reflect.ts` — adds with missing scope or `scope: workspace` are filed
  at the canonical path (LLM value overridden); explicit
  global/language/framework/task preserved. Same rule on the stub path.
  `src/commands/context.ts` — workspace bullets match by canonical equality
  OR legacy basename-only value == basename(effective workspace).
- A2 `src/orchestrator.ts` — merge decomposition resolves every source,
  rejects missing sources / scope-workspace disagreement / incompatible
  existing replacement; source deprecations are deferred until the
  destination is confirmed in its locked playbook; destination receives
  exact-deduplicated `feedbackEvents` (type,timestamp,sessionPath,reason,
  context,decayedValue), unioned `sourceSessions`/`sourceAgents` (placeholder
  `merged-operation`/`unknown` replaced), counts from the event array, and
  maturity via `calculateMaturityState`. No YAML/archive repair.
- A3 `src/reflect.ts` — `selectBulletsForReflectorPrompt`: active only;
  workspace-matching proven/established before global, ordered by maturity,
  helpfulCount desc, id; core capped ~16k formatted chars; diary-similar fill;
  hard ≤20k guarantee on `formatBulletsForPrompt(selected)`. Not every
  global proven rule is guaranteed a slot.
- A5 `src/diary.ts`, `src/utils.ts` — `.grok/sessions`,
  `.prime/agent/sessions`, `.letta/transcripts` (POSIX + Windows) → `grok`,
  `prime`, `letta`. `crossAgent.agents` untouched.
- A6 `src/commands/context.ts` — explicit `--workspace` forwards the canonical
  path to cass history; absent flag stays unscoped. Drops only hits with
  `xmodel-doc-peer-` in the source path or `<recommended_plugins>` in the
  snippet.

**Install:**
```bash
cd ~/Code/cass_memory_system
bun run build
cp -p dist/cass-memory ~/.local/bin/cm
```

## 2026-08-20 — cass agent slugs for Grok/Letta/Prime (#1)

**Problem:** Path detection landed as `grok` / `letta` / `prime`, but cass
emits `grok` / `letta_code` / `prime_agent`. Kyle's live
`crossAgent.agents` allowlist is the five-agent init default, so even a
correct diary slug would still be filtered from related-session
enrichment. Schema `[]` means unrestricted; a populated allowlist does not.

**Fix:**
- `src/utils.ts` `extractAgentFromPath` (and diary via that helper) emits
  cass slugs. POSIX + Windows prefixes unchanged.
- Fresh `cm init` / `cm privacy enable` fallback allowlist adds `grok`,
  `letta_code`, `prime_agent`. Existing `~/.cass-memory/config.json` is
  not rewritten; run `cm privacy allow grok` (and the other two) on
  already-inited homes.
- `letta`/`prime` normalize to `letta_code`/`prime_agent` so a short-lived
  wrong slug still compares.

**Install:**
```bash
cd ~/Code/cass_memory_system
bun run build
cp -p dist/cass-memory ~/.local/bin/cm
cm privacy allow grok
cm privacy allow letta_code
cm privacy allow prime_agent
```

**Operator note (2026-08-20):** one-time merge-gold archive repair run against
`~/.cass-memory/playbook.yaml` with a throwaway bun script (not in repo).
238 missing-successor groups: 109 archive successors restored with carried
evidence (2970 helpful / 3349 events, 96 workspace + 13 global); 65 voted
sources reactivated in 23 scope-disagreeing + 52 archive-missing groups;
58 zero-helpful successors left out; 224 zero-helpful sources left retired.
Backup: `playbook.yaml.bak-merge-repair-20260820T180205Z`. Archive untouched.
