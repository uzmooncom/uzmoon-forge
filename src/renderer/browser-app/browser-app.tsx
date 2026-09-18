import React from "react";
import { createRoot } from "react-dom/client";
import BrowserApp from "./BrowserApp.js";
import "../styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("No #root element");
createRoot(root).render(
  <React.StrictMode>
    <BrowserApp />
  </React.StrictMode>,
);