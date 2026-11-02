// Public API of @xcursus/editor, delimited since 0.6: the Studio component,
// the command store and the commands an integrator applies through it, local
// recovery storage. Components, helpers and storage internals stay private.
export { Studio } from "./components/Studio.js";
export type { StudioProps } from "./components/Studio.js";
export type {
  HtmlExporter,
  HtmlExportRequest,
  HtmlExportResult,
} from "./components/ExportPanel.js";
export type {
  ImpressImporter,
  ImpressImportRequest,
  ImpressImportResult,
  ImpressImportDiagnostic,
} from "./components/ImportPanel.js";
export { EditorStore } from "./store/index.js";
export type { EditorSession, MapCamera } from "./store/index.js";
export {
  emptyProject,
  createScene,
  editScene,
  deleteScene,
  deleteImpact,
  reparent,
  createPath,
  editPath,
  deletePath,
  createNode,
  editNode,
  connectNodes,
  editEdge,
  removeGraphItem,
  setFrames,
  setBlockStyle,
  setAppearance,
  convertToCanvas,
  convertToFlow,
  moveInReadingOrder,
  editTheme,
} from "./commands/index.js";
export type { DocumentEdit } from "./commands/index.js";
export {
  RecoveryRepository,
  Autosave,
  StorageConflict,
  StorageVersionError,
  DATABASE_NAME,
  DATABASE_VERSION,
} from "./storage/index.js";
export type { Revision } from "./storage/index.js";
