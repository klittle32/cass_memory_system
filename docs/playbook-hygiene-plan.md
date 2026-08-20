# Playbook hygiene plan (fork: klittle32/cass_memory_system)

Date: 2026-08-20. Single source of truth for this patch. Supersedes the earlier draft;
incorporates the ChatGPT 5.6 Pro review (verdict: implement with listed edits). The
implementation contract at the end overrides earlier wording on conflict.

Diagnosed against `cm` 0.2.13 built from this checkout. The installed binary
(`~/.local/bin/cm`, identical to `dist/cass-memory`, built 2026-08-19 16:22) contains all
four LOCAL_PATCHES.md patches. Note: the fourth patch (`isSessionSpecificAdd`,
`src/curate.ts:37`, reflector RULE in `src/llm.ts:617`) is **uncommitted** — installed
locally, not on origin/main. Reviewers reading GitHub will not see it.

Live data: `~/.cass-memory/playbook.yaml`, 2189 bullets, 1215 with
`workspace: agentic-enrichment`. Counts below are live-data measurements, not
source-derived facts.

Bar: smallest change that still applies after `git pull upstream`. Additive branches
inside existing functions; no new modules, schemas, exported types, or signature changes.

## Big picture

The memory loop is broken at **filing/retrieval** (I-5, I-8), **distillation** (I-3),
and **merge persistence** (I-2) — not at model quality or the state/maturity ladder.
A1 makes AE rules file and retrieve under one workspace identity; A3 puts relevant
existing ids in front of the reflector so it votes instead of paraphrasing; A2 stops a
later merge from erasing accumulated evidence. Those are the three restorative changes.
A6 is a narrow retrieval workaround; A5 is metadata quality; A4/A7/A8 are no-code.
Gold already lost through merge + GC needs a one-time archive repair that is
deliberately not part of this patch.

## Locked causes

**I-1 — `state: active` is not a signal.** `state` (draft/active/retired) and `maturity`
(candidate/established/proven/deprecated) are independent axes. `addBullet` always
writes `state: "draft"` (`src/playbook.ts:462`). Nothing promotes `state` on feedback:
`curatePlaybook` moves only `maturity` (`src/curate.ts:709-745`), `mark` only recomputes
`maturity` and sets `retired` on deprecation (`src/commands/mark.ts:84-92`), outcome apply
likewise (`src/outcome.ts:462`). `minFeedbackForActive` only feeds `calculateMaturityState`
(`src/scoring.ts:128-138`). The only writers of `state: "active"` are `createInvertedBullet`
(`src/curate.ts:240`) and `undo`. Live: 22 `active`, all `kind: anti_pattern`, 20 with
0 helpful; 95 `draft/proven`, 257 `draft/established`. Nothing important treats
`state: "active"` as the positive signal: `cm playbook list` and health use
`getActiveBullets` (`src/commands/playbook.ts:716-717`, `src/playbook.ts:502-507`);
several paths test `state === "retired"`; `cm stats byState` is a raw distribution
(`src/commands/stats.ts:45,196`). Maturity + `getActiveBullets` is the operational signal.

**I-2 — `merge` destroys the gold (corrected twice).** Not outcome-apply, and not the
`curate.ts` merge branch. `b-mri0esaf-leqwqq` (710 helpful) has
`deprecationReason: "Merged into b-mrnwyte9-rsyott"` (2026-07-16). 648 of 716 retired
bullets are merges; only 35 were auto-deprecated for harm. The live path is
`cm reflect` → `orchestrateReflection`, which decomposes every reflector `merge` delta
**before** curation (`src/orchestrator.ts:291-358`): either `deprecate` into an existing
similar active bullet, or emit an `add` with `category: "merged"`, empty tags,
`sourceSession: "merged-operation"`, no scope/workspace, no events — then `deprecate` each
source with `replacedBy`. The direct `case "merge"` in `src/curate.ts:618-646` has the
same hole but is bypassed by the command Kyle runs. The successor is a zero-event global
draft; the 2026-08-19 zero-vote GC deleted it (present in
`playbook-archived-zero-vote-20260819T194400Z.yaml`, absent from the playbook).
Scoring and maturity derive from `feedbackEvents`, not the legacy counters
(`src/scoring.ts:46-80`), so carry-over must move events, not just sums.
The 52 identical harmful events on those bullets are July blanket auto-grading of the
whole injected context. Upstream #56 (`HARM_OVERRIDE_MARGIN`, `AUTO_GRADE_BLAST_RADIUS`,
`src/outcome.ts:122-123,197-206`) does **not** abstain on plain `success + errors>=2`
(1.0 helpful vs 0.7 harmful → helpful); it abstains only when extra negatives push
harmful above helpful without clearing the 1.0 margin. Stale July events still distort
scores on survivors but did not cause these retirements; helpful counts are inflated by
the same old grading.

