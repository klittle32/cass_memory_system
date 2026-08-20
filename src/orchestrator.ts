import { Config, CurationResult, Playbook, PlaybookDelta, DecisionLogEntry, PlaybookBullet, ProcessedEntry } from "./types.js";
import { loadMergedPlaybook, loadPlaybook, savePlaybook, findBullet, mergePlaybooks } from "./playbook.js";
import { ProcessedLog, getProcessedLogPath } from "./tracking.js";
import { findUnprocessedSessions, cassExport } from "./cass.js";
import { generateDiary } from "./diary.js";
import { reflectOnSession } from "./reflect.js";
import { validateDelta } from "./validate.js";
import type { LLMIO } from "./llm.js";
import { curatePlaybook } from "./curate.js";
import { expandPath, log, warn, error, now, fileExists, resolveRepoDir, generateBulletId, hashContent, jaccardSimilarity, ensureDir, parseInlineFeedback } from "./utils.js";
import { withLock } from "./lock.js";
import { extractRuleIdsFromTranscript, classifySessionOutcome, recordOutcome, applyOutcomeFeedback, type OutcomeInput } from "./outcome.js";
import { calculateMaturityState } from "./scoring.js";
import type { FeedbackEvent } from "./types.js";
import path from "node:path";
import fsSync from "node:fs";

export interface ReflectionOptions {
  days?: number;
  maxSessions?: number;
  agent?: string;
  workspace?: string;
  session?: string; // Specific session path
  dryRun?: boolean;
  onProgress?: (event: ReflectionProgressEvent) => void;
  /** Optional LLMIO for testing - bypasses env-based stubs when provided */
  io?: LLMIO;
}

export interface ReflectionOutcome {
  sessionsProcessed: number;
  deltasGenerated: number;
  globalResult?: CurationResult;
  repoResult?: CurationResult;
  dryRunDeltas?: PlaybookDelta[];
  errors: string[];
  /** Auto-recorded rule outcomes from processed sessions */
  autoOutcome?: {
    outcomesRecorded: number;
    feedbackApplied: number;
    missingRules: string[];
    inlineFeedbackDeltas: number;
  };
}

export type ReflectionProgressEvent =
  | { phase: "discovery"; totalSessions: number }
  | { phase: "session_start"; index: number; totalSessions: number; sessionPath: string }
  | { phase: "session_skip"; index: number; totalSessions: number; sessionPath: string; reason: string }
  | { phase: "session_done"; index: number; totalSessions: number; sessionPath: string; deltasGenerated: number }
  | { phase: "session_error"; index: number; totalSessions: number; sessionPath: string; error: string };

function isActiveBullet(bullet: PlaybookBullet): boolean {
  return !bullet.deprecated && bullet.maturity !== "deprecated" && bullet.state !== "retired";
}

/**
 * Canonical workspace identity: expand `~`, resolve to an absolute path, then
 * best-effort realpath. Basename-only legacy values (no separator, no `~`) are
 * returned unchanged so they are compared as names, never resolved against cwd.
 */
