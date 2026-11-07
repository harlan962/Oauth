import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import {AuthGate} from './AuthGate';
import "./styles.css";
import "./account-ui.css";
import "./workbuddy.css";
import "./pat.css";
import "./organization.css";
import "./account-table.css";
import "./check-settings.css";
import "./dialogs.css";
import "./account-detail.css";
import "./api-access.css";
import "./auth.css";
import "./security.css";
import "./notify.css";
import "./pager.css";
import "./export-accounts.css";

// Native selects can retain :focus-visible after a pointer click. Track the
// navigation method so mouse interactions stay quiet without hiding Tab focus.
document.documentElement.dataset.inputMethod = "pointer";
document.addEventListener("pointerdown", () => {
  document.documentElement.dataset.inputMethod = "pointer";
}, true);
document.addEventListener("keydown", event => {
  if (event.key === "Tab" || event.key.startsWith("Arrow")) {
    document.documentElement.dataset.inputMethod = "keyboard";
  }
}, true);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthGate><App /></AuthGate>
  </React.StrictMode>,
);
