import React, { useState } from "react";
import { supabase } from "./lib/supabaseClient";
import { useSession } from "./lib/auth";

const theme = {
  "--bg": "#070c14",
  "--panel": "#0f1826",
  "--field-bg": "#0a121e",
  "--field-border": "#1f3149",
  "--text": "#eaf1fb",
  "--muted": "#7e93ad",
  "--accent": "#2f8fe8",
  "--accent-text": "#7cc0ff",
};

const inputStyle = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--field-bg)",
  border: "1px solid var(--field-border)",
  borderRadius: 6,
  color: "var(--text)",
  padding: "9px 10px",
  fontSize: 14,
  marginBottom: 10,
};

const primaryBtnStyle = (disabled) => ({
  width: "100%",
  border: "none",
  background: "var(--accent)",
  color: "#fff",
  borderRadius: 6,
  padding: 11,
  fontSize: 13.5,
  fontWeight: 700,
  cursor: disabled ? "default" : "pointer",
  opacity: disabled ? 0.7 : 1,
});

function tabStyle(active) {
  return {
    flex: 1,
    border: "1px solid " + (active ? "var(--accent)" : "var(--field-border)"),
    background: active ? "rgba(47,143,232,0.12)" : "transparent",
    color: active ? "var(--accent-text)" : "var(--muted)",
    borderRadius: 6,
    padding: "7px 0",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
  };
}

function MagicLinkForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState("idle"); // idle | sending | sent | error
  const [errorMsg, setErrorMsg] = useState("");

  const sendLink = async (e) => {
    e.preventDefault();
    if (!email.trim() || !supabase) return;
    setStatus("sending");
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    });
    if (error) {
      setErrorMsg(error.message);
      setStatus("error");
    } else {
      setStatus("sent");
    }
  };

  if (status === "sent") {
    return (
      <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>
        Odkaz je na cestě na <b>{email}</b>. Otevři si email a klikni na něj — vrátíš se sem už přihlášený/á.
      </div>
    );
  }

  return (
    <form onSubmit={sendLink}>
      <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="tvuj@email.cz" style={inputStyle} />
      <button type="submit" disabled={status === "sending"} style={primaryBtnStyle(status === "sending")}>
        {status === "sending" ? "Posílám…" : "Poslat přihlašovací odkaz"}
      </button>
      {status === "error" && <div style={{ fontSize: 12, color: "#e0857c", marginTop: 8 }}>{errorMsg}</div>}
    </form>
  );
}

function PasswordForm() {
  const [subMode, setSubMode] = useState("login"); // login | signup
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("idle"); // idle | sending | signedUp | error
  const [errorMsg, setErrorMsg] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    if (!email.trim() || !password || !supabase) return;
    setStatus("sending");
    if (subMode === "signup") {
      const { error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: { emailRedirectTo: window.location.origin },
      });
      if (error) {
        setErrorMsg(error.message);
        setStatus("error");
      } else {
        setStatus("signedUp");
      }
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) {
        setErrorMsg(error.message);
        setStatus("error");
      }
      // on success, useSession's onAuthStateChange picks up the new session automatically
    }
  };

  if (status === "signedUp") {
    return (
      <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>
        Účet vytvořen. Zkontroluj <b>{email}</b> a potvrď registraci kliknutím na odkaz v emailu — pak se sem vrať a přihlas se heslem.
      </div>
    );
  }

  return (
    <>
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        <button type="button" onClick={() => setSubMode("login")} style={tabStyle(subMode === "login")}>
          Přihlásit se
        </button>
        <button type="button" onClick={() => setSubMode("signup")} style={tabStyle(subMode === "signup")}>
          Vytvořit účet
        </button>
      </div>
      <form onSubmit={submit}>
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="tvuj@email.cz" style={inputStyle} />
        <input
          type="password"
          required
          minLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Heslo (min. 6 znaků)"
          style={inputStyle}
        />
        <button type="submit" disabled={status === "sending"} style={primaryBtnStyle(status === "sending")}>
          {status === "sending" ? "Chvilku…" : subMode === "signup" ? "Vytvořit účet" : "Přihlásit se"}
        </button>
        {status === "error" && <div style={{ fontSize: 12, color: "#e0857c", marginTop: 8 }}>{errorMsg}</div>}
      </form>
    </>
  );
}

function LoginScreen() {
  const [mode, setMode] = useState("magic"); // magic | password

  return (
    <div
      style={{
        ...theme,
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "radial-gradient(ellipse 120% 60% at 50% -10%, #102338 0%, #070c14 55%)",
        color: "var(--text)",
        fontFamily: "'Inter', -apple-system, sans-serif",
        padding: 20,
      }}
    >
      <div style={{ width: "100%", maxWidth: 360, background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 14, padding: 24 }}>
        <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: 0.5, marginBottom: 4 }}>BATTLECALC</div>
        <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 16 }}>
          {mode === "magic" ? "Přihlas se emailem — pošleme ti odkaz, žádné heslo netřeba." : "Přihlas se vlastním heslem, nebo si účet rovnou založ."}
        </div>

        <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
          <button type="button" onClick={() => setMode("magic")} style={tabStyle(mode === "magic")}>
            Odkaz emailem
          </button>
          <button type="button" onClick={() => setMode("password")} style={tabStyle(mode === "password")}>
            Email + heslo
          </button>
        </div>

        {mode === "magic" ? <MagicLinkForm /> : <PasswordForm />}
      </div>
    </div>
  );
}

export default function AuthGate({ children }) {
  const { session, loading } = useSession();

  if (!supabase) {
    return (
      <div style={{ ...theme, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)", color: "var(--text)", padding: 20, textAlign: "center" }}>
        Supabase není nakonfigurovaný (chybí VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).
      </div>
    );
  }

  if (loading) {
    return <div style={{ ...theme, minHeight: "100vh", background: "var(--bg)", color: "var(--muted)", display: "flex", alignItems: "center", justifyContent: "center" }}>Načítám…</div>;
  }

  if (!session) return <LoginScreen />;

  return children(session);
}