function canonicalWorkspace(workspace: string | undefined): string | undefined {
  if (typeof workspace !== "string") return undefined;
  const trimmed = workspace.trim();
  if (trimmed === "") return undefined;
  if (!trimmed.startsWith("~") && !trimmed.includes("/") && !trimmed.includes("\\")) {
    return trimmed;
  }
  let resolved: string;
  try {
    resolved = path.resolve(expandPath(trimmed));
  } catch {
    return trimmed;
  }
  try {
    return fsSync.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function bulletScopeKey(bullet: PlaybookBullet): { scope: string; workspace?: string } {
  const scope = bullet.scope || "global";
  return {
    scope,
    workspace: scope === "workspace" ? canonicalWorkspace(bullet.workspace) : undefined,
  };
}

function sameScopeKey(a: { scope: string; workspace?: string }, b: { scope: string; workspace?: string }): boolean {
  return a.scope === b.scope && (a.workspace ?? "") === (b.workspace ?? "");
}

function feedbackEventKey(e: FeedbackEvent): string {
  return JSON.stringify([
    e.type,
    e.timestamp,
    e.sessionPath ?? null,
    e.reason ?? null,
    e.context ?? null,
    e.decayedValue ?? null,
  ]);
}

const MERGE_PLACEHOLDER_SESSIONS = new Set(["merged-operation", "merged"]);
const MERGE_PLACEHOLDER_AGENTS = new Set(["unknown"]);

/**
 * Carry deduplicated evidence and provenance from merge sources onto the
 * destination (a new successor or an existing compatible replacement), then
 * recompute maturity from the carried events. Counters are derived from the
 * event array, never summed from legacy source counters.
 */
function applyMergeCarryover(
  dest: PlaybookBullet,
  sources: PlaybookBullet[],
  config: Config,
  destIsNew: boolean
): void {
  const events: FeedbackEvent[] = [];
  const seen = new Set<string>();
  for (const e of [...(dest.feedbackEvents || []), ...sources.flatMap((s) => s.feedbackEvents || [])]) {
    const key = feedbackEventKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(e);
  }
  dest.feedbackEvents = events;
  dest.helpfulCount = events.filter((e) => e.type === "helpful").length;
  dest.harmfulCount = events.filter((e) => e.type === "harmful").length;

  const baseSessions = destIsNew
    ? (dest.sourceSessions || []).filter((s) => !MERGE_PLACEHOLDER_SESSIONS.has(s))
    : (dest.sourceSessions || []);
  const baseAgents = destIsNew
    ? (dest.sourceAgents || []).filter((a) => !MERGE_PLACEHOLDER_AGENTS.has(a))
    : (dest.sourceAgents || []);
  const sessions = [...new Set([...baseSessions, ...sources.flatMap((s) => s.sourceSessions || [])])];
  const agents = [...new Set([...baseAgents, ...sources.flatMap((s) => s.sourceAgents || [])])];
  if (sessions.length > 0) dest.sourceSessions = sessions;
  if (agents.length > 0) dest.sourceAgents = agents;

  const lastValidated = [dest.lastValidatedAt, ...sources.map((s) => s.lastValidatedAt)]
    .filter((v): v is string => typeof v === "string" && v !== "")
    .sort()
    .pop();
  if (lastValidated) dest.lastValidatedAt = lastValidated;

  const maturity = calculateMaturityState(dest, config);
  // A merge never auto-deprecates its own destination; the scoring ladder may
  // still demote it on a later feedback pass.
  if (maturity !== "deprecated") dest.maturity = maturity;
  dest.updatedAt = now();
}

function findFirstHashMatch(playbook: Playbook, content: string): PlaybookBullet | undefined {
  const h = hashContent(content);
  return playbook.bullets.find((b) => hashContent(b.content) === h);
}

function findBestActiveSimilarBullet(
  playbook: Playbook,
  content: string,
  threshold: number
): PlaybookBullet | undefined {
  let best: { bullet: PlaybookBullet; score: number } | undefined;
  for (const b of playbook.bullets) {
    if (!isActiveBullet(b)) continue;
    const score = jaccardSimilarity(content, b.content);
    if (score < threshold) continue;
    if (!best || score > best.score) best = { bullet: b, score };
  }
  return best?.bullet;
}

/**
 * Core logic for the reflection loop.
 * Handles session discovery, LLM reflection, delta validation, splitting, and persistence.
 * Implements fine-grained locking to maximize concurrency.
 */
export async function orchestrateReflection(
  config: Config,
  options: ReflectionOptions
): Promise<ReflectionOutcome> {
  const logPath = expandPath(getProcessedLogPath(options.workspace));
  const canonicalRunWorkspace =
    typeof options.workspace === "string" && options.workspace.trim() !== ""
      ? canonicalWorkspace(options.workspace)
      : undefined;
  const globalPath = expandPath(config.playbookPath);
  const repoDir = await resolveRepoDir();
  const repoPath = repoDir ? path.join(repoDir, "playbook.yaml") : null;
  const hasRepo = repoPath ? await fileExists(repoPath) : false;

  // 1. Lock the Workspace Log to serialize reflection for this specific workspace
  // Use a specific lock suffix to allow ProcessedLog internal locking to work independently
  const reflectionLockPath = `${logPath}.orchestrator`;

  // Ensure reflections directory exists before lock acquisition (fixes #14)
  // Without this, the lock can fail on fresh installs where ~/.cass-memory/reflections/ doesn't exist
  await ensureDir(path.dirname(reflectionLockPath));

  return withLock(reflectionLockPath, async () => {
    const processedLog = new ProcessedLog(logPath);
    await processedLog.load();

    // 2. Snapshot Phase: Load playbook context (without locking playbook yet)
    // We need the playbook to give context to the LLM. 
    // Stale data here is acceptable (LLM might suggest a rule that just got added, curation will dedupe).
    const snapshotPlaybook = await loadMergedPlaybook(config);

    // 3. Discovery Phase
    let sessions: string[] = [];
    const errors: string[] = [];

    if (options.session) {
      sessions = [options.session];
    } else {
      try {
        sessions = await findUnprocessedSessions(
          processedLog.getProcessedPaths(),
          {
            days: options.days || config.sessionLookbackDays,
            maxSessions: options.maxSessions || 5,
            agent: options.agent,
            // Must pass workspace: processed log is per-workspace, discovery must match.
            workspace: options.workspace,
            excludePatterns: config.sessionExcludePatterns,
            includeAll: config.sessionIncludeAll
          },
          config.cassPath
        );
      } catch (err: any) {
        errors.push(`Session discovery failed: ${err.message}`);
        return { sessionsProcessed: 0, deltasGenerated: 0, errors };
      }
    }

    const unprocessed = sessions.filter(s => !processedLog.has(s));
    if (unprocessed.length === 0) {
      return { sessionsProcessed: 0, deltasGenerated: 0, errors };
    }

    options.onProgress?.({ phase: "discovery", totalSessions: unprocessed.length });

    // 4. Reflection Phase (LLM) - Done WITHOUT holding playbook locks
    const allDeltas: PlaybookDelta[] = [];
    const pendingProcessedEntries: ProcessedEntry[] = [];
    const pendingOutcomes: OutcomeInput[] = [];
    let sessionsProcessed = 0;
    let inlineFeedbackDeltaCount = 0;

    for (let i = 0; i < unprocessed.length; i++) {
      const sessionPath = unprocessed[i]!;
      options.onProgress?.({
        phase: "session_start",
        index: i + 1,
        totalSessions: unprocessed.length,
        sessionPath,
      });

      try {
        const diary = await generateDiary(sessionPath, config);
        // Workspace identity for filing: only when the caller scoped this run.
        // Not resaved; the diary on disk keeps whatever generateDiary wrote.
        if (canonicalRunWorkspace) {
          diary.workspace = canonicalRunWorkspace;
        }

        // Quick check for empty sessions to save tokens
        const content = await cassExport(sessionPath, "text", config.cassPath, config) || "";
        if (content.length < 50) {
          options.onProgress?.({
            phase: "session_skip",
            index: i + 1,
            totalSessions: unprocessed.length,
            sessionPath,
            reason: "Session content too short",
          });

          // Mark as processed so we don't retry (defer via pendingProcessedEntries)
          pendingProcessedEntries.push({
            sessionPath,
            processedAt: now(),
            diaryId: diary.id,
            deltasGenerated: 0
          });
          continue;
        }

        const reflectResult = await reflectOnSession(diary, snapshotPlaybook, config, options.io);

        // Validation
        const validatedDeltas: PlaybookDelta[] = [];
        for (const delta of reflectResult.deltas) {
          const validation = await validateDelta(delta, config, undefined, options.io);
          if (validation.valid) {
            // Do NOT copy validation.result.refinedRule over the bullet: the
            // validator's suggestedRefinement is advice to the reflector, not
            // playbook text (fork issue #2). The accepted original stays as-is.
            validatedDeltas.push(delta);
          }
        }

        if (validatedDeltas.length > 0) {
          allDeltas.push(...validatedDeltas);
        }

        // 4b. Auto-outcome: extract rule IDs, inline feedback, and classify session
        if (content) {
          // Parse inline feedback comments (// [cass: helpful b-xyz] - reason)
          const inlineFeedback = parseInlineFeedback(content);
          if (inlineFeedback.length > 0) {
            for (const fb of inlineFeedback) {
              const delta: PlaybookDelta = fb.type === "harmful"
                ? { type: "harmful", bulletId: fb.bulletId, sourceSession: sessionPath, reason: "other", context: fb.reason }
                : { type: "helpful", bulletId: fb.bulletId, sourceSession: sessionPath, context: fb.reason };
              allDeltas.push(delta);
            }
            inlineFeedbackDeltaCount += inlineFeedback.length;
          }

          // Extract rule IDs and classify session outcome for auto-recording.
          // Exclude IDs that already have explicit inline feedback to avoid
          // double-counting (they get direct signal from the delta above).
          const inlineFeedbackIds = new Set(inlineFeedback.map(fb => fb.bulletId.toLowerCase()));
          const ruleIds = extractRuleIdsFromTranscript(content)
            .filter(id => !inlineFeedbackIds.has(id));
          if (ruleIds.length > 0) {
            const outcomeInput = classifySessionOutcome(content, diary, ruleIds);
            if (outcomeInput) {
              pendingOutcomes.push(outcomeInput);
            }
          }
        }

        // Defer marking as processed until merge succeeds to prevent data loss
        pendingProcessedEntries.push({
          sessionPath,
          processedAt: now(),
          diaryId: diary.id,
          deltasGenerated: validatedDeltas.length
        });
        sessionsProcessed++;

        options.onProgress?.({
          phase: "session_done",
          index: i + 1,
          totalSessions: unprocessed.length,
          sessionPath,
          deltasGenerated: validatedDeltas.length,
        });
        
      } catch (err: any) {
        const message = err?.message || String(err);
        errors.push(`Failed to process ${sessionPath}: ${message}`);
        options.onProgress?.({
          phase: "session_error",
          index: i + 1,
          totalSessions: unprocessed.length,
          sessionPath,
          error: message,
        });
      }
    }

    if (options.dryRun) {
      return {
        sessionsProcessed,
        deltasGenerated: allDeltas.length,
        dryRunDeltas: allDeltas,
        errors
      };
    }

    if (allDeltas.length === 0) {
      // Even if no deltas were generated, we should still mark sessions as processed
      // (e.g., empty sessions or sessions with no insights) to avoid infinite loops.
      if (pendingProcessedEntries.length > 0) {
        await processedLog.appendBatch(pendingProcessedEntries);
      }
      return { sessionsProcessed, deltasGenerated: 0, errors };
    }

    // 5. Merge Phase: Lock Playbooks, Reload, Curate, Save
    // We lock Global first, then Repo (if exists) to prevent deadlocks.
    let globalResult: CurationResult | undefined;
    let repoResult: CurationResult | undefined;

    const performMerge = async () => {
      // Reload fresh playbooks under lock
      const globalPlaybook = await loadPlaybook(globalPath);
      let repoPlaybook: Playbook | null = null;
      if (hasRepo) {
        repoPlaybook = await loadPlaybook(repoPath!);
      }
      
      // Create fresh merged context to ensure deduplication uses up-to-date data
      const freshMerged = mergePlaybooks(globalPlaybook, repoPlaybook);

      // Pre-process deltas to decompose 'merge' operations into atomic add/deprecate actions.
      // This allows us to route deprecations to their specific playbooks (Repo vs Global)
      // while adding the new merged rule to the default location (Global).
      //
      // Source deprecations are deferred: they are only applied after the
      // destination bullet is confirmed to exist in its locked target playbook,
      // and the destination receives the sources' deduplicated evidence and
      // provenance first. A skipped/failed destination never retires sources.
      const processedDeltas: PlaybookDelta[] = [];
      type MergeCarryover = {
        destId: string;
        destIsNew: boolean;
        sources: PlaybookBullet[];
        deprecations: PlaybookDelta[];
      };
      const carryovers: MergeCarryover[] = [];

      for (const delta of allDeltas) {
        if (delta.type !== "merge") {
          processedDeltas.push(delta);
          continue;
        }

        const mergedContent = delta.mergedContent;
        const threshold = typeof config.dedupSimilarityThreshold === "number" ? config.dedupSimilarityThreshold : 0.85;

        // Resolve every source before emitting anything.
        const sourceIds = [...new Set(delta.bulletIds)];
        const sources: PlaybookBullet[] = [];
        const missing: string[] = [];
        for (const id of sourceIds) {
          const b = findBullet(freshMerged, id);
          if (b) sources.push(b);
          else missing.push(id);
        }
        if (missing.length > 0 || sources.length === 0) {
          warn(`[orchestrator] Skipping merge delta: missing source bullet(s) ${missing.join(", ") || "(none)"}`);
          continue;
        }

        // Sources must agree on canonical scope/workspace; never pick the first.
        const scopeKey = bulletScopeKey(sources[0]!);
        const disagreeing = sources.filter((b) => !sameScopeKey(bulletScopeKey(b), scopeKey));
        if (disagreeing.length > 0) {
          warn(
            `[orchestrator] Skipping merge delta: sources disagree on scope/workspace (${sources
              .map((b) => `${b.id}=${b.scope || "global"}:${b.workspace ?? ""}`)
              .join(", ")})`
          );
          continue;
        }
        // Upgrade a shared legacy basename to the run's canonical workspace.
        let destWorkspace = scopeKey.workspace;
        if (
          destWorkspace &&
          canonicalRunWorkspace &&
          destWorkspace !== canonicalRunWorkspace &&
          destWorkspace === path.basename(canonicalRunWorkspace)
        ) {
          destWorkspace = canonicalRunWorkspace;
        }

        // If the merged content already exists (or is very similar), prefer deprecating into it
        // rather than creating a duplicate replacement that curation might skip.
        const exactMatch = findFirstHashMatch(freshMerged, mergedContent);
        if (exactMatch && !isActiveBullet(exactMatch)) {
          warn(
            `[orchestrator] Skipping merge delta: merged content matches deprecated/blocked bullet ${exactMatch.id}`
          );
          continue;
        }

        const replacement =
          exactMatch && isActiveBullet(exactMatch)
            ? exactMatch
            : findBestActiveSimilarBullet(freshMerged, mergedContent, threshold);

        if (replacement) {
          const replacementKey = bulletScopeKey(replacement);
          const compatible =
            sameScopeKey(replacementKey, scopeKey) ||
            (replacementKey.scope === "workspace" &&
              scopeKey.scope === "workspace" &&
              replacementKey.workspace === destWorkspace);
          if (!compatible) {
            warn(
              `[orchestrator] Skipping merge delta: existing replacement ${replacement.id} has incompatible scope/workspace`
            );
            continue;
          }
          const deprecations: PlaybookDelta[] = [];
          for (const id of sourceIds) {
            // If one of the merged bullets is already the best replacement, keep it active and only deprecate the others.
            if (id === replacement.id) continue;
            deprecations.push({
              type: "deprecate",
              bulletId: id,
              reason: `Merged into existing ${replacement.id}`,
              replacedBy: replacement.id
            });
          }
          carryovers.push({
            destId: replacement.id,
            destIsNew: false,
            sources: sources.filter((b) => b.id !== replacement.id),
            deprecations,
          });
          continue;
        }

        const newBulletId = generateBulletId();

        // 1. Create the new merged rule, filed under the sources' scope/workspace.
        processedDeltas.push({
          type: "add",
          bullet: {
            id: newBulletId, // Pre-assign ID so deprecate deltas can reference it
            content: mergedContent,
            category: "merged",
            tags: [...new Set(sources.flatMap((b) => b.tags || []))],
            scope: scopeKey.scope as PlaybookBullet["scope"],
            ...(destWorkspace ? { workspace: destWorkspace } : {})
          },
          // Merge deltas don't carry sourceSession, so we use a placeholder;
          // it is replaced by the sources' provenance once the bullet exists.
          sourceSession: "merged-operation",
          reason: delta.reason || "Merged from existing rules"
        });

        // 2. Deprecate the old rules — deferred until the successor is confirmed.
        carryovers.push({
          destId: newBulletId,
          destIsNew: true,
          sources,
          deprecations: sourceIds.map((id) => ({
            type: "deprecate" as const,
            bulletId: id,
            reason: `Merged into ${newBulletId}`,
            replacedBy: newBulletId
          })),
        });
      }

      // Partition deltas (Routing Logic)
      const routeDeltas = (deltas: PlaybookDelta[]): { globalDeltas: PlaybookDelta[]; repoDeltas: PlaybookDelta[] } => {
        const globalDeltas: PlaybookDelta[] = [];
        const repoDeltas: PlaybookDelta[] = [];
        for (const delta of deltas) {
          let routed = false;

          // Feedback/Replace/Delete: Must target existing ID
          if ('bulletId' in delta && delta.bulletId) {
            if (repoPlaybook && findBullet(repoPlaybook, delta.bulletId)) {
              repoDeltas.push(delta);
              routed = true;
            } else if (findBullet(globalPlaybook, delta.bulletId)) {
              globalDeltas.push(delta);
              routed = true;
            }
          }

          // New rules or orphans default to Global
          if (!routed) {
            globalDeltas.push(delta);
          }
        }
        return { globalDeltas, repoDeltas };
      };

      const combineResults = (a: CurationResult | undefined, b: CurationResult): CurationResult => {
        if (!a) return b;
        return {
          playbook: b.playbook,
          applied: a.applied + b.applied,
          skipped: a.skipped + b.skipped,
          conflicts: [...a.conflicts, ...b.conflicts],
          promotions: [...a.promotions, ...b.promotions],
          inversions: [...a.inversions, ...b.inversions],
          pruned: a.pruned + b.pruned,
          decisionLog: [...(a.decisionLog || []), ...(b.decisionLog || [])],
        };
      };

      // Apply Curation (pass 1: everything except deferred merge deprecations).
      // curatePlaybook mutates the target playbook in place.
      const pass1 = routeDeltas(processedDeltas);
      if (pass1.globalDeltas.length > 0) {
        globalResult = curatePlaybook(globalPlaybook, pass1.globalDeltas, config, freshMerged);
      }
      if (pass1.repoDeltas.length > 0 && repoPlaybook && repoPath) {
        repoResult = curatePlaybook(repoPlaybook, pass1.repoDeltas, config, freshMerged);
      }

      // Pass 2: confirm each merge destination exists in its locked target
      // playbook, carry evidence/provenance onto it, then retire the sources.
      const deferredDeprecations: PlaybookDelta[] = [];
      let globalCarried = false;
      let repoCarried = false;
      for (const co of carryovers) {
        const repoDest = repoPlaybook ? findBullet(repoPlaybook, co.destId) : undefined;
        const dest = repoDest ?? findBullet(globalPlaybook, co.destId);
        if (!dest || !isActiveBullet(dest)) {
          warn(
            `[orchestrator] Merge destination ${co.destId} was not persisted; keeping ${co.sources
              .map((b) => b.id)
              .join(", ")} active`
          );
          continue;
        }
        applyMergeCarryover(dest, co.sources, config, co.destIsNew);
        if (repoDest) repoCarried = true;
        else globalCarried = true;
        deferredDeprecations.push(...co.deprecations);
      }

      if (deferredDeprecations.length > 0) {
        const pass2 = routeDeltas(deferredDeprecations);
        if (pass2.globalDeltas.length > 0) {
          globalResult = combineResults(
            globalResult,
            curatePlaybook(globalPlaybook, pass2.globalDeltas, config, freshMerged)
          );
        }
        if (pass2.repoDeltas.length > 0 && repoPlaybook && repoPath) {
          repoResult = combineResults(
            repoResult,
            curatePlaybook(repoPlaybook, pass2.repoDeltas, config, freshMerged)
          );
        }
      }

      if (globalResult || globalCarried) {
        await savePlaybook(globalPlaybook, globalPath, { updateLastReflection: true });
      }

      if ((repoResult || repoCarried) && repoPath) {
        await savePlaybook(repoPlaybook!, repoPath, { updateLastReflection: true });
      }
    };

    // Execute Merge with Locking
    await withLock(globalPath, async () => {
      if (hasRepo && repoPath) {
        await withLock(repoPath, performMerge);
      } else {
        await performMerge();
      }
    });

    // Final log save - only mark processed AFTER rules are persisted
    if (pendingProcessedEntries.length > 0) {
      await processedLog.appendBatch(pendingProcessedEntries);
    }

    // 6. Auto-record rule outcomes (post-merge, best-effort)
    let autoOutcome: ReflectionOutcome["autoOutcome"] | undefined;
    if (pendingOutcomes.length > 0) {
      try {
        const records = [];
        for (const input of pendingOutcomes) {
          const record = await recordOutcome(input, config);
          records.push(record);
        }
        const feedbackResult = await applyOutcomeFeedback(records, config);
        autoOutcome = {
          outcomesRecorded: records.length,
          feedbackApplied: feedbackResult.applied,
          missingRules: feedbackResult.missing,
          inlineFeedbackDeltas: inlineFeedbackDeltaCount,
        };
        log(`Auto-recorded ${records.length} outcome(s): ${feedbackResult.applied} feedback event(s) applied`);
      } catch (err: any) {
        const msg = err?.message || String(err);
        errors.push(`Auto-outcome recording failed: ${msg}`);
        autoOutcome = {
          outcomesRecorded: 0,
          feedbackApplied: 0,
          missingRules: [],
          inlineFeedbackDeltas: inlineFeedbackDeltaCount,
        };
      }
    } else if (inlineFeedbackDeltaCount > 0) {
      autoOutcome = {
        outcomesRecorded: 0,
        feedbackApplied: 0,
        missingRules: [],
        inlineFeedbackDeltas: inlineFeedbackDeltaCount,
      };
    }

    return {
      sessionsProcessed,
      deltasGenerated: allDeltas.length,
      globalResult,
      repoResult,
      errors,
      autoOutcome,
    };
  });
}
