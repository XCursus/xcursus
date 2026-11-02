import { useEffect, useMemo, useRef, useState } from "react";
import { firstPassItinerary } from "@xcursus/core";
import type { Diagnostic, ProjectDocument } from "@xcursus/core";
import { ARCHIVE_EXTENSION, downloadName } from "../storage/index.js";
import { Icon } from "./icons.js";

export interface HtmlExportRequest {
  /** The authoring document; the exporter removes the private notes. */
  document: ProjectDocument;
  blobs: ReadonlyMap<string, Blob>;
  lang: "en" | "it";
  /** Strict when false: content outside the offline profile refuses the export. */
  allowPartial: boolean;
}
export type HtmlExportResult =
  | {
      ok: true;
      html: string;
      status: "complete" | "partial";
      warnings: Diagnostic[];
    }
  | { ok: false; diagnostics: Diagnostic[] };
/**
 * Standalone HTML export provided by the host application. Studio passes the
 * pipeline of the command line (`@xcursus/cli/html`); without it the panel
 * only shows the commands.
 */
export type HtmlExporter = (
  request: HtmlExportRequest,
) => Promise<HtmlExportResult>;

type HtmlState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "done"; file: string; bytes: number; result: HtmlExportResult }
  | { kind: "error"; message: string };

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    link = window.document.createElement("a");
  link.href = url;
  link.download = name;
  window.document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function Findings({ items }: { items: Diagnostic[] }) {
  return (
    <ul className="export-findings">
      {items.map((d, i) => (
        <li key={`${d.code}-${d.pointer}-${i}`}>
          <code>{d.code}</code> {d.message}
          {d.pointer && <span className="export-pointer"> {d.pointer}</span>}
        </li>
      ))}
    </ul>
  );
}

function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="export-command">
      <pre>
        <code>{text}</code>
      </pre>
      <button
        type="button"
        tabIndex={0}
        aria-label={`Copy: ${text}`}
        onClick={() =>
          void navigator.clipboard
            ?.writeText(text)
            .then(() => setCopied(true))
            .catch(() => setCopied(false))
        }
      >
        <Icon name="copy" />
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/**
 * Export dialog: the standalone HTML is written here in the browser by the
 * host's exporter; PDF and WebM are captured by Chromium through the command
 * line, so the panel saves the archive and an itinerary and gives the commands.
 */
