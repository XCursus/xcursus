import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Evidence from browser runs goes to the ignored test-results tree, never to
// tracked files.
export const evidenceRoot = join(
  fileURLToPath(new URL("../..", import.meta.url)),
  "test-results",
  "evidence",
);
export const evidencePath = (name: string) => join(evidenceRoot, name);
export async function writeEvidence(name: string, data: unknown) {
  const path = evidencePath(name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n",
  );
}
/** Studio exposes window.studio only in development or with this explicit flag. */
export const studioURL = "http://127.0.0.1:4174/?studio-debug";
