import React from "react";
import ReactDOM from "react-dom/client";
import Wh40kCalculator from "./App.jsx";
import AuthGate from "./AuthGate.jsx";
import ErrorBoundary from "./ErrorBoundary.jsx";

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
