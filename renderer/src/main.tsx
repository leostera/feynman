import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { buildIndex, loadModel } from "./model";
import { initialMode, setMode } from "./theme";
import "./index.css";

setMode(initialMode());
const index = buildIndex(loadModel());
document.title = `${index.model.meta.system} · Feynman`;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App index={index} />
  </StrictMode>,
);
