import { validateDocument } from "@xcursus/core";
import type { ProjectDocument, Result } from "@xcursus/core";
import type { NavigationRequest, Player } from "./index.js";

/**
 * Presenter view session (0.6): one presenter window, the only navigation
 * authority, and one public window opened by it. Messages travel with
 * window.postMessage between opener and popup; each side checks the origin,
 * the source window, the protocol, the random session ID and a strictly
 * increasing sequence number per sender epoch. The presenter also probes the
 * popup with a random nonce that the public window repeats: where an engine
 * misreports `event.source` (WebKit after the presenter tab reloads), the
 * nonce proves the message comes from the window behind the popup reference.
 * The public side never sends a navigation, only requests, so there is no
 * feedback loop; after a reload it resynchronizes from a snapshot, not by
 * replaying messages.
 */
export const PRESENTER_PROTOCOL = "xcursus-presenter/1";
export type PresenterCommand =
  | { kind: "next"; edgeId?: string }
  | { kind: "prev" }
  | { kind: "goTo"; pathId: string; nodeId: string }
  | { kind: "setPath"; pathId: string };
interface Envelope {
  protocol: typeof PRESENTER_PROTOCOL;
  sessionId: string;
  /** Random per page load: a reload starts a new sequence. */
  epoch: string;
  seq: number;
}
export interface PresenterSnapshot {
  /** Public copy: no private notes (publicDocument). */
  document: ProjectDocument;
  /** Local resource bytes by asset ID, verified again by the public resolver. */
  assets: Record<string, Blob>;
  pathId: string | null;
  /** Node IDs of the presenter history, oldest first. */
  visits: string[];
}
export type PresenterMessage =
  | (Envelope & { from: "public"; type: "hello"; nonce?: string })
  | (Envelope & {
      from: "public";
      type: "request";
      request: NavigationRequest;
      nonce?: string;
    })
  | (Envelope & { from: "presenter"; type: "probe"; nonce: string })
  | (Envelope & {
      from: "presenter";
      type: "snapshot";
      snapshot: PresenterSnapshot;
    })
  | (Envelope & {
      from: "presenter";
      type: "navigate";
      command: PresenterCommand;
    })
  | (Envelope & { from: "presenter"; type: "close" });

