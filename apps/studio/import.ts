// impress.js import from Studio (1.0): the same importer as
// `xcursus convert impress`, loaded on first use; the files the author
// chose are matched by name because a file picker gives no folders.
import type { ImpressImporter } from "@xcursus/editor";

export const importImpress: ImpressImporter = async (request) => {
  const { importImpress: convert } = await import("@xcursus/impress-compat");
  const result = convert(request.html, {
    ...(request.profile ? { profile: request.profile } : {}),
    resources: request.resources,
    matchBasename: true,
  });
  if (!result.ok) return { ok: false, diagnostics: result.diagnostics };
  const { document, files, diagnostics, resources, profile, profileExplicit } =
    result.value;
  const blobs = new Map<string, Blob>();
  for (const asset of document.assets)
    blobs.set(
      asset.id,
      new Blob([files.get(asset.id)! as Uint8Array<ArrayBuffer>], {
        type: asset.mime,
      }),
    );
  return {
    ok: true,
    document,
    blobs,
    diagnostics,
    profile,
    profileExplicit,
    unresolved: resources
      .filter((r) => r.status !== "asset" && r.status !== "ignored")
      .map(({ reference, status }) => ({ reference, status })),
  };
};
