import { importImpress } from "@xcursus/impress-compat";
import type { ImportCandidate } from "@xcursus/impress-compat";

/** A minimal standards-mode page with an impress.js root around `steps`. */
export function deck(steps: string, root = "", head = "") {
  return `<!doctype html><html lang="en"><head><title>Fixture</title>${head}</head><body><div id="impress"${root}>${steps}</div></body></html>`;
}
export function candidate(
  html: string,
  options: Parameters<typeof importImpress>[1] = { profile: "core" },
): ImportCandidate {
  const result = importImpress(html, options);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.value;
}
