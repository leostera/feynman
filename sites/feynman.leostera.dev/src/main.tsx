import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./index.css";

const root = document.getElementById("root")!;
const app = (
  <StrictMode>
    <App />
  </StrictMode>
);
// The built page holds the rendered app (scripts/render.tsx); in development it is empty.
if (root.firstElementChild) hydrateRoot(root, app);
else createRoot(root).render(app);
