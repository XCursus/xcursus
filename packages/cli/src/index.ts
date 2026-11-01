import { toolVersion } from "./assemble.js";
import {
  build,
  exportHtml,
  exportPdf,
  exportVideo,
  pack,
  validate,
} from "./commands.js";
import type { Report } from "./commands.js";
import { CliError, EXIT } from "./io.js";
import { profiles } from "./profile.js";
export { CliError, EXIT } from "./io.js";
export type { ExportManifest } from "./commands.js";

export const help = `xcursus ${toolVersion} — validate, build and export XCursus projects

Usage:
  xcursus validate <project> [--json]
  xcursus pack <project> --out <file.xcursus> [--overwrite]
  xcursus build <project> --out <directory> [--overwrite] [--allow-partial]
  xcursus export html <project> --out <file.html> [--overwrite] [--allow-partial]
  xcursus export pdf <project> --itinerary <file.json> --out <file.pdf>
  xcursus export video <project> --itinerary <file.json> --fps 30 --out <file.webm>

<project> is a project JSON (assets resolved inside its directory), a
.xcursus archive or a legacy .spatialdeck archive (read only). Documents of
earlier schema versions are migrated in memory; the input is never modified.
pack writes the migrated project, notes and assets included, as a .xcursus
archive. Exports are strict: content outside the format profile
fails with exit 1; --allow-partial writes placeholders and a manifest with
status "partial". Every output gets a manifest (<out>.manifest.json, or
export-manifest.json inside a build). Private notes are never exported.

Options:
  --out <path>        output file or directory (refused if it exists)
  --overwrite         replace an existing output (a build directory only if
                      it holds a previous export-manifest.json)
  --allow-partial     placeholders for unsupported content, status "partial"
  --itinerary <file>  {"pathId","visits":[{"nodeId","edgeIdToNext"?}]}, max 500
  --fps <n>           video frame rate, integer 1..120 (default 30)
  --reduced-motion    plan PDF/video without transitions
  --lang en|it        player interface texts (default from metadata.language)
  --json              machine-readable validation report
  --frames <dir>      video: also copy the captured PNG frames into an empty directory
  -h, --help          this help;  -v, --version  tool version

Profiles:
  html/build  ${profiles.html.supported.join(", ")}
  pdf         ${profiles.pdf.supported.join(", ")}; ${profiles.pdf.static.join(", ")}
  video       ${profiles.video.supported.join(", ")} and camera transitions
  excluded    embeds, plugins and remote resources everywhere; audio, video
              and cues in video; playback and interactions in PDF

Requirements: Node 24; PDF and video need Chromium for Playwright 1.64.1
(install explicitly: npx playwright@1.64.1 install chromium); video also
needs ffmpeg and ffprobe with a WebM encoder (VP9 preferred). Nothing is
installed automatically.

Exit codes: 0 success (warnings allowed), 1 invalid project, itinerary or
capability, 2 missing environment (Chromium, FFmpeg), 3 write or export failure.`;

interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
}
const valued = new Set(["--out", "--itinerary", "--fps", "--lang", "--frames"]);
const switches = new Set([
  "--overwrite",
  "--allow-partial",
  "--reduced-motion",
  "--json",
  "--help",
  "-h",
  "--version",
  "-v",
]);
function parse(argv: string[]): Parsed {
  const positional: string[] = [],
    flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("-")) {
      const [name, inline] = arg.includes("=")
        ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
        : [arg, undefined];
      if (flags.has(name!))
        throw new CliError(EXIT.data, `Repeated option: ${name}`);
      if (valued.has(name!)) {
        const value = inline ?? argv[++i];
        if (value === undefined || value === "")
          throw new CliError(EXIT.data, `${name} needs a value`);
        flags.set(name!, value);
      } else if (switches.has(name!) && inline === undefined)
        flags.set(name!, true);
      else throw new CliError(EXIT.data, `Unknown option: ${arg}`);
    } else positional.push(arg);
  }
  return { positional, flags };
}
const text = (p: Parsed, name: string) => {
  const v = p.flags.get(name);
  return typeof v === "string" ? v : undefined;
};
function required(p: Parsed, name: string) {
  const v = text(p, name);
  if (!v) throw new CliError(EXIT.data, `Missing ${name} <value>`);
  return v;
}
function only(p: Parsed, allowed: string[]) {
  for (const name of p.flags.keys())
    if (!allowed.includes(name))
      throw new CliError(
        EXIT.data,
        `Option ${name} does not apply to this command`,
      );
}

