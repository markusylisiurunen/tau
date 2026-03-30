import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./modern-normalize.css";
import "./components/button.css";
import "./components/icon_button.css";
import "./components/text_input.css";
import { App } from "./App.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
