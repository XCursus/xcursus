import type { Asset, ProjectDocument } from "@xcursus/core";
export function assetKey(asset: Asset) {
  return `${asset.id}:${asset.sha256 ?? `${asset.path}:${asset.byteLength}`}`;
}
/** Old Blobs stay reachable by undo/recovery metadata, not just the current asset ID. */
export function projectBlobs(
  document: ProjectDocument,
  library: ReadonlyMap<string, Blob>,
): Map<string, Blob> {
  const result = new Map<string, Blob>();
  for (const asset of document.assets) {
    const blob = library.get(assetKey(asset));
    if (blob) result.set(asset.id, blob);
  }
  return result;
}
export function mergeBlobs(
  library: ReadonlyMap<string, Blob>,
  document: ProjectDocument,
  blobs: ReadonlyMap<string, Blob>,
): Map<string, Blob> {
  const next = new Map(library);
  for (const a of document.assets) {
    const blob = blobs.get(a.id);
    if (blob) next.set(assetKey(a), blob);
  }
  return next;
}
