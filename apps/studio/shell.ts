// Offline shell (0.6): a versioned service worker caches the built Studio
// after the first load. Updates are explicit: a new version waits until the
// user chooses to reload; unsaved work is flushed to local recovery first and
// the usual unsaved-changes prompt still applies. Projects in IndexedDB are
// never touched; the player and exported HTML never depend on this worker.
const ACTIVATE = "xcursus-sw-activate";
function banner(registration: ServiceWorkerRegistration) {
  if (document.getElementById("shell-update")) return;
  const bar = document.createElement("div");
  bar.id = "shell-update";
  bar.className = "shell-update";
  bar.setAttribute("role", "status");
  const text = document.createElement("span");
  text.textContent =
    "A new version of Studio is available. Local projects are kept.";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Update and reload";
  button.addEventListener("click", async () => {
    button.disabled = true;
    const pending: Promise<unknown>[] = [];
    window.dispatchEvent(
      new CustomEvent("xcursus:before-update", {
        detail: { wait: (p: Promise<unknown>) => pending.push(p) },
      }),
    );
    await Promise.race([
      Promise.allSettled(pending),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
    registration.waiting?.postMessage({ type: ACTIVATE });
  });
  const later = document.createElement("button");
  later.type = "button";
  later.textContent = "Later";
  later.addEventListener("click", () => bar.remove());
  bar.append(text, button, later);
  document.body.append(bar);
}
export async function registerShell() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  // Only a page already served by a previous worker can have an update: on
  // the first installation WebKit reports the claimed controller before the
  // new worker's "installed" state, which must not look like an update.
  const previous = !!navigator.serviceWorker.controller;
  try {
    const registration = await navigator.serviceWorker.register("./sw.js", {
      scope: "./",
    });
    const watch = (worker: ServiceWorker | null) =>
      worker?.addEventListener("statechange", () => {
        if (worker.state === "installed" && previous) banner(registration);
      });
    if (registration.waiting && previous) banner(registration);
    watch(registration.installing);
    registration.addEventListener("updatefound", () =>
      watch(registration.installing),
    );
    Object.assign(window, { studioShell: registration });
  } catch {
    /* Studio keeps working online without the offline shell. */
  }
}