const id = /^[A-Za-z0-9_-]{1,96}$/;
const token = /^[0-9a-f]{32}$/;
const plain = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).every((k) => allowed.includes(k));
/** 128 random bits as hex: session IDs and epochs. */
export function randomToken(): string {
  return Array.from(
    globalThis.crypto.getRandomValues(new Uint8Array(16)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
function request(v: unknown): NavigationRequest | null {
  if (!plain(v)) return null;
  if (v.kind === "prev" && keys(v, ["kind"])) return { kind: "prev" };
  if (v.kind === "next" && keys(v, ["kind", "edgeId"])) {
    if (v.edgeId === undefined) return { kind: "next" };
    return typeof v.edgeId === "string" && id.test(v.edgeId)
      ? { kind: "next", edgeId: v.edgeId }
      : null;
  }
  if (
    v.kind === "goTo" &&
    keys(v, ["kind", "nodeId"]) &&
    typeof v.nodeId === "string" &&
    id.test(v.nodeId)
  )
    return { kind: "goTo", nodeId: v.nodeId };
  return null;
}
function command(v: unknown): PresenterCommand | null {
  if (!plain(v)) return null;
  const ok = (field: unknown) => typeof field === "string" && id.test(field);
  if (
    v.kind === "goTo" &&
    keys(v, ["kind", "pathId", "nodeId"]) &&
    ok(v.pathId) &&
    ok(v.nodeId)
  )
    return {
      kind: "goTo",
      pathId: v.pathId as string,
      nodeId: v.nodeId as string,
    };
  if (v.kind === "setPath" && keys(v, ["kind", "pathId"]) && ok(v.pathId))
    return { kind: "setPath", pathId: v.pathId as string };
  const r = request(v);
  return r && r.kind !== "goTo" ? r : null;
}
/** Strict validation; anything else, including another session, is ignored. */
export function parsePresenterMessage(
  data: unknown,
  sessionId: string,
): PresenterMessage | null {
  if (
    !plain(data) ||
    data.protocol !== PRESENTER_PROTOCOL ||
    data.sessionId !== sessionId ||
    typeof data.epoch !== "string" ||
    !token.test(data.epoch) ||
    !Number.isSafeInteger(data.seq) ||
    (data.seq as number) < 1
  )
    return null;
  const base = {
    protocol: PRESENTER_PROTOCOL,
    sessionId,
    epoch: data.epoch,
    seq: data.seq as number,
  } as const;
  const head = ["protocol", "sessionId", "epoch", "seq", "from", "type"];
  if (data.from === "public") {
    if (
      data.nonce !== undefined &&
      !(typeof data.nonce === "string" && token.test(data.nonce))
    )
      return null;
    const nonce = typeof data.nonce === "string" ? { nonce: data.nonce } : {};
    if (data.type === "hello" && keys(data, [...head, "nonce"]))
      return { ...base, from: "public", type: "hello", ...nonce };
    const r =
      data.type === "request" && keys(data, [...head, "request", "nonce"])
        ? request(data.request)
        : null;
    return r
      ? { ...base, from: "public", type: "request", request: r, ...nonce }
      : null;
  }
  if (data.from !== "presenter") return null;
  if (
    data.type === "probe" &&
    keys(data, [...head, "nonce"]) &&
    typeof data.nonce === "string" &&
    token.test(data.nonce)
  )
    return { ...base, from: "presenter", type: "probe", nonce: data.nonce };
  if (data.type === "close" && keys(data, head))
    return { ...base, from: "presenter", type: "close" };
  if (data.type === "navigate" && keys(data, [...head, "command"])) {
    const c = command(data.command);
    return c
      ? { ...base, from: "presenter", type: "navigate", command: c }
      : null;
  }
  if (
    data.type === "snapshot" &&
    keys(data, [...head, "snapshot"]) &&
    plain(data.snapshot)
  ) {
    const s = data.snapshot;
    const assets = s.assets;
    if (
      !keys(s, ["document", "assets", "pathId", "visits"]) ||
      !plain(assets) ||
      // Blobs come from another window: compare the tag, not the realm's constructor.
      !Object.values(assets).every(
        (b) => Object.prototype.toString.call(b) === "[object Blob]",
      ) ||
      !(
        s.pathId === null ||
        (typeof s.pathId === "string" && id.test(s.pathId))
      ) ||
      !Array.isArray(s.visits) ||
      s.visits.length > 10000 ||
      !s.visits.every((v) => typeof v === "string" && id.test(v))
    )
      return null;
    const valid = validateDocument(s.document);
    // A snapshot carrying private notes is refused: notes stay with the presenter.
    if (
      !valid.ok ||
      valid.value.scenes.some((scene) => scene.notes !== "") ||
      !Object.keys(assets).every((key) =>
        valid.value.assets.some((a) => a.id === key),
      )
    )
      return null;
    return {
      ...base,
      from: "presenter",
      type: "snapshot",
      snapshot: {
        document: valid.value,
        assets: assets as Record<string, Blob>,
        pathId: s.pathId as string | null,
        visits: s.visits as string[],
      },
    };
  }
  return null;
}

/** Sequence check per sender epoch: a reload (new epoch) must start with a probe, snapshot or hello. */
class Sequence {
  private epoch = "";
  private last = 0;
  accept(message: PresenterMessage, resets: boolean): boolean {
    if (message.epoch !== this.epoch) {
      if (!resets) return false;
      this.epoch = message.epoch;
      this.last = message.seq;
      return true;
    }
    if (message.seq <= this.last) return false;
    this.last = message.seq;
    return true;
  }
}

export interface PublicConnection {
  /** Forwards a user request (keys, outline, choices) to the presenter. */
  request(request: NavigationRequest): void;
  dispose(): void;
}
/**
 * Public window side. `window.opener` is the only accepted source; until a
 * snapshot arrives, and then every few seconds, it says hello so that a
 * reloaded presenter can adopt it again.
 */
export function connectPublic(options: {
  window: Window;
  sessionId: string;
  player: Player;
  /** Mounts the first snapshot; later snapshots go through updateDocument after `assets`. */
  mount(document: ProjectDocument): Promise<Result<void>>;
  /** Receives each snapshot's resources before its document is applied. */
  assets(blobs: Map<string, Blob>, document: ProjectDocument): void;
  onState?(state: "waiting" | "connected" | "closed" | "no-opener"): void;
  intervalMs?: number;
}): PublicConnection {
  const { window: win, sessionId, player } = options;
  const epoch = randomToken(),
    incoming = new Sequence();
  let seq = 0,
    mounted = false,
    connected = false,
    // Last nonce probed by the presenter, repeated in every message to it.
    nonce: string | undefined,
    chain: Promise<unknown> = Promise.resolve();
  // Read live: after the presenter tab reloads, some engines hand out a new
  // WindowProxy for the same opener.
  const opener = () => win.opener as Window | null;
  const post = (
    message: Omit<PresenterMessage, keyof Envelope> & Record<string, unknown>,
  ) =>
    opener()?.postMessage(
      {
        protocol: PRESENTER_PROTOCOL,
        sessionId,
        epoch,
        seq: ++seq,
        ...message,
        ...(nonce ? { nonce } : {}),
      },
      win.location.origin,
    );
  const hello = () => post({ from: "public", type: "hello" });
  if (!opener()) options.onState?.("no-opener");
  else options.onState?.("waiting");
  const apply = async (message: PresenterMessage) => {
    if (message.type === "probe") {
      nonce = message.nonce;
      hello();
      return;
    }
    if (message.type === "close") {
      connected = false;
      options.onState?.("closed");
      return;
    }
    if (message.type === "snapshot") {
      const { document, pathId, visits } = message.snapshot;
      options.assets(
        new Map(Object.entries(message.snapshot.assets)),
        document,
      );
      const result = mounted
        ? await player.updateDocument(document)
        : await options.mount(document);
      if (!result.ok) return;
      mounted = true;
      if (pathId) {
        await player.setPath(pathId);
        for (const nodeId of visits.slice(
          player.getState().nodeId === visits[0] ? 1 : 0,
        ))
          await player.goTo({ pathId, nodeId }, { durationMs: 0 });
      }
      connected = true;
      options.onState?.("connected");
      return;
    }
    if (message.type !== "navigate" || !connected) return;
    const c = message.command;
    const result =
      c.kind === "next"
        ? await player.next(c.edgeId ? { edgeId: c.edgeId } : {})
        : c.kind === "prev"
          ? await player.prev()
          : c.kind === "goTo"
            ? await player.goTo({ pathId: c.pathId, nodeId: c.nodeId })
            : await player.setPath(c.pathId);
    // Diverged (for instance after a missed message): ask for a snapshot.
    if (result.status === "error") hello();
  };
  const listener = (event: MessageEvent) => {
    if (
      event.origin !== win.location.origin ||
      !opener() ||
      event.source !== opener()
    )
      return;
    const message = parsePresenterMessage(event.data, sessionId);
    if (!message || message.from !== "presenter") return;
    if (
      !incoming.accept(
        message,
        message.type === "snapshot" || message.type === "probe",
      )
    )
      return;
    chain = chain.then(() => apply(message));
  };
  win.addEventListener("message", listener);
  hello();
  const timer = win.setInterval(hello, options.intervalMs ?? 2000);
  return {
    request: (r) => {
      if (connected) post({ from: "public", type: "request", request: r });
    },
    dispose() {
      win.clearInterval(timer);
      win.removeEventListener("message", listener);
    },
  };
}

export interface PresenterSession {
  /** Broadcasts a command already applied by the presenter. */
  send(command: PresenterCommand): void;
  /** The public window opened (again) by a user gesture. */
  attach(popup: Window | null): void;
  readonly connected: boolean;
  close(): void;
  dispose(): void;
}
export const publicWindowName = (sessionId: string) =>
  `xcursus-public-${sessionId}`;
/**
 * Presenter side. Accepts hello and requests from the popup it holds, by
 * identity or by the nonce it probed through that popup reference; without a
 * popup (after its own reload, when the window could not be found again) it
 * adopts the first window that says hello with the session ID kept in
 * sessionStorage, which then becomes the only source.
 */
export function createPresenterSession(options: {
  window: Window;
  sessionId: string;
  popup: Window | null;
  snapshot(): PresenterSnapshot;
  onRequest(request: NavigationRequest): void;
  onConnection?(connected: boolean): void;
}): PresenterSession {
  const { window: win, sessionId } = options;
  const epoch = randomToken(),
    incoming = new Sequence();
  const nonce = randomToken();
  let popup = options.popup,
    seq = 0,
    synced = "",
    connected = false;
  const post = (message: Record<string, unknown>) =>
    popup?.postMessage(
      {
        protocol: PRESENTER_PROTOCOL,
        sessionId,
        epoch,
        seq: ++seq,
        ...message,
      },
      win.location.origin,
    );
  const listener = (event: MessageEvent) => {
    if (event.origin !== win.location.origin || !event.source) return;
    const message = parsePresenterMessage(event.data, sessionId);
    if (!message || message.from !== "public") return;
    if (popup && event.source !== popup && message.nonce !== nonce) return;
    if (!incoming.accept(message, message.type === "hello")) return;
    if (!popup) popup = event.source as Window;
    if (message.type === "hello") {
      // One snapshot per public page load; later hellos are liveness only.
      if (synced === message.epoch) return;
      synced = message.epoch;
      post({
        from: "presenter",
        type: "snapshot",
        snapshot: options.snapshot(),
      });
      connected = true;
      options.onConnection?.(true);
    } else if (message.type === "request") options.onRequest(message.request);
  };
  win.addEventListener("message", listener);
  // Probe until the popup answers; the reply carries the nonce back.
  const probe = () => {
    if (popup && !connected) post({ from: "presenter", type: "probe", nonce });
  };
  probe();
  const timer = win.setInterval(probe, 1000);
  return {
    send: (command) => {
      if (connected) post({ from: "presenter", type: "navigate", command });
    },
    attach(next) {
      popup = next;
      synced = "";
      connected = false;
      options.onConnection?.(false);
      probe();
    },
    get connected() {
      return connected;
    },
    close() {
      post({ from: "presenter", type: "close" });
      connected = false;
      options.onConnection?.(false);
    },
    dispose() {
      win.clearInterval(timer);
      win.removeEventListener("message", listener);
    },
  };
}
