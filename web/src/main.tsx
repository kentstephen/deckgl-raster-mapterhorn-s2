import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import TerrainSpike from "./spike/TerrainSpike";
import { installConsoleCapture } from "./consoleCapture";

// Patch console.error/warn into the in-panel log store before anything mounts,
// so even early startup errors are copyable from the app (not just DevTools).
installConsoleCapture();

// `?spike=terrain` renders the throwaway Stage-0 spike instead of the app.
const isSpike = new URLSearchParams(location.search).get("spike") === "terrain";

createRoot(document.getElementById("root")!).render(
  <StrictMode>{isSpike ? <TerrainSpike /> : <App />}</StrictMode>,
);
