import { describe, expect, test } from "vitest";
import type { NavigationResult } from "@xcursus/core";
import { createImpressAdapter } from "@xcursus/impress-compat";
import type { AdapterPlayer } from "@xcursus/impress-compat";
import { candidate, deck } from "./helpers.js";

/** Records navigation like a player that completes every move at once. */
function fakePlayer(start: string) {
  const state = {
    pathId: "main" as string | null,
    nodeId: start as string | null,
  };
  const calls: Array<{ nodeId: string; durationMs?: number }> = [];
  const player: AdapterPlayer = {
    async goTo(target, options) {
      calls.push({
        nodeId: target.nodeId,
        ...(options?.durationMs !== undefined
          ? { durationMs: options.durationMs }
          : {}),
      });
      if (target.nodeId === state.nodeId) return { status: "noop" };
      state.nodeId = target.nodeId;
      return { status: "completed" } satisfies NavigationResult;
    },
    getState: () => state,
  };
  return { player, calls, state };
}

describe("impress.js API adapter", () => {
  const doc = candidate(
    deck(
      `<div class="step" id="a">a</div><div class="step skip" id="b">b</div>` +
        `<div class="step" id="c">c</div><div class="step" id="d">d</div>`,
    ),
    { profile: "bundle" },
  ).document;

  test("next and prev follow document order, skip steps off the path and wrap", async () => {
    const { player, calls } = fakePlayer("a");
    const impress = createImpressAdapter(player, doc);
    expect(impress.steps.map((s) => [s.stepId, s.nodeId ?? null])).toEqual([
      ["a", "a"],
      ["b", null],
      ["c", "c"],
      ["d", "d"],
    ]);
    await impress.next();
    await impress.next();
    await impress.next(); // wraps like impress.js
    await impress.prev(); // wraps backwards
    await impress.prev();
    expect(calls.map((c) => c.nodeId)).toEqual(["c", "d", "a", "d", "c"]);
  });

  test("goto by index, negative index and ID, with a duration", async () => {
    const { player, calls } = fakePlayer("a");
    const impress = createImpressAdapter(player, doc);
    expect((await impress.goto(-1)).status).toBe("completed");
    expect((await impress.goto("c", 250)).status).toBe("completed");
    expect((await impress.goto("c")).status).toBe("noop");
    expect(calls).toEqual([
      { nodeId: "d" },
      { nodeId: "c", durationMs: 250 },
      { nodeId: "c" },
    ]);
    const missing = await impress.goto("zzz");
    expect(missing.status).toBe("error");
    expect(missing.diagnostic?.code).toBe("IMPRESS_UNKNOWN_STEP");
    expect((await impress.goto(1)).diagnostic?.message).toContain(
      "not on the imported path",
    );
    expect((await impress.goto(1.5)).status).toBe("error");
    expect((await impress.goto(99)).status).toBe("error");
    expect(calls).toHaveLength(3);
  });

  test("without an active node, next starts at the first step and prev at the last", async () => {
    const empty = fakePlayer("a");
    empty.state.nodeId = null;
    const impress = createImpressAdapter(empty.player, doc);
    await impress.next();
    empty.state.nodeId = null;
    await impress.prev();
    expect(empty.calls.map((c) => c.nodeId)).toEqual(["a", "d"]);
  });

  test("exposes only the implemented subset and installs no global", () => {
    const impress = createImpressAdapter(fakePlayer("a").player, doc);
    expect(Object.keys(impress).sort()).toEqual([
      "goto",
      "next",
      "prev",
      "steps",
    ]);
    expect((globalThis as { impress?: unknown }).impress).toBeUndefined();
  });
});
