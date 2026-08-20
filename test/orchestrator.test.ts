/**
 * Unit tests for `src/orchestrator.ts`.
 *
 * These tests run in-process (for Bun coverage) and avoid network/LLM calls by:
 * - Setting `CASS_MEMORY_LLM=none` (fast diary generation, no LLM)
 * - Using LLMIO injection to inject deterministic deltas (no env vars needed)
 * - Setting `config.validationEnabled=false` to bypass validator/evidence calls
 * - Pointing `config.cassPath` at a non-existent binary so `cassExport` uses fallback parsing
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import yaml from "yaml";

import { orchestrateReflection } from "../src/orchestrator.js";
import { getProcessedLogPath, ProcessedLog } from "../src/tracking.js";
import { expandPath, now } from "../src/utils.js";
import { cleanupEnvironment, createIsolatedEnvironment, TestEnv } from "./helpers/temp.js";
import { createTestConfig, createTestPlaybook, createBullet } from "./helpers/factories.js";
import { withLlmShim, type LlmShimConfig } from "./helpers/llm-shim.js";

async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T> | T
): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withIsolatedHome<T>(fn: (env: TestEnv) => Promise<T>): Promise<T> {
  const env = await createIsolatedEnvironment("orchestrator-test");
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalCwd = process.cwd();

  try {
    process.env.HOME = env.home;
    process.env.USERPROFILE = env.home;
    process.chdir(env.home); // ensure resolveRepoDir() returns null (avoid touching repo .cass/)
    return await fn(env);
  } finally {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    process.chdir(originalCwd);
    await cleanupEnvironment(env);
  }
}

function writeJsonlSession(sessionPath: string, lines: Array<{ role: string; content: string }>): void {
  mkdirSync(path.dirname(sessionPath), { recursive: true });
  const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  writeFileSync(sessionPath, body, "utf-8");
}

function readPlaybook(playbookPath: string): any {
  return yaml.parse(readFileSync(playbookPath, "utf-8"));
}

describe("orchestrateReflection (unit)", () => {
  test("processes a single session and persists add delta to global playbook", async () => {
    await withIsolatedHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");

      const sessionPath = path.join(env.home, "sessions", "s1.jsonl");
      writeJsonlSession(sessionPath, [
        { role: "user", content: "I need help writing reliable unit tests for my CLI tool." },
        { role: "assistant", content: "Sure. Let's start by identifying seams and adding deterministic fixtures." },
      ]);

      const config = createTestConfig({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir,
        cassPath: "/__missing__/cass",
        validationEnabled: false,
      });

      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
        await withLlmShim({
          reflector: {
            deltas: [{
              type: "add",
              bullet: { content: "Always add an in-process unit test before refactors.", category: "testing", tags: [] },
              reason: "Ensures coverage and prevents regressions",
              sourceSession: "stub",
            }]
          }
        }, async (io) => {
          const outcome = await orchestrateReflection(config, { session: sessionPath, io });

          expect(outcome.errors).toEqual([]);
          expect(outcome.sessionsProcessed).toBe(1);
          expect(outcome.deltasGenerated).toBe(1);

          const saved = readPlaybook(env.playbookPath);
          const contents = (saved?.bullets || []).map((b: any) => b.content);
          expect(contents).toContain("Always add an in-process unit test before refactors.");
        });
      });
    });
  });

  test("validator suggestedRefinement is not written over an accepted add's content", async () => {
    // Fork issue #2: validateDelta maps the LLM validator's suggestedRefinement
    // to refinedRule, and the orchestrator used to copy that advisory prose
    // ("Scope the rule to...") over the bullet content. The accepted original
    // must be what lands in the playbook.
    //
    // Reaching runValidator requires the evidence gate to see 1-4 sessions
    // with success language (0 sessions short-circuits to draft without any
    // LLM call; >=5 auto-accepts as active). A fake `cass` binary provides
    // those hits; an injected LLMIO answers the validator with ACCEPT plus a
    // refinement.
    await withIsolatedHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");

      const sessionPath = path.join(env.home, "sessions", "s1.jsonl");
      writeJsonlSession(sessionPath, [
        { role: "user", content: "Commit hygiene question: which files should a worker stage before committing in the shared tree?" },
        { role: "assistant", content: "Stage only the files you touched plus .beads/; never use git add -A in a shared worktree." },
      ]);

      const hits = [
        { source_path: "/fake/s1.jsonl", line_number: 1, snippet: "fixed the stray-file commit by staging only touched files", agent: "stub", score: 0.02 },
        { source_path: "/fake/s2.jsonl", line_number: 1, snippet: "discussed staging discipline for the shared worktree", agent: "stub", score: 0.019 },
      ];
      const fakeCass = path.join(env.home, "bin", "cass");
      mkdirSync(path.dirname(fakeCass), { recursive: true });
      writeFileSync(
        fakeCass,
        [
          "#!/bin/sh",
          'case "$1" in',
          '  --version) echo "cass 0.0.0-fake" ;;',
          `  search) cat <<'JSON'`,
          JSON.stringify(hits),
          "JSON",
          "  ;;",
          '  export) echo "user: which files should a worker stage before committing?"; echo "assistant: stage only the files you touched plus .beads/; never git add -A." ;;',
          "  *) exit 1 ;;",
          "esac",
          "",
        ].join("\n"),
        { mode: 0o755 }
      );

      const originalRule = "Stage only your own touched files plus .beads/ before committing; never git add -A.";
      const refinement = "Scope the rule to what's evidenced: workers should stage only their own touched files plus .beads/ in the shared worktree.";

      const config = createTestConfig({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir,
        cassPath: fakeCass,
        validationEnabled: true,
      });

      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
        await withLlmShim({
          reflector: {
            deltas: [{
              type: "add",
              bullet: { content: originalRule, category: "git", tags: [] },
              reason: "Prevents sweeping peer WIP into commits",
              sourceSession: "stub",
            }]
          }
        }, async (shimIo) => {
          let validatorCalls = 0;
          const io = {
            generateObject: async <T,>(options: any) => {
              const prompt: string = options?.prompt || "";
              if (prompt.includes("scientific validator")) {
                validatorCalls++;
                return {
                  object: {
                    verdict: "ACCEPT",
                    confidence: 0.8,
                    reason: "Directly evidenced in the session.",
                    evidence: { supporting: ["staging only touched files fixed the stray commit"], contradicting: [] },
                    suggestedRefinement: refinement,
                  },
                } as any;
              }
              return shimIo.generateObject<T>(options);
            },
          };

          const outcome = await orchestrateReflection(config, { session: sessionPath, io });

          expect(outcome.errors).toEqual([]);
          expect(outcome.sessionsProcessed).toBe(1);
          expect(outcome.deltasGenerated).toBe(1);
          // The LLM validator must actually have been consulted (not the
          // zero-evidence draft short-circuit), or this test is vacuous.
          expect(validatorCalls).toBe(1);

          const saved = readPlaybook(env.playbookPath);
          const added = (saved?.bullets || []).filter((b: any) => b.content === originalRule || b.content === refinement);
          expect(added).toHaveLength(1);
          expect(added[0].content).toBe(originalRule);
          expect(added[0].content).not.toBe(refinement);
          expect(added[0].content.startsWith("Scope the rule to")).toBe(false);
        });
      });
    });
  });

  test("dryRun returns deltas but does not modify the playbook", async () => {
    await withIsolatedHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");

      const sessionPath = path.join(env.home, "sessions", "s1.jsonl");
      writeJsonlSession(sessionPath, [
        { role: "user", content: "This session has enough content to exceed the short-session threshold." },
        { role: "assistant", content: "Adding more content so the text export is long enough for processing." },
      ]);

      const config = createTestConfig({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir,
        cassPath: "/__missing__/cass",
        validationEnabled: false,
      });

      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
        await withLlmShim({
          reflector: {
            deltas: [{
              type: "add",
              bullet: { content: "Dry-run delta should be returned, not persisted.", category: "testing", tags: [] },
              reason: "Dry-run behavior",
              sourceSession: "stub",
            }]
          }
        }, async (io) => {
          const outcome = await orchestrateReflection(config, { session: sessionPath, dryRun: true, io });

          expect(outcome.sessionsProcessed).toBe(1);
          expect(outcome.deltasGenerated).toBe(1);
          expect(outcome.dryRunDeltas?.length).toBe(1);

          const saved = readPlaybook(env.playbookPath);
          expect((saved?.bullets || []).length).toBe(0);
        });
      });
    });
  });

  test("skips short sessions and marks them processed with 0 deltas", async () => {
    await withIsolatedHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");

      const sessionPath = path.join(env.home, "sessions", "short.jsonl");
      writeJsonlSession(sessionPath, [{ role: "user", content: "hi" }]);

      const config = createTestConfig({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir,
        cassPath: "/__missing__/cass",
        validationEnabled: false,
      });

      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
        const outcome = await orchestrateReflection(config, { session: sessionPath });

        expect(outcome.errors).toEqual([]);
        expect(outcome.sessionsProcessed).toBe(0);
        expect(outcome.deltasGenerated).toBe(0);

        const logPath = expandPath(getProcessedLogPath());
        const content = readFileSync(logPath, "utf-8");
        expect(content).toContain(sessionPath);
      });
    });
  });

  test("returns early when session is already processed", async () => {
    await withIsolatedHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");

      const sessionPath = path.join(env.home, "sessions", "s1.jsonl");
      writeJsonlSession(sessionPath, [
        { role: "user", content: "Long enough content to pass the short-session threshold (already processed)." },
        { role: "assistant", content: "More content." },
      ]);

      const processedLog = new ProcessedLog(expandPath(getProcessedLogPath()));
      await processedLog.append({
        sessionPath,
        processedAt: now(),
        diaryId: "diary-xyz",
        deltasGenerated: 0,
      });

      const config = createTestConfig({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir,
        cassPath: "/__missing__/cass",
        validationEnabled: false,
      });

      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
        const outcome = await orchestrateReflection(config, { session: sessionPath });
        expect(outcome.sessionsProcessed).toBe(0);
        expect(outcome.deltasGenerated).toBe(0);
      });
    });
  });

  test("merge deltas deprecate into an existing active replacement (no new bullet)", async () => {
    await withIsolatedHome(async (env) => {
      const replacement = createBullet({ content: "Merged rule content", category: "merged", state: "active" });
      const other = createBullet({ content: "Older duplicate content", category: "general", state: "active" });

      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([replacement, other])), "utf-8");

      const sessionPath = path.join(env.home, "sessions", "s1.jsonl");
      writeJsonlSession(sessionPath, [
        { role: "user", content: "Merge these duplicate rules into a single canonical rule." },
        { role: "assistant", content: "We'll merge and deprecate the duplicates." },
      ]);

      const config = createTestConfig({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir,
        cassPath: "/__missing__/cass",
        validationEnabled: false,
        dedupSimilarityThreshold: 0.85,
      });

      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
        await withLlmShim({
          reflector: {
            deltas: [{
              type: "merge",
              bulletIds: [replacement.id, other.id],
              mergedContent: replacement.content,
              reason: "Duplicates",
            }]
          }
        }, async (io) => {
          const outcome = await orchestrateReflection(config, { session: sessionPath, io });
          expect(outcome.errors).toEqual([]);

          const saved = readPlaybook(env.playbookPath);
          const bullets = saved?.bullets || [];
          expect(bullets.length).toBe(2);

          const savedOther = bullets.find((b: any) => b.id === other.id);
          expect(savedOther).toBeTruthy();
          expect(savedOther.deprecated).toBe(true);
          expect(savedOther.replacedBy).toBe(replacement.id);

          const savedReplacement = bullets.find((b: any) => b.id === replacement.id);
          expect(savedReplacement).toBeTruthy();
          expect(savedReplacement.deprecated).toBe(false);
        });
      });
    });
  });

  test("serializes concurrent reflections for the same workspace log", async () => {
    await withIsolatedHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");

      const sessionPath = path.join(env.home, "sessions", "s1.jsonl");
      writeJsonlSession(sessionPath, [
        { role: "user", content: "Concurrent run test: this content should be long enough to avoid skipping." },
        { role: "assistant", content: "More content to ensure length threshold is passed." },
      ]);

      const config = createTestConfig({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir,
        cassPath: "/__missing__/cass",
        validationEnabled: false,
      });

      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
        await withLlmShim({
          reflector: {
            deltas: [{
              type: "add",
              bullet: { content: "Only one concurrent run should apply this rule.", category: "testing", tags: [] },
              reason: "Concurrency",
              sourceSession: "stub",
            }]
          }
        }, async (io) => {
          const [a, b] = await Promise.all([
            orchestrateReflection(config, { session: sessionPath, io }),
            orchestrateReflection(config, { session: sessionPath, io }),
          ]);

          expect(a.sessionsProcessed + b.sessionsProcessed).toBe(1);

          const saved = readPlaybook(env.playbookPath);
          const contents = (saved?.bullets || []).map((bullet: any) => bullet.content);
          expect(contents.filter((c: string) => c === "Only one concurrent run should apply this rule.").length).toBe(1);
        });
      });
    });
  });

  test("succeeds when reflections directory does not exist (issue #14)", async () => {
    // This test verifies the fix for GitHub issue #14:
    // "cm reflect fails with 'Could not acquire lock' when .orchestrator file doesn't exist"
    //
    // The bug occurred because withLock would fail on fresh installs where
    // ~/.cass-memory/reflections/ doesn't exist. The fix ensures the parent
    // directory is created before attempting lock acquisition.
    await withIsolatedHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");

      // Create a session but intentionally do NOT create the reflections directory
      // The orchestrator should create it automatically before lock acquisition
      const sessionPath = path.join(env.home, "sessions", "fresh-install.jsonl");
      writeJsonlSession(sessionPath, [
        { role: "user", content: "Fresh install test: verifying lock acquisition works without pre-existing reflections dir." },
        { role: "assistant", content: "The ensureDir call should create the directory before withLock is called." },
      ]);

      // Verify reflections directory does NOT exist (simulate fresh install)
      const reflectionsDir = path.join(env.home, ".cass-memory", "reflections");
      const { existsSync } = await import("node:fs");
      expect(existsSync(reflectionsDir)).toBe(false);

      const config = createTestConfig({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir,
        cassPath: "/__missing__/cass",
        validationEnabled: false,
      });

      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
        await withLlmShim({
          reflector: {
            deltas: [{
              type: "add",
              bullet: { content: "Rule from fresh install test.", category: "testing", tags: [] },
              reason: "Fresh install",
              sourceSession: "stub",
            }]
          }
        }, async (io) => {
          // This should NOT throw "Could not acquire lock" error
          const outcome = await orchestrateReflection(config, { session: sessionPath, io });

          expect(outcome.errors).toEqual([]);
          expect(outcome.sessionsProcessed).toBe(1);

          // Verify the reflections directory was created
          expect(existsSync(reflectionsDir)).toBe(true);
        });
      });
    });
  });
});
