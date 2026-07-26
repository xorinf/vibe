import { createRoot } from "react-dom/client";
import { App } from "./app";

function showError(label: string, e: any) {
  const stack = e?.stack || e?.message || String(e);
  const root = document.getElementById("root");
  if (root) {
    const div = document.createElement("div");
    div.style.cssText = "position:fixed;inset:0;background:#1a0000;color:#ff8888;font:12px monospace;padding:20px;z-index:999999;white-space:pre-wrap;overflow:auto;";
    div.textContent = "[" + label + "]\n\n" + stack;
    document.body.appendChild(div);
  }
}

window.addEventListener("error", e => showError("global error", e.error || e.message));
window.addEventListener("unhandledrejection", e => showError("promise rejection", e.reason));
const origErr = console.error;
console.error = (...args) => {
  showError("console.error", args.map(a => a instanceof Error ? a.stack : String(a)).join(" "));
  origErr.apply(console, args);
};

try {
  createRoot(document.getElementById("root")!).render(<App />);
} catch (e) {
  showError("render threw", e);
}
