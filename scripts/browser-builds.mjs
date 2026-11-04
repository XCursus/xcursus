import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Stable browser builds for the release matrix in CI (Linux x64): resolves
// the latest or the previous stable version, downloads and unpacks it, and
// prints the version and the executable. With GITHUB_OUTPUT set, also writes
// `version` and `path` there.
//
//   node scripts/browser-builds.mjs firefox latest|previous <dir>
//   node scripts/browser-builds.mjs chrome previous <dir>
//   node scripts/browser-builds.mjs msedge previous <dir>
//
// Sources: Mozilla's product details and release archive, Chrome for
// Testing (the Chrome build Google publishes for automation, same version
// numbers as the stable releases) and Microsoft's Edge package repository.

const [browser, which, dir] = process.argv.slice(2);
if (!browser || !which || !dir)
  throw new Error(
    "usage: browser-builds.mjs <browser> <latest|previous> <dir>",
  );
const json = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
};
const major = (version) => Number(version.split(".")[0]);
const newer = (a, b) => {
  const x = a.split(/[.-]/).map(Number),
    y = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};
const latestOf = (versions) =>
  versions.reduce((best, v) => (!best || newer(v, best) ? v : best), "");
async function download(url, file) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  await writeFile(file, Buffer.from(await response.arrayBuffer()));
}

async function firefox() {
  const versions = await json(
    "https://product-details.mozilla.org/1.0/firefox_versions.json",
  );
  let version = versions.LATEST_FIREFOX_VERSION;
  if (which === "previous") {
    const { releases } = await json(
      "https://product-details.mozilla.org/1.0/firefox.json",
    );
    version = latestOf(
      Object.values(releases)
        .filter(
          (r) =>
            ["major", "stability"].includes(r.category) &&
            major(r.version) === major(version) - 1 &&
            /^\d+(\.\d+)*$/.test(r.version),
        )
        .map((r) => r.version),
    );
  }
  const target = join(dir, `firefox-${version}`);
  await mkdir(target, { recursive: true });
  const base = `https://archive.mozilla.org/pub/firefox/releases/${version}/linux-x86_64/en-US/firefox-${version}`;
  const file = join(dir, `firefox-${version}.tar`);
  try {
    await download(`${base}.tar.xz`, file);
  } catch {
    await download(`${base}.tar.bz2`, file);
  }
  execFileSync("tar", ["-xf", file, "-C", target]);
  return { version, path: join(target, "firefox", "firefox") };
}

async function chrome() {
  const good = await json(
    "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json",
  );
  const stable = major(good.channels.Stable.version);
  const { milestones } = await json(
    "https://googlechromelabs.github.io/chrome-for-testing/latest-versions-per-milestone-with-downloads.json",
  );
  const entry = milestones[String(which === "previous" ? stable - 1 : stable)];
  const url = entry.downloads.chrome.find((d) => d.platform === "linux64").url;
  const target = join(dir, `chrome-${entry.version}`);
  await mkdir(target, { recursive: true });
  const file = join(dir, `chrome-${entry.version}.zip`);
  await download(url, file);
  execFileSync("unzip", ["-q", "-o", file, "-d", target]);
  return {
    version: entry.version,
    path: join(target, "chrome-linux64", "chrome"),
  };
}

async function msedge() {
  const repo = "https://packages.microsoft.com/repos/edge";
  const response = await fetch(
    `${repo}/dists/stable/main/binary-amd64/Packages`,
  );
  if (!response.ok) throw new Error(`Edge package index: ${response.status}`);
  const packages = (await response.text())
    .split("\n\n")
    .map((block) =>
      Object.fromEntries(
        block
          .split("\n")
          .filter((line) => /^[A-Za-z-]+: /.test(line))
          .map((line) => [
            line.slice(0, line.indexOf(":")),
            line.slice(line.indexOf(":") + 2),
          ]),
      ),
    )
    .filter((p) => p.Package === "microsoft-edge-stable");
  const newest = latestOf(packages.map((p) => p.Version));
  const wanted = which === "previous" ? major(newest) - 1 : major(newest);
  const version = latestOf(
    packages.map((p) => p.Version).filter((v) => major(v) === wanted),
  );
  const entry = packages.find((p) => p.Version === version);
  const target = join(dir, `msedge-${version}`);
  await mkdir(target, { recursive: true });
  const file = join(dir, `msedge-${version}.deb`);
  await download(`${repo}/${entry.Filename}`, file);
  execFileSync("dpkg-deb", ["-x", file, target]);
  return {
    version: version.replace(/-\d+$/, ""),
    path: join(target, "opt", "microsoft", "msedge", "msedge"),
  };
}

await mkdir(dir, { recursive: true });
const build = await { firefox, chrome, msedge }[browser]();
if (!existsSync(build.path)) throw new Error(`no executable at ${build.path}`);
console.log(`${browser} ${build.version}: ${build.path}`);
if (process.env.GITHUB_OUTPUT)
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `version=${build.version}\npath=${build.path}\n`,
  );