export function ExportPanel({
  document,
  blobs,
  exportHtml,
  onSaveArchive,
  onClose,
}: {
  document: ProjectDocument;
  blobs: ReadonlyMap<string, Blob>;
  exportHtml?: HtmlExporter | undefined;
  onSaveArchive: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = window.document.activeElement as HTMLElement | null;
    ref.current!.showModal();
    return () => previous?.focus({ preventScroll: true });
  }, []);
  const [lang, setLang] = useState<"en" | "it">(
    document.metadata.language.toLowerCase().startsWith("it") ? "it" : "en",
  );
  const [allowPartial, setAllowPartial] = useState(false),
    [html, setHtml] = useState<HtmlState>({ kind: "idle" }),
    [pathId, setPathId] = useState(document.defaultPathId);
  const pass = useMemo(
    () => firstPassItinerary(document, pathId),
    [document, pathId],
  );
  const title = document.metadata.title;
  const files = {
    html: downloadName(title, "html"),
    archive: downloadName(title, ARCHIVE_EXTENSION.slice(1)),
    itinerary: downloadName(title, "itinerary.json"),
    pdf: downloadName(title, "pdf"),
    video: downloadName(title, "webm"),
  };
  const sceneTitle = (nodeId: string) => {
    const path = document.paths.find((p) => p.id === pathId);
    const sceneId = path?.nodes.find((n) => n.id === nodeId)?.sceneId;
    return document.scenes.find((s) => s.id === sceneId)?.title ?? nodeId;
  };

  async function runHtml() {
    if (!exportHtml) return;
    setHtml({ kind: "busy" });
    try {
      const result = await exportHtml({ document, blobs, lang, allowPartial });
      if (result.ok) {
        const blob = new Blob([result.html], { type: "text/html" });
        download(blob, files.html);
        setHtml({ kind: "done", file: files.html, bytes: blob.size, result });
      } else setHtml({ kind: "done", file: files.html, bytes: 0, result });
    } catch (error) {
      setHtml({ kind: "error", message: String(error) });
    }
  }
  function saveItinerary() {
    if (!pass.ok) return;
    download(
      new Blob([JSON.stringify(pass.value.itinerary, null, 2) + "\n"], {
        type: "application/json",
      }),
      files.itinerary,
    );
  }

  return (
    <dialog
      ref={ref}
      className="export-panel"
      aria-labelledby="export-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <h2 id="export-title">Export</h2>
      <section aria-labelledby="export-html-title">
        <h3 id="export-html-title">Standalone HTML</h3>
        <p>
          One file that opens offline from disk: player, fonts and assets are
          embedded and private notes are removed. Embeds, plugins and remote
          resources are outside this profile.
        </p>
        {exportHtml ? (
          <>
            <div className="export-options">
              <label>
                Interface language
                <select
                  value={lang}
                  onChange={(e) => setLang(e.target.value as "en" | "it")}
                >
                  <option value="en">English</option>
                  <option value="it">Italiano</option>
                </select>
              </label>
              <label className="export-check">
                <input
                  type="checkbox"
                  checked={allowPartial}
                  onChange={(e) => setAllowPartial(e.target.checked)}
                />
                Replace unsupported content with placeholders
              </label>
            </div>
            <button
              type="button"
              tabIndex={0}
              className="primary"
              disabled={html.kind === "busy"}
              onClick={() => void runHtml()}
            >
              <Icon name="save" />
              {html.kind === "busy" ? "Exporting…" : "Download HTML"}
            </button>
            <div role="status" className="export-status">
              {html.kind === "error" && (
                <p className="export-error">
                  The HTML could not be written: {html.message}
                </p>
              )}
              {html.kind === "done" && !html.result.ok && (
                <>
                  <p className="export-error">
                    Not exported: {html.result.diagnostics.length} item
                    {html.result.diagnostics.length === 1
                      ? " is"
                      : "s are"}{" "}
                    outside the offline profile. Fix them, or allow
                    placeholders.
                  </p>
                  <Findings items={html.result.diagnostics} />
                </>
              )}
              {html.kind === "done" && html.result.ok && (
                <>
                  <p>
                    {html.file} downloaded, {size(html.bytes)},{" "}
                    {html.result.status === "complete"
                      ? "complete."
                      : "partial: placeholders replace unsupported content."}
                  </p>
                  {!!html.result.warnings.length && (
                    <Findings items={html.result.warnings} />
                  )}
                </>
              )}
            </div>
          </>
        ) : (
          <>
            <p>This Studio does not write HTML itself. Use the command line:</p>
            <Command
              text={`xcursus export html ${files.archive} --out ${files.html}`}
            />
          </>
        )}
      </section>
      <section aria-labelledby="export-capture-title">
        <h3 id="export-capture-title">PDF and video</h3>
        <p>
          PDF pages and WebM frames are captured by Chromium through the XCursus
          command line, from the archive and an itinerary: the visits to print
          or film, in order.
        </p>
        {document.paths.length > 1 && (
          <label>
            Path
            <select
              value={pathId ?? ""}
              onChange={(e) => setPathId(e.target.value)}
            >
              {document.paths.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {pass.ok ? (
          <>
            <ol className="export-visits" aria-label="Itinerary visits">
              {pass.value.itinerary.visits.map((v, i) => (
                <li key={`${v.nodeId}-${i}`}>{sceneTitle(v.nodeId)}</li>
              ))}
            </ol>
            {pass.value.stoppedBefore && (
              <p>
                The path returns to “{sceneTitle(pass.value.stoppedBefore)}”:
                the itinerary stops before it. To repeat visits, add them to the
                file.
              </p>
            )}
          </>
        ) : (
          <p className="export-error">
            No itinerary can be proposed: {pass.diagnostics[0]?.message}. Write
            the itinerary file by hand (see the distribution guide).
          </p>
        )}
        <div className="export-actions">
          <button type="button" tabIndex={0} onClick={onSaveArchive}>
            <Icon name="archive" />
            Save archive
          </button>
          <button
            type="button"
            tabIndex={0}
            disabled={!pass.ok}
            onClick={saveItinerary}
          >
            <Icon name="save" />
            Download itinerary
          </button>
        </div>
        <Command
          text={`xcursus export pdf ${files.archive} --itinerary ${files.itinerary} --out ${files.pdf}`}
        />
        <Command
          text={`xcursus export video ${files.archive} --itinerary ${files.itinerary} --fps 30 --out ${files.video}`}
        />
        <p className="export-note">
          Requires the XCursus command line and Chromium for Playwright 1.64.1 (
          <code>npx playwright@1.64.1 install chromium</code>); video also needs{" "}
          <code>ffmpeg</code> and <code>ffprobe</code> with a WebM encoder. In a
          checkout of the repository, run the commands as{" "}
          <code>pnpm xcursus …</code> after <code>pnpm build</code>.
        </p>
      </section>
      <div className="dialog-actions">
        <button type="button" tabIndex={0} autoFocus onClick={onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
}