export interface Io extends Report {
  out(text: string): void;
}
/** Runs one command; returns the exit code and never calls process.exit. */
export async function run(argv: string[], io: Io): Promise<number> {
  try {
    const p = parse(argv);
    if (p.flags.has("--version") || p.flags.has("-v")) {
      io.out(toolVersion);
      return EXIT.ok;
    }
    if (
      p.flags.has("--help") ||
      p.flags.has("-h") ||
      p.positional.length === 0
    ) {
      io.out(help);
      return EXIT.ok;
    }
    const [command, ...rest] = p.positional;
    const common = () => {
      const lang = text(p, "--lang");
      if (lang !== undefined && lang !== "en" && lang !== "it")
        throw new CliError(EXIT.data, "--lang must be en or it");
      return {
        out: required(p, "--out"),
        overwrite: p.flags.has("--overwrite"),
        allowPartial: p.flags.has("--allow-partial"),
        ...(lang ? { lang: lang as "en" | "it" } : {}),
      };
    };
    const one = (args: string[]) => {
      if (args.length !== 1)
        throw new CliError(EXIT.data, "Expected exactly one <project>");
      return args[0]!;
    };
    switch (command) {
      case "validate": {
        only(p, ["--json"]);
        const input = one(rest);
        let checked: Awaited<ReturnType<typeof validate>>;
        try {
          checked = await validate(input);
        } catch (error) {
          // A rejected document still gets a machine-readable report.
          if (
            !p.flags.has("--json") ||
            !(error instanceof CliError) ||
            error.exitCode !== EXIT.data
          )
            throw error;
          io.out(
            JSON.stringify(
              {
                ok: false,
                error: error.message,
                diagnostics: error.diagnostics,
                resources: [],
              },
              null,
              2,
            ),
          );
          return EXIT.data;
        }
        const { project, diagnostics, ok } = checked;
        if (p.flags.has("--json"))
          io.out(
            JSON.stringify(
              {
                ok,
                schemaVersion: project.document.schemaVersion,
                sourceSchemaVersion: project.sourceSchemaVersion,
                kind: project.kind,
                ...(project.archiveFormat
                  ? { archiveFormat: project.archiveFormat }
                  : {}),
                diagnostics,
                resources: project.resources.map(
                  ({ id, path, mime, byteLength, sha256, status }) => ({
                    id,
                    path,
                    mime,
                    byteLength,
                    sha256,
                    status,
                  }),
                ),
              },
              null,
              2,
            ),
          );
        else {
          for (const d of diagnostics)
            io.out(`${d.severity} ${d.code} ${d.pointer} ${d.message}`);
          io.out(
            ok
              ? `valid ${project.document.schemaVersion} (${project.resources.length} resources verified)`
              : "invalid",
          );
          if (project.archiveFormat === "legacy")
            io.out(
              "note: legacy .spatialdeck archive; `xcursus pack` writes it as .xcursus",
            );
        }
        return ok ? EXIT.ok : EXIT.data;
      }
      case "pack": {
        only(p, ["--out", "--overwrite"]);
        await pack(
          one(rest),
          { out: required(p, "--out"), overwrite: p.flags.has("--overwrite") },
          io,
        );
        return EXIT.ok;
      }
      case "build": {
        only(p, ["--out", "--overwrite", "--allow-partial", "--lang"]);
        await build(one(rest), common(), io);
        return EXIT.ok;
      }
      case "export": {
        const [format, ...args] = rest;
        if (format === "html") {
          only(p, ["--out", "--overwrite", "--allow-partial", "--lang"]);
          await exportHtml(one(args), common(), io);
          return EXIT.ok;
        }
        if (format === "pdf") {
          only(p, [
            "--out",
            "--overwrite",
            "--allow-partial",
            "--lang",
            "--itinerary",
            "--reduced-motion",
          ]);
          await exportPdf(
            one(args),
            required(p, "--itinerary"),
            { ...common(), reducedMotion: p.flags.has("--reduced-motion") },
            io,
          );
          return EXIT.ok;
        }
        if (format === "video") {
          only(p, [
            "--out",
            "--overwrite",
            "--allow-partial",
            "--lang",
            "--itinerary",
            "--reduced-motion",
            "--fps",
            "--frames",
          ]);
          const fpsText = text(p, "--fps") ?? "30";
          if (!/^\d{1,3}$/.test(fpsText))
            throw new CliError(
              EXIT.data,
              "--fps must be an integer between 1 and 120",
            );
          const frames = text(p, "--frames");
          await exportVideo(
            one(args),
            required(p, "--itinerary"),
            {
              ...common(),
              reducedMotion: p.flags.has("--reduced-motion"),
              fps: Number(fpsText),
              ...(frames ? { framesDir: frames } : {}),
            },
            io,
          );
          return EXIT.ok;
        }
        throw new CliError(
          EXIT.data,
          `Unknown export format: ${format ?? "(none)"}. Use html, pdf or video.`,
        );
      }
      default:
        throw new CliError(
          EXIT.data,
          `Unknown command: ${command}. See xcursus --help.`,
        );
    }
  } catch (error) {
    if (error instanceof CliError) {
      io.warn(`error: ${error.message}`);
      for (const d of error.diagnostics)
        io.warn(`  ${d.code} ${d.pointer} ${d.message}`);
      return error.exitCode;
    }
    io.warn(`error: ${String(error)}`);
    return EXIT.output;
  }
}
