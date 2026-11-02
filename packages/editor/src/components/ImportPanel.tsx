import { useEffect, useRef, useState } from "react";
import type { Diagnostic, ProjectDocument } from "@xcursus/core";
import { Icon } from "./icons.js";

export interface ImpressImportRequest {
  html: string;
  fileName: string;
  /** Files chosen with the HTML, by name; nothing else is read. */
  resources: ReadonlyMap<string, Uint8Array>;
  /** Upstream build to interpret the attributes; absent when the author is not sure. */
  profile?: "bundle" | "core";
}
export interface ImpressImportDiagnostic extends Diagnostic {
  source?: { step?: string; line?: number; column?: number };
}
export type ImpressImportResult =
  | {
      ok: true;
      document: ProjectDocument;
      blobs: Map<string, Blob>;
      diagnostics: ImpressImportDiagnostic[];
      profile: "bundle" | "core";
      profileExplicit: boolean;
      /** References that did not become assets, with their status. */
      unresolved: Array<{ reference: string; status: string }>;
    }
  | { ok: false; diagnostics: ImpressImportDiagnostic[] };
/**
 * impress.js import provided by the host application. Studio passes
 * `@xcursus/impress-compat`; without it the toolbar has no import entry.
 */
export type ImpressImporter = (
  request: ImpressImportRequest,
) => Promise<ImpressImportResult>;

type State =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "review"; file: string; result: ImpressImportResult }
  | { kind: "error"; message: string };

const SEVERITY = { error: 0, warning: 1, info: 2 } as const;
const HTML_LIMIT = 10 * 1024 * 1024,
  FILE_LIMIT = 50 * 1024 * 1024,
  TOTAL_LIMIT = 200 * 1024 * 1024;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * impress.js import with a review step: the HTML and the files chosen with it
 * are converted in memory; the candidate replaces the open document only
 * when the author opens it after reading the findings, and only after the
 * usual confirmation when there are unsaved changes.
 */
