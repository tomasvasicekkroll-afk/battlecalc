import React from "react";
import ReactDOM from "react-dom/client";
import Wh40kCalculator from "./App.jsx";

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
      <Wh40kCalculator />
    </div>
  </React.StrictMode>
);
