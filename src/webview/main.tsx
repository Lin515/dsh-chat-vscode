import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/tokens.css";
import "./styles/app.css";

const container = document.getElementById("root");
if (!container) throw new Error("dsh-chat: #root missing");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
