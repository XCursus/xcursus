// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { publicDocument, validateDocument } from "@xcursus/core";
import type { ProjectDocument } from "@xcursus/core";
import fixture from "../../../examples/structure-branching/project.json";
import {
  PRESENTER_PROTOCOL,
  connectPublic,
  createPresenterSession,
  parsePresenterMessage,
  randomToken,
} from "../src/presenter.js";
import type { Player } from "../src/index.js";

const doc = (): ProjectDocument => {
  const r = validateDocument(fixture);
  if (!r.ok) throw Error();
  return r.value;
};
const session = randomToken();
const envelope = (extra: Record<string, unknown>, seq = 1) => ({
  protocol: PRESENTER_PROTOCOL,
  sessionId: session,
  epoch: "a".repeat(32),
  seq,
  ...extra,
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Two fake windows. `post(to, from)` returns what `from` sees as `to`: its
 * postMessage delivers to `to` with `from` as the event source, unless the
 * engine misreports the source (`spoof`), as WebKit does after a reload.
 */
interface Fake {
  name: string;
  events: EventTarget;
  location: { origin: string };
  opener: unknown;
  addEventListener: EventTarget["addEventListener"];
  removeEventListener: EventTarget["removeEventListener"];
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}
function fake(name: string, origin = "http://studio.test"): Fake {
  const events = new EventTarget();
  return {
    name,
    events,
    location: { origin },
    opener: null,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    setInterval: ((f: () => void, ms: number) =>
      setInterval(f, ms)) as typeof setInterval,
    clearInterval,
  };
}
const spoof = { source: null as unknown };
function reference(to: Fake, from: Fake) {
  return {
    postMessage(data: unknown, targetOrigin: string) {
      if (targetOrigin !== to.location.origin) return;
      const event = new Event("message");
      Object.defineProperties(event, {
        data: { value: structuredClone(data) },
        origin: { value: from.location.origin },
        // WebKit misreports the source only of messages reaching the reloaded presenter.
        source: {
          value:
            (to.name === "presenter" && spoof.source) ||
            views.get(`${to.name}<-${from.name}`),
        },
      });
      queueMicrotask(() => to.events.dispatchEvent(event));
    },
  };
}
/** What each window holds for the other one. */
const views = new Map<string, unknown>();
function pair() {
  const presenter = fake("presenter"),
    audience = fake("public");
  const popup = reference(audience, presenter),
    opener = reference(presenter, audience);
  views.set("public<-presenter", opener);
  views.set("presenter<-public", popup);
  audience.opener = opener;
  return { presenter, audience, popup };
}
function stubPlayer() {
  const calls: string[] = [];
  let nodeId: string | null = null;
  const player = {
    updateDocument: vi.fn(async () => ({
      ok: true,
      value: undefined,
      diagnostics: [],
    })),
    setPath: vi.fn(async () => {
      calls.push("setPath");
      nodeId = "A";
      return { status: "completed" };
    }),
    goTo: vi.fn(async (t: { nodeId: string }) => {
      calls.push(`goTo ${t.nodeId}`);
      nodeId = t.nodeId;
      return { status: "completed" };
    }),
    next: vi.fn(async (o: { edgeId?: string }) => {
      calls.push(`next ${o.edgeId ?? ""}`);
      return { status: "completed" };
    }),
    prev: vi.fn(async () => {
      calls.push("prev");
      return { status: "completed" };
    }),
    getState: () => ({ nodeId }),
  } as unknown as Player;
  return { player, calls };
}
afterEach(() => {
  spoof.source = null;
  vi.useRealTimers();
});

describe("presenter messages", () => {
  it("accepts only the closed protocol of this session", () => {
    const ok = (m: unknown) => parsePresenterMessage(m, session) !== null;
    expect(ok(envelope({ from: "public", type: "hello" }))).toBe(true);
    expect(
      ok(envelope({ from: "public", type: "hello", nonce: randomToken() })),
    ).toBe(true);
    expect(
      ok(envelope({ from: "presenter", type: "probe", nonce: randomToken() })),
    ).toBe(true);
    expect(
      ok(
        envelope({
          from: "presenter",
          type: "navigate",
          command: { kind: "next", edgeId: "AB" },
        }),
      ),
    ).toBe(true);
    expect(
      ok(
        envelope({
          from: "public",
          type: "request",
          request: { kind: "goTo", nodeId: "D" },
        }),
      ),
    ).toBe(true);
    for (const bad of [
      {
        ...envelope({ from: "public", type: "hello" }),
        sessionId: randomToken(),
      },
      { ...envelope({ from: "public", type: "hello" }), protocol: "other/1" },
      { ...envelope({ from: "public", type: "hello" }), epoch: "short" },
      envelope({ from: "public", type: "hello" }, 0),
      envelope({ from: "public", type: "hello", extra: 1 }),
      envelope({ from: "public", type: "hello", nonce: "x" }),
      envelope({ from: "presenter", type: "probe" }),
      envelope({
        from: "presenter",
        type: "navigate",
        command: { kind: "eval", code: "1" },
      }),
      envelope({
        from: "presenter",
        type: "navigate",
        command: { kind: "goTo", nodeId: "../x", pathId: "p" },
      }),
      envelope({ from: "public", type: "navigate", command: { kind: "next" } }),
      envelope({
        from: "public",
        type: "request",
        request: { kind: "setPath", pathId: "p" },
      }),
    ])
      expect(ok(bad), JSON.stringify(bad)).toBe(false);
  });
  it("refuses snapshots with private notes, foreign asset keys or non-Blob assets", () => {
    const d = publicDocument(doc());
    const snap = (snapshot: unknown) =>
      envelope({ from: "presenter", type: "snapshot", snapshot });
    const base = { document: d, assets: {}, pathId: "branch", visits: ["A"] };
    expect(parsePresenterMessage(snap(base), session)).not.toBeNull();
    const withNotes = structuredClone(d);
    withNotes.scenes[0]!.notes = "secret";
    expect(
      parsePresenterMessage(snap({ ...base, document: withNotes }), session),
    ).toBeNull();
    expect(
      parsePresenterMessage(
        snap({ ...base, assets: { ghost: new Blob(["x"]) } }),
        session,
      ),
    ).toBeNull();
    const withAsset = structuredClone(d);
    withAsset.assets.push({
      id: "pic",
      path: "a/pic.svg",
      mime: "image/svg+xml",
      byteLength: 1,
    });
    expect(
      parsePresenterMessage(
        snap({ ...base, document: withAsset, assets: { pic: "not a blob" } }),
        session,
      ),
    ).toBeNull();
    expect(
      parsePresenterMessage(snap({ ...base, visits: ["../x"] }), session),
    ).toBeNull();
  });
});

describe("presenter session", () => {
  async function connected(misreport = false) {
    const { presenter, audience, popup } = pair();
    const { player, calls } = stubPlayer();
    const requests: unknown[] = [];
    const mounted: ProjectDocument[] = [];
    const states: string[] = [];
    if (misreport) spoof.source = { stranger: true };
    const p = createPresenterSession({
      window: presenter as unknown as Window,
      sessionId: session,
      popup: popup as unknown as Window,
      snapshot: () => ({
        document: publicDocument(doc()),
        assets: {},
        pathId: "branch",
        visits: ["A", "C"],
      }),
      onRequest: (r) => requests.push(r),
    });
    const q = connectPublic({
      window: audience as unknown as Window,
      sessionId: session,
      player,
      assets: () => {},
      mount: async (d) => {
        mounted.push(d);
        return { ok: true, value: undefined, diagnostics: [] };
      },
      onState: (s) => states.push(s),
    });
    for (let i = 0; i < 6; i++) await flush();
    return {
      p,
      q,
      calls,
      requests,
      mounted,
      states,
      presenter,
      audience,
      popup,
    };
  }
  it("probe, hello and snapshot rebuild the presenter history in the public window", async () => {
    const { p, q, calls, mounted, states } = await connected();
    expect(p.connected).toBe(true);
    expect(states.at(-1)).toBe("connected");
    expect(mounted).toHaveLength(1);
    expect(mounted[0]!.scenes.every((s) => s.notes === "")).toBe(true);
    expect(calls).toEqual(["setPath", "goTo C"]);
    p.send({ kind: "next", edgeId: "CD" });
    await flush();
    await flush();
    expect(calls.at(-1)).toBe("next CD");
    q.request({ kind: "prev" });
    p.dispose();
    q.dispose();
  });
  it("forwards public requests to the presenter, never navigating locally", async () => {
    const { p, q, calls, requests } = await connected();
    const before = calls.length;
    q.request({ kind: "next", edgeId: "AB" });
    await flush();
    expect(requests).toEqual([{ kind: "next", edgeId: "AB" }]);
    expect(calls.length).toBe(before);
    p.dispose();
    q.dispose();
  });
  it("with a misreported event.source (WebKit after a reload) the probed nonce still identifies the popup", async () => {
    const { p, q, requests } = await connected(true);
    expect(p.connected).toBe(true);
    q.request({ kind: "prev" });
    await flush();
    expect(requests).toEqual([{ kind: "prev" }]);
    p.dispose();
    q.dispose();
  });
  it("ignores another window and a new epoch that skips the snapshot", async () => {
    const { p, q, calls, presenter, audience, requests } = await connected();
    const count = calls.length;
    // A stranger posts to the public window: wrong source.
    const stranger = fake("stranger");
    reference(audience, stranger).postMessage(
      envelope(
        { from: "presenter", type: "navigate", command: { kind: "next" } },
        99,
      ),
      audience.location.origin,
    );
    // The right source, but a new epoch starting with a navigation.
    reference(audience, presenter).postMessage(
      {
        ...envelope(
          { from: "presenter", type: "navigate", command: { kind: "next" } },
          5,
        ),
        epoch: "b".repeat(32),
      },
      audience.location.origin,
    );
    for (let i = 0; i < 4; i++) await flush();
    expect(calls.length).toBe(count);
    // A request from an unknown source with a wrong nonce is ignored by the presenter.
    spoof.source = { stranger: true };
    reference(presenter, audience).postMessage(
      envelope(
        {
          from: "public",
          type: "request",
          request: { kind: "prev" },
          nonce: randomToken(),
        },
        50,
      ),
      presenter.location.origin,
    );
    await flush();
    expect(requests).toEqual([]);
    p.dispose();
    q.dispose();
  });
  it("without an opener the public window reports it and sends nothing", () => {
    const audience = fake("public");
    const states: string[] = [];
    const { player } = stubPlayer();
    const q = connectPublic({
      window: audience as unknown as Window,
      sessionId: session,
      player,
      assets: () => {},
      mount: async () => ({ ok: true, value: undefined, diagnostics: [] }),
      onState: (s) => states.push(s),
    });
    expect(states).toEqual(["no-opener"]);
    q.dispose();
  });
});
