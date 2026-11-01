// Entry of the classic-script build: global `XCursus`, same source as the ESM build.
import "./style.css";
export * from "./index.js";
export {
  validateDocument,
  publicDocument,
  planCapture,
  validateItinerary,
  sampleCapture,
} from "@xcursus/core";
