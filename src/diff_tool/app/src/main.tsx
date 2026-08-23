import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/modern-normalize.css";
import "./styles/global.css";
import "./styles/text_input.css";
import { App } from "./App.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