export function ImportPanel({
  importImpress,
  onOpen,
  onClose,
}: {
  importImpress: ImpressImporter;
  onOpen: (result: Extract<ImpressImportResult, { ok: true }>) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = window.document.activeElement as HTMLElement | null;
    ref.current!.showModal();
    return () => previous?.focus({ preventScroll: true });
  }, []);
  const [html, setHtml] = useState<File | null>(null),
    [resources, setResources] = useState<File[]>([]),
    [profile, setProfile] = useState<"" | "bundle" | "core">(""),
    [state, setState] = useState<State>({ kind: "idle" });

  async function convert() {
    if (!html) return;
    // The same limits as the command line, checked before anything is read.
    const total = resources.reduce((sum, f) => sum + f.size, 0);
    const limit =
      html.size > HTML_LIMIT
        ? "The HTML file exceeds 10 MiB."
        : resources.some((f) => f.size > FILE_LIMIT)
          ? "A resource exceeds 50 MiB."
          : total > TOTAL_LIMIT
            ? "The resources exceed 200 MiB in total."
            : "";
    if (limit) {
      setState({ kind: "error", message: limit });
      return;
    }
    setState({ kind: "busy" });
    try {
      const files = new Map<string, Uint8Array>();
      for (const file of resources)
        files.set(
          file.name.normalize("NFC"),
          new Uint8Array(await file.arrayBuffer()),
        );
      const result = await importImpress({
        html: await html.text(),
        fileName: html.name,
        resources: files,
        ...(profile ? { profile } : {}),
      });
      setState({ kind: "review", file: html.name, result });
    } catch (error) {
      setState({ kind: "error", message: String(error) });
    }
  }
  const review = state.kind === "review" ? state.result : null;
  const findings = review
    ? [...review.diagnostics].sort(
        (a, b) => SEVERITY[a.severity] - SEVERITY[b.severity],
      )
    : [];
  const count = (severity: Diagnostic["severity"]) =>
    findings.filter((d) => d.severity === severity).length;

  return (
    <dialog
      ref={ref}
      className="export-panel import-panel"
      aria-labelledby="import-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <h2 id="import-title">Import impress.js</h2>
      <section aria-labelledby="import-source-title">
        <h3 id="import-source-title">Presentation</h3>
        <p>
          Choose the HTML file and, if you have them, the images, video and
          audio it uses. The file is read as data: no script runs, no stylesheet
          applies and nothing is downloaded. The open document does not change
          until you open the candidate.
        </p>
        <div className="export-options">
          <label>
            HTML file
            <input
              type="file"
              accept=".html,.htm,text/html"
              aria-label="impress.js HTML file"
              onChange={(e) => {
                setHtml(e.target.files?.[0] ?? null);
                setState({ kind: "idle" });
              }}
            />
          </label>
          <label>
            Images and media (optional)
            <input
              type="file"
              multiple
              accept="image/*,video/*,audio/*,.vtt"
              aria-label="Images and media of the presentation"
              onChange={(e) => {
                setResources([...(e.target.files ?? [])]);
                setState({ kind: "idle" });
              }}
            />
          </label>
          <label>
            impress.js build
            <select
              value={profile}
              onChange={(e) => {
                setProfile(e.target.value as typeof profile);
                setState({ kind: "idle" });
              }}
            >
              <option value="">Not sure (release bundle, with warnings)</option>
              <option value="bundle">
                js/impress.js of 2.0.0 (with plugins)
              </option>
              <option value="core">src/impress.js only (no plugins)</option>
            </select>
          </label>
        </div>
        <button
          type="button"
          tabIndex={0}
          className="primary"
          disabled={!html || state.kind === "busy"}
          onClick={() => void convert()}
        >
          <Icon name="import" />
          {state.kind === "busy" ? "Converting…" : "Convert"}
        </button>
      </section>
      <section aria-labelledby="import-review-title" aria-live="polite">
        <h3 id="import-review-title">Review</h3>
        {state.kind === "idle" && (
          <p className="export-note">
            The candidate and what it does not carry over appear here.
          </p>
        )}
        {state.kind === "error" && (
          <p className="export-error">
            The files could not be read: {state.message}
          </p>
        )}
        {review && !review.ok && (
          <>
            <p className="export-error">
              {state.kind === "review" && state.file} is not an importable
              impress.js presentation.
            </p>
            <Findings items={findings} />
          </>
        )}
        {review?.ok && (
          <>
            <p>
              {plural(review.document.scenes.length, "scene")},{" "}
              {review.document.paths[0]?.nodes.length ?? 0} on the path,{" "}
              {plural(review.document.assets.length, "asset")}.{" "}
              {plural(count("warning"), "warning")} and{" "}
              {plural(count("info"), "note")}. Profile:{" "}
              {review.profile === "bundle" ? "release bundle" : "core only"}
              {review.profileExplicit ? "" : " (assumed)"}.
            </p>
            {!!review.unresolved.length && (
              <p className="export-error">
                Not imported:{" "}
                {review.unresolved
                  .map((r) => `${r.reference} (${r.status})`)
                  .join(", ")}
                .
              </p>
            )}
            <Findings items={findings} />
            <p className="export-note">
              This is an essential import, not full impress.js compatibility:
              CSS, scripts, plugins and timing are not reproduced.
            </p>
          </>
        )}
      </section>
      <div className="dialog-actions">
        <button type="button" tabIndex={0} autoFocus onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          tabIndex={0}
          className="primary"
          disabled={!review?.ok}
          onClick={() => review?.ok && onOpen(review)}
        >
          Open candidate
        </button>
      </div>
    </dialog>
  );
}

function Findings({ items }: { items: ImpressImportDiagnostic[] }) {
  return (
    // The list scrolls, so it takes focus for keyboard scrolling.
    <ul
      className="export-findings import-findings"
      aria-label="Findings"
      tabIndex={0}
    >
      {items.map((d, i) => (
        <li key={`${d.code}-${d.pointer}-${i}`} data-severity={d.severity}>
          <span className="import-severity">{d.severity}</span>{" "}
          <code>{d.code}</code> {d.message}
          {(d.source?.step || d.source?.line) && (
            <span className="export-pointer">
              {" "}
              {d.source.step ? `step ${d.source.step}` : ""}
              {d.source.line ? ` line ${d.source.line}` : ""}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
