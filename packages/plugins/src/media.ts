import { AssetError, defaultMessages } from "@xcursus/player";
import type {
  AssetLease,
  ContentContext,
  ContentRenderer,
  PlayerMessages,
  RendererRegistry,
} from "@xcursus/player";
import { sanitizeContent } from "./security.js";
/** Resolver failures become replaceable texts; unknown errors keep their detail. */
function assetMessage(
  messages: Readonly<PlayerMessages>,
  assetId: string,
  error: unknown,
) {
  const code = error instanceof AssetError ? error.code : undefined;
  return code === "missing"
    ? messages.assetMissing(assetId)
    : code === "size" || code === "signature" || code === "digest"
      ? messages.assetInvalid(assetId, code)
      : messages.contentError(String(error));
}
async function imageLease(
  host: HTMLElement,
  lease: AssetLease,
  prefix: string,
): Promise<AssetLease> {
  if (lease.mime !== "image/svg+xml") return lease;
  try {
    if (!lease.blob)
      throw new AssetError(
        "signature",
        "SVG needs the original Blob for sanitization.",
      );
    const fragment = sanitizeContent(
      host,
      await lease.blob.text(),
      "svg",
      prefix,
    );
    const svg = fragment.querySelector("svg");
    if (!svg) throw new AssetError("signature", "Invalid SVG.");
    const url = URL.createObjectURL(
      new Blob([new XMLSerializer().serializeToString(svg)], {
        type: "image/svg+xml",
      }),
    );
    let released = false;
    return {
      url,
      mime: lease.mime,
      release() {
        if (!released) {
          released = true;
          URL.revokeObjectURL(url);
        }
      },
    };
  } finally {
    lease.release();
  }
}
/** Capture readiness: settles once metadata or an error arrives, never rejects. */
function settled(media: HTMLMediaElement, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (media.readyState >= 1 || media.error || signal.aborted)
      return resolve();
    const done = () => resolve();
    media.addEventListener("loadedmetadata", done, { once: true });
    media.addEventListener("error", done, { once: true });
    signal.addEventListener("abort", done, { once: true });
  });
}
/** Capture readiness of an image: settles after decoding or a decode error. */
const decoded = (image: HTMLImageElement): Promise<void> =>
  typeof image.decode === "function"
    ? image.decode().catch(() => undefined)
    : Promise.resolve();