**I-3 — Reflector still mints paraphrases.** `selectBulletsForReflectorPrompt`
(`src/reflect.ts:49-81`) puts every active proven+established bullet into an unbounded
core and checks the 20k limit only while appending diary-similar bullets, so an
oversized core blocks the first similar addition. Live core = 368 bullets = 186,087
formatted chars vs `REFLECTOR_PROMPT_CHAR_BUDGET` 20,000. `runReflector` then
middle-truncates the **formatted existing-playbook block** to 20k (`src/llm.ts:1194`);
cass history gets its own 20k (`:1195`), and diary + instructions are separate — the 20k
is the playbook block, not the whole prompt. The model does not see relevant ids and
emits `add` (consistent with the pipeline; model behaviour itself is empirical).
Curation dedup is token Jaccard at 0.85 (`src/types.ts:437`, `src/curate.ts:379`);
paraphrases score far below. A near-duplicate of a retired bullet is skipped rather than
redirected via `replacedBy` (`src/curate.ts:384-401`).

**I-4 — History snippets are junk.** cass indexes Codex `<recommended_plugins>` system
text from `/var/folders/.../xmodel-doc-peer-*` worktrees (cass-side; confirm with the
same query ± `--workspace`). cm side: bullet filtering defaults to canonical cwd
(`resolveWorkspaceFilter`, `src/commands/context.ts:400`) but history search forwards only
`flags.workspace` (`:448-452`, `src/cass.ts:470`), so unflagged `cm context` pairs
workspace-scoped rules with unscoped history. Defaulting history to cwd would be a silent
policy change and the workspace arg is also forwarded to remote cass hosts — so A6 is
deliberately narrow.

**I-5 — Session-shaped recaps land in the playbook (residual).** `extractSessionMetadata`
returns only `agent`; `diary.workspace` is always undefined (`src/diary.ts:190-202`,
`:396,470`), so the reflector prompt says `Workspace: unknown` and `normalizeLLMDelta`
passes the LLM's free-text workspace through on adds (`src/reflect.ts:329`). Live:
Aug-20's 314 adds carry 20+ spellings (`CASS`, `cass`, `~/scripts`,
`/Users/kyle/scripts`, `coding_agent_session_search`…). `isSessionSpecificAdd`
(`src/curate.ts:37-46`, uncommitted) is four id regexes and cannot see "this session
compared models". A1 + A3 fix filing and make `helpful` reachable; they do **not**
classify or reject arbitrary session recaps. I-5 stays partially mitigated.

**I-6 — Grok/Prime/Letta diary `agent: unknown` (path detection only).** Both detectors,
`src/diary.ts:196-200` and `src/utils.ts:1813-1821`, are path substrings for
claude/cursor/codex/aider/pi_agent. cm never reads cass's agent field. Observed real
paths: `~/.grok/sessions/…`, `~/.prime/agent/sessions/…` (cass labels `prime_agent`),
`~/.letta/transcripts/…`. `crossAgent.agents` defaults to `[]` = **unrestricted**
(`src/types.ts:336-338`); adding names there would restrict, not expand — leave it alone.

**I-7 — Letta × project.** cm's workspace discovery is a pass-through to
`cass sessions --workspace` (`src/cass.ts:1113-1133`). Letta transcripts lacking a durable
project field is a Letta/cass premise (check `cass sessions --json` vs
`--workspace <AE> --json` Letta rows). Not a cm bottleneck.

