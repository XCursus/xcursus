import { spawn } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

// Servers of the release checks: the production previews of the browser
// suites, and static files on a fixed local port that touch devices reach.

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const up = async (url) => {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
};

/**
 * `vite preview` of a built app on the port of `origin`, as in the browser
 * suites; reused when already running. Returns a handle to stop it.
 */
export async function preview(pkg, origin, root) {
  if (await up(origin)) return undefined;
  const child = spawn(
    "pnpm",
    [
      "--filter",
      pkg,
      "exec",
      "vite",
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      new URL(origin).port,
      "--strictPort",
    ],
    {
      cwd: root,
      stdio: "ignore",
      detached: process.platform !== "win32",
      shell: process.platform === "win32",
    },
  );
  for (let i = 0; !(await up(origin)); i++) {
    if (i > 300) throw new Error(`${pkg} preview did not start`);
    await delay(200);
  }
  return {
    kill() {
      try {
        if (process.platform === "win32")
          spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
        else process.kill(-child.pid);
      } catch {
        /* already gone */
      }
    },
  };
}

/** Static files of `dir` on the port of `origin`. */
export function serveDir(dir, origin) {
  const types = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".json": "application/json",
  };
  const server = createServer((request, response) => {
    const path = normalize(
      decodeURIComponent(new URL(request.url, "http://x").pathname),
    );
    const file = join(dir, path);
    if (
      !file.startsWith(dir) ||
      !existsSync(file) ||
      statSync(file).isDirectory()
    ) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader(
      "content-type",
      types[extname(file)] ?? "application/octet-stream",
    );
    createReadStream(file).pipe(response);
  });
  return new Promise((resolve) =>
    server.listen(Number(new URL(origin).port), "127.0.0.1", () =>
      resolve({ kill: () => server.close() }),
    ),
  );
}
