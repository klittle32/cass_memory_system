import { describe, expect, test } from "bun:test";
import {
  formatBulletsForPrompt,
  reflectOnSession,
  selectBulletsForReflectorPrompt,
} from "../src/reflect.js";
import {
  createTestBullet,
  createTestConfig,
  createTestDiary,
  createTestPlaybook,
} from "./helpers/factories.js";
import { withLlmShim } from "./helpers/llm-shim.js";

const config = createTestConfig();

function idsOf(bullets: ReturnType<typeof selectBulletsForReflectorPrompt>): string[] {
  return bullets.map((b) => b.id);
}

describe("selectBulletsForReflectorPrompt", () => {
  test("includes proven rules even when they sit in the middle of 100 filler drafts", () => {
    const fillers = Array.from({ length: 100 }, (_, i) =>
      createTestBullet({
        id: `b-filler-${String(i).padStart(3, "0")}`,
        content: `Format Python files with black and isort before opening pull request ${i}`,
        maturity: "candidate",
        state: "draft",
      })
    );
    const proven = [
      createTestBullet({
        id: "b-proven-a",
        content: "Always run bun typecheck after TypeScript edits",
        maturity: "proven",
        state: "active",
      }),
      createTestBullet({
        id: "b-proven-b",
        content: "Never delete files without explicit written permission",
        maturity: "proven",
        state: "active",
      }),
      createTestBullet({
        id: "b-proven-c",
        content: "Use bun exclusively; never npm yarn or pnpm in this repo",
        maturity: "proven",
        state: "active",
      }),
    ];
    const playbook = createTestPlaybook([
      ...fillers.slice(0, 40),
      ...proven,
      ...fillers.slice(40),
    ]);
    const diary = createTestDiary({
      accomplishments: ["Documented a deploy rollback"],
      decisions: ["Kept the canary at 5 percent"],
      challenges: ["Staging DNS lagged"],
      keyLearnings: ["Health checks must cover the canary host"],
    });

    const selected = selectBulletsForReflectorPrompt(playbook, diary, config);
    const ids = idsOf(selected);

    expect(ids).toContain("b-proven-a");
    expect(ids).toContain("b-proven-b");
    expect(ids).toContain("b-proven-c");
    expect(ids.filter((id) => id.startsWith("b-filler-")).length).toBeLessThan(fillers.length);
  });

  test("never includes retired, deprecated-maturity, or deprecated-flag bullets", () => {
    const playbook = createTestPlaybook([
      createTestBullet({
        id: "b-core",
        content: "Prefer helpful marks on existing playbook ids",
        maturity: "established",
        state: "active",
      }),
      createTestBullet({
        id: "b-retired-state",
        content: "Retired state but overlapping diary text about playbook ids",
        maturity: "proven",
        state: "retired",
      }),
      createTestBullet({
        id: "b-retired-maturity",
        content: "Deprecated maturity overlapping playbook ids diary text",
        maturity: "deprecated",
        state: "active",
      }),
      createTestBullet({
        id: "b-retired-flag",
        content: "Deprecated flag overlapping playbook ids diary text",
        maturity: "established",
        state: "active",
        deprecated: true,
      }),
    ]);
    const diary = createTestDiary({
      accomplishments: ["Voted helpful on existing playbook ids"],
      keyLearnings: ["Prefer marks on playbook ids"],
    });

    const ids = idsOf(selectBulletsForReflectorPrompt(playbook, diary, config));
    expect(ids).toEqual(["b-core"]);
  });

  test("includes a similar candidate draft in addition to proven when diary text overlaps", () => {
    const playbook = createTestPlaybook([
      createTestBullet({
        id: "b-proven-core",
        content: "Always run bun typecheck after TypeScript edits",
        maturity: "proven",
        state: "active",
      }),
      createTestBullet({
        id: "b-similar-draft",
        content:
          "Workspace-scoped cass session discovery must match the processed log via cass sessions --workspace",
        maturity: "candidate",
        state: "draft",
      }),
      createTestBullet({
        id: "b-unrelated-draft",
        content: "Format Python files with black and isort before opening a pull request",
        maturity: "candidate",
        state: "draft",
      }),
    ]);
    const diary = createTestDiary({
      accomplishments: [
        "Fixed workspace-scoped cass session discovery so the processed log matches",
      ],
      decisions: ["Call cass sessions --workspace instead of the global timeline"],
      challenges: ["Unrelated sessions drained the processed log"],
      keyLearnings: ["Discovery must match the processed-log scope"],
    });

    const ids = idsOf(selectBulletsForReflectorPrompt(playbook, diary, config));
    expect(ids).toContain("b-proven-core");
    expect(ids).toContain("b-similar-draft");
    expect(ids).not.toContain("b-unrelated-draft");
  });

  test("keeps established with proven in the core set", () => {
    const playbook = createTestPlaybook([
      createTestBullet({
        id: "b-established",
        content: "Stage file-specific paths; never git add -A",
        maturity: "established",
        state: "active",
      }),
      createTestBullet({
        id: "b-candidate",
        content: "A throwaway candidate about lorem ipsum dolor sit amet",
        maturity: "candidate",
        state: "draft",
      }),
    ]);
    const diary = createTestDiary({
      accomplishments: ["Deployed a canary"],
    });

    const ids = idsOf(selectBulletsForReflectorPrompt(playbook, diary, config));
    expect(ids).toContain("b-established");
    expect(ids).not.toContain("b-candidate");
  });

  test("drops similar drafts before proven/established when the 20k char budget is tight", () => {
    const proven = createTestBullet({
      id: "b-proven-budget",
      content: "Keep the voted core in the reflector prompt",
      maturity: "proven",
      state: "active",
    });
    const similar = Array.from({ length: 40 }, (_, i) =>
      createTestBullet({
        id: `b-sim-${i}`,
        content: `Reflector prompt selection workspace cass session discovery processed log ${"overlap ".repeat(80)} ${i}`,
        maturity: "candidate",
        state: "draft",
      })
    );
    const playbook = createTestPlaybook([proven, ...similar]);
    const diary = createTestDiary({
      accomplishments: ["Workspace cass session discovery processed log reflector prompt selection"],
      keyLearnings: ["overlap overlap overlap"],
    });

    const selected = selectBulletsForReflectorPrompt(playbook, diary, config);
    const ids = idsOf(selected);
    expect(ids[0]).toBe("b-proven-budget");
    expect(formatBulletsForPrompt(selected).length).toBeLessThanOrEqual(20_000);
    expect(ids.filter((id) => id.startsWith("b-sim-")).length).toBeLessThan(similar.length);
  });

  test("reflectOnSession prompt includes proven ids and omits retired filler", async () => {
    const playbook = createTestPlaybook([
      createTestBullet({
        id: "b-retired-prompt",
        content: "This retired rule must not appear in the reflector prompt",
        maturity: "proven",
        state: "retired",
      }),
      createTestBullet({
        id: "b-proven-prompt",
        content: "Always run bun typecheck after TypeScript edits",
        maturity: "proven",
        state: "active",
      }),
    ]);
    const diary = createTestDiary({
      accomplishments: ["Ran bun typecheck"],
    });

    await withLlmShim(
      { reflector: { deltas: [] }, trackCalls: true },
      async (io) => {
        await reflectOnSession(diary, playbook, config, io);
      }
    );

    const { getLlmCallLog } = await import("./helpers/llm-shim.js");
    const log = getLlmCallLog();
    const prompt = String(log?.reflector[0]?.diary ?? "");
    expect(prompt).toContain("b-proven-prompt");
    expect(prompt).not.toContain("b-retired-prompt");
  });
});
