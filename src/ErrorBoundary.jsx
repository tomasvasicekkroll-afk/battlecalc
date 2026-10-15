import React from "react";

// Last line of defence: without it a render error anywhere in the 12k-line app
// unmounts everything and leaves a blank page. This keeps the user informed
// and gives them a way out (reload).
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("Battlecalc: neošetřená chyba při vykreslení", error, info && info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        role="alert"
        style={{
          width: "100%",
          maxWidth: 420,
          marginTop: "10vh",
          background: "#0f1826",
          border: "1px solid #1f3149",
          borderRadius: 14,
          padding: 24,
          color: "#eaf1fb",
          fontFamily: "'Inter', -apple-system, sans-serif",
          lineHeight: 1.5,
        }}
      >
        <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: 0.5, marginBottom: 8 }}>BATTLECALC</div>
        <div style={{ fontSize: 14, marginBottom: 6 }}>Něco se pokazilo a appku se nepodařilo vykreslit.</div>
        <div style={{ fontSize: 12.5, color: "#7e93ad", marginBottom: 16 }}>
          Tvoje uložená data na serveru tím nejsou dotčená. Zkus stránku obnovit; pokud se chyba opakuje, dej vědět autorovi a přilož text níže.
        </div>
        <pre style={{ fontSize: 11, color: "#e0857c", whiteSpace: "pre-wrap", wordBreak: "break-word", margin: "0 0 16px" }}>
          {String((this.state.error && this.state.error.message) || this.state.error)}
        </pre>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{ width: "100%", border: "none", background: "#2f8fe8", color: "#fff", borderRadius: 6, padding: 11, fontSize: 13.5, fontWeight: 700, cursor: "pointer" }}
        >
          Obnovit stránku
        </button>
      </div>
    );
  }
}
