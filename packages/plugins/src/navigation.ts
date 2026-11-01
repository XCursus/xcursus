import { defaultMessages } from "@xcursus/player";
import type {
  ContentContext,
  ContentRenderer,
  RendererRegistry,
} from "@xcursus/player";
export interface EmbedPolicy {
  allowedOrigins: readonly string[];
}
export function registerNavigation(
  registry: RendererRegistry,
  policy: EmbedPolicy = { allowedOrigins: [] },
): () => void {
  const link = registry.register("link", () => {
    let host: HTMLElement,
      context: ContentContext,
      last = "";
    function update(next: ContentContext) {
      context = next;
      if (next.block.type !== "link" || JSON.stringify(next.block) === last)
        return;
      last = JSON.stringify(next.block);
      host.replaceChildren();
      const button = host.ownerDocument.createElement("button");
      button.type = "button";
      button.textContent = next.block.data.label;
      button.onclick = () => {
        if (context.block.type === "link")
          void context.services.navigate(context.block.data.target);
      };
      host.append(button);
    }
    return {
      mount(element, next) {
        host = element;
        update(next);
      },
      update,
      destroy() {
        host.replaceChildren();
      },
    };
  });
  const embed = registry.register("embed", (): ContentRenderer => {
    let host: HTMLElement,
      context: ContentContext,
      last = "",
      frame: HTMLIFrameElement | undefined;
    function update(next: ContentContext) {
      context = next;
      const b = next.block;
      if (b.type !== "embed" || JSON.stringify(b) === last) return;
      last = JSON.stringify(b);
      frame?.remove();
      host.replaceChildren();
      const messages = next.messages ?? defaultMessages;
      const status = host.ownerDocument.createElement("p");
      status.setAttribute("role", "status");
      status.lang = messages.lang;
      const url = new URL(b.data.url),
        allowed = policy.allowedOrigins.includes(url.origin);
      status.textContent = allowed
        ? messages.embedDisabled
        : messages.embedUnauthorized;
      host.append(status);
      if (allowed) {
        const button = host.ownerDocument.createElement("button");
        button.type = "button";
        button.lang = messages.lang;
        button.textContent = messages.embedConsent(b.data.title);
        button.onclick = () => {
          if (!host.ownerDocument.defaultView!.navigator.onLine) {
            status.textContent = messages.embedOffline;
            return;
          }
          if (context.signal.aborted) return;
          frame = host.ownerDocument.createElement("iframe");
          frame.title = b.data.title;
          frame.sandbox.value = "";
          frame.referrerPolicy = "no-referrer";
          frame.setAttribute("allow", "");
          frame.setAttribute(
            "csp",
            `default-src 'none'; img-src ${url.origin}; style-src 'unsafe-inline'; font-src ${url.origin}; script-src 'none'; object-src 'none'; form-action 'none'`,
          );
          frame.src = url.href;
          host.append(frame);
          button.disabled = true;
          status.textContent = messages.embedActive;
          const revoke = host.ownerDocument.createElement("button");
          revoke.type = "button";
          revoke.lang = messages.lang;
          revoke.textContent = messages.embedRevoke;
          revoke.onclick = () => {
            frame?.remove();
            frame = undefined;
            button.disabled = false;
            revoke.remove();
            status.textContent = messages.embedRevoked;
          };
          host.append(revoke);
        };
        host.append(button);
      }
    }
    return {
      mount(element, next) {
        host = element;
        update(next);
      },
      update,
      destroy() {
        frame?.remove();
        host.replaceChildren();
      },
    };
  });
  return () => {
    link();
    embed();
  };
}