**I-8 — AE workspace rules are invisible to `cm context`.** The filter keeps a
`scope: workspace` bullet only if `realpath(resolve(b.workspace)) === realpath(cwd)`
(`src/commands/context.ts:402-411`). Stored `workspace: "agentic-enrichment"` resolves to
`<cwd>/agentic-enrichment`, never equal. Live run in `/Users/kyle/Code/agentic-enrichment`:
45 relevantBullets, zero with `scope: workspace`; ~598 non-retired AE workspace rules
(33 proven, 121 established) excluded. The rules that did surface were global-scoped
survivors.

## Plan

**A1 — Canonical workspace writes; basename-only legacy reads.** In `src/orchestrator.ts`,
after `generateDiary` and before `reflectOnSession` (`:180`), set `diary.workspace` from
`options.workspace` using `expandPath`, `path.resolve`, and best-effort `realpathSync`;
do not resave or rewrite existing diary files. In `src/reflect.ts`, when `diary.workspace`
exists, an add with no scope becomes `scope: "workspace"` and receives the canonical
workspace, and an explicitly workspace-scoped add has its LLM workspace replaced by the
canonical one; preserve explicitly global/language/framework/task adds. In
`src/commands/context.ts`, accept canonical equality or a **basename-only legacy value**
equal to `path.basename(effectiveWorkspace)`. Store realpaths for all future rules; retain
short names only as a bounded compatibility read, with no YAML migration.

**A2 — Preserve merge evidence in the actual orchestrator path.** In `src/orchestrator.ts`,
where reflector merge deltas are decomposed (`:291-358`), resolve every source bullet from
the locked fresh merged playbook before emitting changes. Reject the merge if a source is
missing, if canonical scope/workspace values disagree, or if an existing replacement has
incompatible scope/workspace. Build an exact-deduplicated union of `feedbackEvents`, using
all event fields — type, timestamp, sessionPath, reason, context, decayedValue — as the
identity; union `sourceSessions` and `sourceAgents`; derive `helpfulCount` and
`harmfulCount` from the deduplicated events rather than summing legacy counters. After
confirming the destination exists in its locked target playbook and before source
deprecations are persisted, replace the `"merged-operation"` placeholder provenance with
those unions and recalculate maturity. Do not use first-source-wins, and do not patch only
the bypassed `curate.ts` merge branch. This prevents recurrence only; it performs no
archive or YAML repair.

**A3 — Workspace-first, budget-aware reflector selection.** In the existing
`selectBulletsForReflectorPrompt`, consider active bullets only. Rank workspace-matching
proven/established rules before global proven/established rules, with deterministic
maturity/helpful-count/id tie-breaking. Cap that core at approximately 16k **formatted**
characters, then fill the remaining space with diary-similar active bullets, never allowing
`formatBulletsForPrompt(selected)` to exceed 20k. Every global proven rule is no longer
guaranteed to appear; that is the necessary behaviour change. Keep the existing
`runReflector` backstop and adjust only the existing selector fixture if its old all-core
assumption fails. The 20k guarantee applies to the formatted playbook block, not the
literal complete LLM prompt.

**A4 — No code change.** Treat maturity plus `getActiveBullets` as the operational memory
signal and leave inversion state, `cm stats`, and existing YAML untouched. State/maturity
cleanup is unrelated to restoring the enrichment cheat sheet; `byState.active` is not the
cheat sheet.

**A5 — Agent path detection only.** Observed paths: `~/.grok/sessions/`,
`~/.prime/agent/sessions/`, `~/.letta/transcripts/`. Add only those, separator-bounded,
POSIX and Windows variants, beside the existing matches in both `src/diary.ts` and
`src/utils.ts` (`grok`, `prime`, `letta`). Do not change `CrossAgentConfigSchema`, its
empty `agents` default, or the user's config.

**A6 — Narrow history hygiene without implicit cwd scoping.** Preserve the current
unscoped history behaviour when `--workspace` is absent. When it is explicitly supplied,
pass the canonical `effectiveWorkspace` rather than the raw flag. After search, discard
only hits whose source path contains the confirmed `xmodel-doc-peer-` temporary-worktree
marker or whose snippet contains `<recommended_plugins>`; do not discard every
`/var/folders/` hit. Make no cass-side changes.

