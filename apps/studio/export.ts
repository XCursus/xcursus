// Standalone HTML from Studio (0.6): the pipeline of `xcursus export html`,
// loaded on first use with the export kit written at build time, so the
// file Studio downloads is the one the command line writes.
import type { HtmlExporter } from "@xcursus/editor";
import type { ExportKit } from "@xcursus/cli/html";

let kit: Promise<ExportKit> | undefined;
function loadKit() {
  kit ??= fetch(new URL("export-kit.json", document.baseURI)).then(
    async (response) => {
      if (!response.ok)
        throw new Error(
          `Export runtime unavailable (HTTP ${response.status}); build the CLI first`,
        );
      return (await response.json()) as ExportKit;
    },
  );
  // A failed load is retried on the next export.
  kit.catch(() => (kit = undefined));
  return kit;
}

export const exportHtml: HtmlExporter = async (request) => {
  const [{ standaloneHtml, verifyResources }, exportKit] = await Promise.all([
    import("@xcursus/cli/html"),
    loadKit(),
  ]);
  const verified = await verifyResources(request.document, request.blobs);
  const result = await standaloneHtml({
    document: request.document,
    resources: verified.resources,
    blobs: verified.blobs,
    kit: exportKit,
    lang: request.lang,
    allowPartial: request.allowPartial,
    generator: `XCursus Studio ${exportKit.version}`,
  });
  return result.ok
    ? {
        ok: true,
        html: result.html,
        status: result.status,
        warnings: result.warnings,
      }
    : { ok: false, diagnostics: result.analysis.blocking };
};