/** Image, audio and video; `createBuiltinRegistry` loads this module on first use. */
export function mediaRenderer(): ContentRenderer {
  let host: HTMLElement,
    context: ContentContext,
    element: HTMLMediaElement | undefined,
    status: HTMLElement,
    playButton: HTMLButtonElement | undefined,
    last = "",
    generation = 0,
    failedState = false,
    building: Promise<void> = Promise.resolve();
  const leases: AssetLease[] = [];
  const text = () => context.messages ?? defaultMessages;
  function clear() {
    generation++;
    failedState = false;
    if (element) {
      element.onerror = null;
      element.pause();
      element.removeAttribute("src");
      element.querySelectorAll("track").forEach((t) => t.remove());
      element.load();
      element = undefined;
    }
    leases.splice(0).forEach((l) => l.release());
    host.replaceChildren();
    playButton = undefined;
  }
  function message(text: string) {
    status.textContent = text;
    status.hidden = !text;
  }
  function failed(text: string) {
    failedState = true;
    message(text);
    if (!context.signal.aborted) context.services.mediaError?.(text);
  }
  async function play() {
    if (!element || !context.active) return;
    try {
      await element.play();
      if (!context.active) element.pause();
      else {
        failedState = false;
        message("");
      }
    } catch {
      if (!context.signal.aborted) failed(text().mediaRejected);
    }
  }
  function active() {
    if (!element) return;
    if (playButton) playButton.disabled = !context.active;
    if (!context.active) {
      element.pause();
      if (
        (context.block.type === "audio" || context.block.type === "video") &&
        context.block.data.onExit === "stop"
      ) {
        try {
          element.currentTime = 0;
        } catch {
          /* Not loaded yet. */
        }
      }
    } else if (
      context.mediaEnabled &&
      (context.block.type === "audio" || context.block.type === "video") &&
      context.block.data.autoplay
    )
      void play();
  }
  async function build(token: number) {
    // Loading states are shown at once; capture readiness waits for these too.
    const waits: Promise<void>[] = [];
    const block = context.block;
    if (!["image", "audio", "video"].includes(block.type)) return;
    if (
      block.type !== "image" &&
      block.type !== "audio" &&
      block.type !== "video"
    )
      return;
    const assets = context.services.assets;
    if (!assets) {
      failed(text().assetMissing(block.data.assetId));
      return;
    }
    let resolving = block.data.assetId;
    try {
      let lease = await assets.resolve(block.data.assetId, context.signal);
      if (block.type === "image")
        lease = await imageLease(host, lease, context.instanceId);
      if (context.signal.aborted || token !== generation) {
        lease.release();
        return;
      }
      leases.push(lease);
      if (block.type === "image") {
        const img = host.ownerDocument.createElement("img");
        img.alt = block.data.alt;
        img.style.objectFit = block.data.fit;
        img.src = lease.url;
        img.onerror = () => {
          if (!context.signal.aborted) failed(text().imageDecodeError);
        };
        host.prepend(img);
        waits.push(decoded(img));
      } else {
        const media = host.ownerDocument.createElement(block.type);
        element = media;
        media.controls = true;
        if (block.type === "video") media.setAttribute("playsinline", "");
        media.preload = "metadata";
        media.loop = block.data.loop;
        media.muted = context.mediaMuted;
        media.setAttribute("aria-label", block.data.label);
        media.src = lease.url;
        media.onerror = () => failed(text().mediaDecodeError);
        const button = host.ownerDocument.createElement("button");
        button.type = "button";
        button.lang = text().lang;
        button.textContent = text().mediaPlay(block.data.label);
        button.onclick = () => void play();
        playButton = button;
        host.prepend(media);
        host.append(button);
        if (block.type === "video") {
          media.setAttribute("aria-description", block.data.alt);
          if (block.data.posterAssetId) {
            resolving = block.data.posterAssetId;
            let poster = await assets.resolve(
              block.data.posterAssetId,
              context.signal,
            );
            poster = await imageLease(
              host,
              poster,
              context.instanceId + "-poster",
            );
            if (context.signal.aborted || token !== generation) {
              poster.release();
              return;
            }
            leases.push(poster);
            (media as HTMLVideoElement).poster = poster.url;
            const preview = host.ownerDocument.createElement("img");
            preview.src = poster.url;
            waits.push(decoded(preview));
          }
          if (block.data.captionsAssetId) {
            resolving = block.data.captionsAssetId;
            const captions = await assets.resolve(
              block.data.captionsAssetId,
              context.signal,
            );
            if (context.signal.aborted || token !== generation) {
              captions.release();
              return;
            }
            leases.push(captions);
            const track = host.ownerDocument.createElement("track");
            track.kind = "captions";
            track.label = block.data.label;
            track.srclang = context.document.metadata.language;
            track.src = captions.url;
            track.default = true;
            media.append(track);
          }
        }
        active();
        waits.push(settled(media, context.signal));
      }
      if (!failedState) message("");
      await Promise.all(waits);
    } catch (error) {
      if (!context.signal.aborted && token === generation)
        failed(assetMessage(text(), resolving, error));
    }
  }
  function update(next: ContentContext) {
    const changed = JSON.stringify(next.block) !== last,
      wasEnabled = context?.mediaEnabled,
      wasActive = context?.active;
    context = next;
    if (changed) {
      clear();
      last = JSON.stringify(next.block);
      status = host.ownerDocument.createElement("p");
      status.setAttribute("role", "status");
      status.lang = text().lang;
      host.append(status);
      message(text().mediaLoading);
      building = build(generation);
    } else if (wasActive !== next.active || wasEnabled !== next.mediaEnabled)
      active();
  }
  return {
    mount(element, next) {
      host = element;
      update(next);
    },
    update,
    destroy: clear,
    ready: () => building,
  };
}
export function registerMedia(registry: RendererRegistry): () => void {
  const off = (["image", "audio", "video"] as const).map((type) =>
    registry.register(type, mediaRenderer),
  );
  return () => off.forEach((dispose) => dispose());
}
