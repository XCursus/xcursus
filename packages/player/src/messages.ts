import type { AssetErrorCode } from "./assets/index.js";
/**
 * Every user-visible string of the player and of the builtin renderers.
 * Hosts replace any subset through `PlayerOptions.messages`; the defaults are
 * English (from 0.6) and `italianMessages` is the complete alternative. Functions receive document data as plain text and must return
 * plain text: the player always inserts messages with textContent.
 */
export interface PlayerMessages {
  /** BCP 47 language of these strings, applied as `lang` to player controls and status texts. */
  lang: string;
  /** Accessible name of the player when the document has no title. */
  presentation: string;
  outline: string;
  reduceMotion: string;
  overview: string;
  camera: string;
  sceneView: string;
  panLeft: string;
  panRight: string;
  panUp: string;
  panDown: string;
  zoomIn: string;
  zoomOut: string;
  enableMedia: string;
  stage: string;
  emptyPath: string;
  emptyPresentation: string;
  choices: string;
  choicePrompt: string;
  choiceDisabled(label: string, reason: string): string;
  /** `target` is the title of the destination scene (its node ID when untitled). */
  visitLimit(limit: number, target: string): string;
  contentUnavailable(type: string): string;
  contentError(detail: string): string;
  pluginContent(pluginId: string): string;
  formulaInvalid(text: string): string;
  mediaLoading: string;
  mediaPlay(label: string): string;
  mediaRejected: string;
  mediaDecodeError: string;
  imageDecodeError: string;
  assetMissing(assetId: string): string;
  assetInvalid(
    assetId: string,
    reason: Exclude<AssetErrorCode, "missing" | "aborted">,
  ): string;
  embedUnauthorized: string;
  embedDisabled: string;
  embedConsent(title: string): string;
  embedOffline: string;
  embedActive: string;
  embedRevoke: string;
  embedRevoked: string;
  pluginUnavailable(pluginId: string, dataVersion: string): string;
  pluginOffline: string;
}
/** English defaults (G0 decision 3, from 0.6). */
export const defaultMessages: Readonly<PlayerMessages> = Object.freeze({
  lang: "en",
  presentation: "XCursus",
  outline: "Text view",
  reduceMotion: "Reduce motion",
  overview: "Overview",
  camera: "Camera",
  sceneView: "Scene view",
  panLeft: "Pan left",
  panRight: "Pan right",
  panUp: "Pan up",
  panDown: "Pan down",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  enableMedia: "Enable media",
  stage: "Spatial presentation",
  emptyPath: "No scene in the selected path.",
  emptyPresentation: "Empty presentation",
  choices: "Path choices",
  choicePrompt: "Choose the path",
  choiceDisabled: (label: string, reason: string) => `${label} — ${reason}`,
  visitLimit: (limit: number, target: string) =>
    `Limit of ${limit} ${limit === 1 ? "visit" : "visits"} reached for ${target}`,
  contentUnavailable: (type: string) => `Content unavailable (${type})`,
  contentError: (detail: string) => `Content error: ${detail}`,
  pluginContent: (pluginId: string) => `Plugin: ${pluginId}`,
  formulaInvalid: (text: string) => `Invalid formula: ${text}`,
  mediaLoading: "Loading local resource…",
  mediaPlay: (label: string) => `Play ${label}`,
  mediaRejected:
    "Playback refused or codec not supported. Use Play or link a compatible file.",
  mediaDecodeError:
    "Media cannot be decoded or the codec is not supported. Link a compatible file.",
  imageDecodeError: "Image cannot be decoded. Link a compatible file.",
  assetMissing: (assetId: string) =>
    `Missing resource: ${assetId}. Link the file in the Resources panel.`,
  assetInvalid: (assetId: string, reason: "size" | "signature" | "digest") =>
    `Invalid resource: ${assetId}. ${
      reason === "size"
        ? "The size does not match the registry."
        : reason === "digest"
          ? "Wrong digest."
          : "MIME type and signature do not match."
    } Link a compatible file.`,
  embedUnauthorized:
    "Embed disabled: origin not authorized by the host. Not available offline.",
  embedDisabled: "External web content disabled. Requires network and consent.",
  embedConsent: (title: string) => `Allow embed: ${title}`,
  embedOffline: "Embed not available offline.",
  embedActive: "Isolated embed, scripts disabled. Remove consent to close it.",
  embedRevoke: "Remove embed consent",
  embedRevoked: "Embed disabled.",
  pluginUnavailable: (pluginId: string, dataVersion: string) =>
    `Plugin missing or incompatible: ${pluginId} (${dataVersion}). Data preserved.`,
  pluginOffline: "Plugin not available offline; data preserved.",
});
/** The Italian set that was the default until 0.5; hosts with an Italian interface pass it as `messages`. */
export const italianMessages: Readonly<PlayerMessages> = Object.freeze({
  lang: "it",
  presentation: "XCursus",
  outline: "Vista testuale",
  reduceMotion: "Riduci movimento",
  overview: "Panoramica",
  camera: "Camera",
  sceneView: "Vista scena",
  panLeft: "Pan sinistra",
  panRight: "Pan destra",
  panUp: "Pan alto",
  panDown: "Pan basso",
  zoomIn: "Zoom +",
  zoomOut: "Zoom −",
  enableMedia: "Abilita media",
  stage: "Presentazione spaziale",
  emptyPath: "Nessuna scena nel percorso selezionato.",
  emptyPresentation: "Presentazione vuota",
  choices: "Scelte del percorso",
  choicePrompt: "Scegli il percorso",
  choiceDisabled: (label: string, reason: string) => `${label} — ${reason}`,
  visitLimit: (limit: number, target: string) =>
    `Limite di ${limit} ${limit === 1 ? "visita" : "visite"} raggiunto per ${target}`,
  contentUnavailable: (type: string) => `Contenuto non disponibile (${type})`,
  contentError: (detail: string) => `Errore contenuto: ${detail}`,
  pluginContent: (pluginId: string) => `Plugin: ${pluginId}`,
  formulaInvalid: (text: string) => `Formula non valida: ${text}`,
  mediaLoading: "Caricamento risorsa locale…",
  mediaPlay: (label: string) => `Riproduci ${label}`,
  mediaRejected:
    "Riproduzione rifiutata o codec non supportato. Usa Riproduci o associa un file compatibile.",
  mediaDecodeError:
    "Media non decodificabile o codec non supportato. Associa un file compatibile.",
  imageDecodeError: "Immagine non decodificabile. Associa un file compatibile.",
  assetMissing: (assetId: string) =>
    `Risorsa mancante: ${assetId}. Associa il file nel pannello Risorse.`,
  assetInvalid: (assetId: string, reason: "size" | "signature" | "digest") =>
    `Risorsa non valida: ${assetId}. ${
      reason === "size"
        ? "La dimensione non corrisponde al registro."
        : reason === "digest"
          ? "Digest errato."
          : "MIME o firma incoerenti."
    } Associa un file compatibile.`,
  embedUnauthorized:
    "Embed disattivato: origine non autorizzata dall’host. Offline non disponibile.",
  embedDisabled: "Contenuto web esterno disattivato. Richiede rete e consenso.",
  embedConsent: (title: string) => `Consenti embed: ${title}`,
  embedOffline: "Embed non disponibile offline.",
  embedActive:
    "Embed isolato, script disabilitati. Rimuovi consenso per chiuderlo.",
  embedRevoke: "Rimuovi consenso embed",
  embedRevoked: "Embed disattivato.",
  pluginUnavailable: (pluginId: string, dataVersion: string) =>
    `Plugin assente o incompatibile: ${pluginId} (${dataVersion}). Dati conservati.`,
  pluginOffline: "Plugin non disponibile offline; dati conservati.",
});
/** Known keys only, so a host object cannot add or shadow unrelated properties. */
export function resolveMessages(
  overrides: Partial<PlayerMessages> = {},
): Readonly<PlayerMessages> {
  const merged: Record<string, unknown> = { ...defaultMessages };
  for (const [key, value] of Object.entries(overrides))
    if (
      value !== undefined &&
      Object.hasOwn(defaultMessages, key) &&
      typeof value === typeof defaultMessages[key as keyof PlayerMessages]
    )
      merged[key] = value;
  return Object.freeze(merged as unknown as PlayerMessages);
}
