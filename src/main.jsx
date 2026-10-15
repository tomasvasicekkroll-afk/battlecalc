import React from "react";
import ReactDOM from "react-dom/client";
import Wh40kCalculator from "./App.jsx";
import AuthGate from "./AuthGate.jsx";
import ErrorBoundary from "./ErrorBoundary.jsx";
import { captureShareFromUrl } from "./lib/shares";

// A share link opened before signing in must survive the login redirect.
captureShareFromUrl();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "20px 10px",
        background: "#070c14",
      }}
    >
      <ErrorBoundary>
        <AuthGate>{(session) => <Wh40kCalculator session={session} />}</AuthGate>
      </ErrorBoundary>
    </div>
  </React.StrictMode>
);

// Offline support: the service worker (public/sw.js) caches the app shell.
// Production only, so it never interferes with the dev server's hot reload.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((e) => console.error("Service worker se nezaregistroval", e));
  });
}