**A7 — Keep out of scope.** Letta project association stays outside cm after confirming
the premise against actual cass session rows.

**A8 — Residual, no code change.** A1 and A3 should reduce paraphrase adds and make
`helpful` votes reachable, but they do not classify or reject arbitrary session recaps.
Keep the installed SKU/bead skip unchanged, add no regex, and record I-5 as only partially
mitigated.

## Files to touch

- `src/orchestrator.ts` — set `diary.workspace` (A1); merge carry-over in the decomposition (A2)
- `src/reflect.ts` — stamp scope/workspace on adds (A1); core selection (A3)
- `src/commands/context.ts` — basename-tolerant workspace match (A1); canonical explicit workspace + junk filter (A6)
- `src/diary.ts`, `src/utils.ts` — agent path matches (A5)
- `test/reflect-selector.test.ts` — existing fixture/expectation only, if A3 breaks it
- `LOCAL_PATCHES.md` — exactly one new entry, after implementation

Rebase risk: `src/orchestrator.ts` and `src/reflect.ts` already carry local patches and
take the most new work here; keep every change inside existing functions.

## Not touched

`src/curate.ts` (including its bypassed merge branch and `isSessionSpecificAdd`),
`src/types.ts`, `src/llm.ts` / `runReflector`, `replace` delta (in-place edit,
`src/curate.ts:593`), promotion ladder / `state` semantics, `createInvertedBullet`,
`cm stats byState`, `minFeedbackForActive`, `crossAgent.agents` default,
`~/.cass-memory/config.json`, harmful-event YAML, build/install procedure
(`bun run build && cp -p dist/cass-memory ~/.local/bin/cm`).

## Out of scope

Letta project association; cass indexing/ranking of Codex system prompts; rewriting or
repairing existing feedback events, archives, or merge lineage (`b-mri0esaf-leqwqq` and
the deleted successor are not restored by this patch); embedding-based curator dedup;
playbook GC features (the zero-vote GC is not in this repo); state/maturity data
migration.

## Implementation contract

Overrides earlier wording in this file where they conflict. Small local fork patch, not a
refactor or process project.

```text
Implement the corrected playbook-hygiene patch in:

  ~/Code/cass_memory_system

ALLOWED FILES

You may edit only:

- src/orchestrator.ts
- src/reflect.ts
- src/commands/context.ts
- src/diary.ts
- src/utils.ts
- test/reflect-selector.test.ts, but only to adjust an existing fixture or
  expectation if A3 breaks it
- LOCAL_PATCHES.md, exactly one new entry after implementation

Do not edit src/curate.ts or src/types.ts for this patch.

DO

1. Preserve unrelated local changes. Inspect the current checkout before editing;
   do not reset, rebase, or overwrite the four installed local patches (the
   fourth, isSessionSpecificAdd in src/curate.ts, is uncommitted).

2. Implement A1:
   - After generateDiary() and before reflectOnSession(), set diary.workspace only
     when ReflectionOptions.workspace was supplied.
   - Canonicalize by expanding ~, resolving to an absolute path, and applying
     realpathSync best-effort.
   - Do not change a function signature and do not resave the diary.
   - In reflector add normalization, when diary.workspace exists:
       * missing scope -> scope "workspace" plus canonical workspace;
       * scope "workspace" -> canonical workspace, overriding the LLM value;
       * explicit global/language/framework/task scope -> preserve it.
   - Apply equivalent normalization to the existing reflector-stub path if
     needed to keep current tests representative.
   - In cm context, match workspace bullets by canonical equality OR when the
     stored value is a basename-only legacy name equal to the effective
     workspace basename.
   - Continue writing canonical paths; do not write new short workspace names.

3. Implement A2 in src/orchestrator.ts, where cm reflect actually decomposes merge
   deltas:
   - Resolve all source bullets before emitting an add or deprecations.
   - Reject a merge if any source is missing.
   - Canonicalize and compare source scope/workspace values.
   - Reject disagreement; do not choose the first source.
   - When merging into an existing replacement, require compatible
     scope/workspace before deprecating anything.
   - Exact-deduplicate feedbackEvents by the tuple:
       type, timestamp, sessionPath, reason, context, decayedValue
   - Union sourceSessions and sourceAgents.
   - Replace, rather than append to, the new bullet's "merged-operation"/unknown
     placeholder provenance.
   - Set helpfulCount and harmfulCount from the deduplicated event array; do not
     sum the source counters.
   - Recalculate destination maturity from the carried events with the existing
     scoring function.
   - Confirm the destination bullet exists in its locked target playbook before
     any source deprecations are persisted. A failed/skipped destination must
     not retire the sources.
   - Apply carry-over both to a newly created successor and to an existing
     compatible replacement.
   - Do not repair historical YAML or archive data.

4. Implement A3 only inside the existing reflector selector:
   - Active bullets only.
   - Workspace-matching proven/established rules before global
     proven/established rules.
   - Deterministic ordering; use maturity, helpfulCount, and id as tie-breakers.
   - Limit the formatted core to about 16,000 characters.
   - Fill the remaining budget with diary-similar active bullets.
   - Never return a selection whose formatBulletsForPrompt() output exceeds
     20,000 characters.
   - Do not guarantee inclusion of every global proven rule.
   - Do not change runReflector or src/llm.ts.
   - The budget assertion is for the formatted existing-playbook block, not the
     complete prompt including diary, cass history, and instructions.

5. Implement A5:
   - Observed local/cass source paths: ~/.grok/sessions/, ~/.prime/agent/sessions/,
     ~/.letta/transcripts/. Re-check before coding.
   - Add only the observed separator-bounded patterns in both agent detectors.
   - Support the corresponding POSIX and Windows separators.
   - Do not change crossAgent.agents defaults, config, or schemas.

6. Implement the narrowed A6:
   - When --workspace is explicitly supplied to cm context, pass the canonical
     effective workspace to cass history.
   - When it is absent, preserve current unscoped history behavior; do not
     silently default cass history to cwd.
   - Filter only hits containing the confirmed xmodel-doc-peer- source-path
     marker or <recommended_plugins> in the snippet.
   - Do not broadly remove every /var/folders/ hit.

7. Leave A4, A7, and A8 as no-code:
   - no state/maturity cleanup;
   - no Letta project association;
   - no new session-specific-add regex.

8. Use existing tests only. Do not create a new test file or broaden the test
   suite. Adjust test/reflect-selector.test.ts only if its existing fixture or
   expectation is incompatible with the corrected A3 behavior.

9. After edits:
   - run the existing relevant test command if needed;
   - run:

       bun run build &&
       cp -p dist/cass-memory ~/.local/bin/cm

   - add one concise LOCAL_PATCHES.md entry describing A1/A2/A3/A5/A6 and the
     install command.

DONE MEANS

- From /Users/kyle/Code/agentic-enrichment, cm context can retrieve relevant
  scope:workspace AE rules stored with either the canonical path or legacy
  basename "agentic-enrichment".
- A reflector merge cannot persist a zero-event/zero-vote successor while
  retiring voted sources; a compatible existing replacement receives the same
  deduplicated evidence and provenance.
- The reflector's formatted existing-playbook block is workspace-aware and at
  most 20,000 characters.
- Actual Grok, Prime, and Letta session paths resolve to grok, prime, and letta
  in both detectors.
- Existing explicit-global behavior remains explicit, and unflagged cass
  history remains unscoped.
- The patch is not a refactor of state versus maturity.

DO NOT

- Do not touch files outside the allowed list.
- Do not add modules, CLI verbs, schemas, schema versions, exported types, or
  function-signature changes.
- Do not create test files.
- Do not create beads, issues, PRs, ADRs, extra documentation, handoff files,
  verification packets, or commit-hash reports.
- Do not rewrite playbook YAML.
- Do not perform GC or historical merge repair.
- Do not add an embedding curator.
- Do not do Letta work.
- Do not do cass indexer or cass ranking work.
- Do not edit ~/.cass-memory/config.json.
- Do not expand SKU/bead handling.
```
