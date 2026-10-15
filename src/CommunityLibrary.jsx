import React, { useEffect, useMemo, useState, useCallback } from "react";
import { listSharedUnits, fetchSharedUnits, publishUnits, deleteSharedUnits, isAdmin, withFreshIds } from "./lib/community";

// Library tab "Komunita": browse units shared by the admin and copy them into
// your own library. Admins additionally get upload / delete tools. Uses the
// app's CSS variables, so it follows the active theme.

const smallBtn = {
  border: "1px solid var(--field-border)",
  background: "transparent",
  color: "var(--accent-text)",
  borderRadius: 6,
  padding: "4px 9px",
  fontSize: 11.5,
  fontWeight: 700,
  cursor: "pointer",
};

const norm = (s) => String(s || "").trim().toLowerCase();

export default function CommunityLibrary({ library, onAdd, askConfirm, signatureOf }) {
  const [items, setItems] = useState(null); // null = loading
  const [error, setError] = useState("");
  const [admin, setAdmin] = useState(false);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(() => new Set());
  const [busy, setBusy] = useState(""); // text describing the running action
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setItems(null);
    setError("");
    try {
      setItems(await listSharedUnits());
    } catch (e) {
      console.error("Načtení komunitní knihovny selhalo", e);
      setItems([]);
      setError("Komunitní knihovnu se nepodařilo načíst. Zkontroluj připojení, případně jestli je v Supabase spuštěné supabase/community.sql.");
    }
  }, []);

  useEffect(() => {
    load();
    isAdmin().then(setAdmin);
  }, [load]);

  const ownKeys = useMemo(() => new Set(library.map((u) => `${norm(u.faction)}|${norm(u.name)}`)), [library]);

  const groups = useMemo(() => {
    const q = norm(search);
    const map = new Map();
    (items || []).forEach((it) => {
      if (q && !norm(it.name).includes(q) && !norm(it.faction).includes(q)) return;
      const f = it.faction || "Bez frakce";
      if (!map.has(f)) map.set(f, []);
      map.get(f).push(it);
    });
    return Array.from(map.entries());
  }, [items, search]);

  const toggle = (f) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });

  const add = async (rows) => {
    if (rows.length === 0) return;
    setBusy(`Stahuji ${rows.length} jednotek…`);
    setMessage("");
    try {
      const units = (await fetchSharedUnits(rows.map((r) => r.id))).map(withFreshIds);
      const { added, skipped } = onAdd(units);
      setMessage(`Přidáno ${added} jednotek${skipped > 0 ? `, ${skipped}× už v knihovně bylo identické` : ""}.`);
    } catch (e) {
      console.error("Přidání z komunity selhalo", e);
      setMessage("Přidání se nepovedlo. Zkus to znovu.");
    } finally {
      setBusy("");
    }
  };

  const upload = async () => {
    setBusy(`Nahrávám 0/${library.length}…`);
    setMessage("");
    try {
      const n = await publishUnits(library, signatureOf, (done, total) => setBusy(`Nahrávám ${done}/${total}…`));
      setMessage(`Nahráno ${n} jednotek do komunity.`);
      await load();
    } catch (e) {
      console.error("Nahrání do komunity selhalo", e);
      setMessage("Nahrání selhalo: " + (e && e.message ? e.message : "neznámá chyba") + ". Jsi v Supabase zapsaný jako admin (app_admins)?");
    } finally {
      setBusy("");
    }
  };

  const remove = (rows, label) =>
    askConfirm(`Opravdu smazat ${label} z komunitní knihovny? Uživatelům, kteří si je už přidali, zůstanou.`, async () => {
      setBusy("Mažu…");
      try {
        await deleteSharedUnits(rows.map((r) => r.id));
        await load();
        setMessage(`Smazáno ${rows.length} jednotek.`);
      } catch (e) {
        console.error("Mazání z komunity selhalo", e);
        setMessage("Mazání selhalo.");
      } finally {
        setBusy("");
      }
    });

  return (
    <div>
      <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.5, marginBottom: 10 }}>
        Jednotky, které nahrál správce. Přidej si je do své knihovny jedním klikem a hned s nimi počítej. Nejde o oficiální data Games Workshop; Battlecalc je nezávislý fanouškovský nástroj.
      </div>

      {admin && (
        <div style={{ background: "var(--panel)", border: "1px solid var(--accent)", borderRadius: 10, padding: 10, marginBottom: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--accent-text)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6 }}>Správce</div>
          <button
            type="button"
            disabled={!!busy || library.length === 0}
            onClick={() => askConfirm(`Nahrát všech ${library.length} jednotek z tvé knihovny do komunity (viditelné pro všechny přihlášené)?`, upload)}
            style={{ ...smallBtn, width: "100%", padding: "8px 10px", fontSize: 12.5, opacity: busy || library.length === 0 ? 0.6 : 1 }}
          >
            Nahrát mou knihovnu do komunity ({library.length})
          </button>
          <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 5 }}>
            Stejné jednotky se neduplikují, opakované nahrání jen aktualizuje. Osobní data (oblíbené) se neodesílají.
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Hledat jednotku nebo frakci…"
          aria-label="Hledat v komunitní knihovně"
          style={{ flex: 1, minWidth: 0, boxSizing: "border-box", background: "var(--field-bg)", border: "1px solid var(--field-border)", borderRadius: 6, color: "var(--text)", padding: "8px 10px", fontSize: 13 }}
        />
        <button type="button" onClick={load} disabled={items === null} style={smallBtn}>
          Obnovit
        </button>
      </div>

      {busy && <div role="status" style={{ fontSize: 12, color: "var(--accent-text)", marginBottom: 8 }}>{busy}</div>}
      {message && !busy && <div role="status" style={{ fontSize: 12, color: "var(--accent-text)", marginBottom: 8 }}>{message}</div>}
      {error && <div style={{ fontSize: 12, color: "#e0857c", marginBottom: 8 }}>{error}</div>}
      {items === null && <div style={{ fontSize: 12, color: "var(--muted)" }}>Načítám…</div>}
      {items !== null && !error && items.length === 0 && (
        <div style={{ fontSize: 12, color: "var(--muted)", border: "1px dashed var(--field-border)", borderRadius: 8, padding: "10px 12px" }}>
          Komunitní knihovna je zatím prázdná.{admin ? " Nahraj do ní svou knihovnu tlačítkem výše." : ""}
        </div>
      )}
      {items !== null && items.length > 0 && groups.length === 0 && <div style={{ fontSize: 12, color: "var(--muted)" }}>Nic nenalezeno.</div>}

      {groups.map(([faction, rows]) => {
        const expanded = open.has(faction) || norm(search) !== "";
        const missing = rows.filter((r) => !ownKeys.has(`${norm(r.faction)}|${norm(r.name)}`));
        return (
          <div key={faction} style={{ border: "1px solid var(--field-border)", borderRadius: 10, marginBottom: 8, background: "var(--panel)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px" }}>
              <button
                type="button"
                onClick={() => toggle(faction)}
                aria-expanded={expanded}
                style={{ flex: 1, minWidth: 0, textAlign: "left", background: "transparent", border: "none", color: "var(--text)", cursor: "pointer", fontSize: 13, fontWeight: 700, padding: 0 }}
              >
                {expanded ? "▾" : "▸"} {faction} <span style={{ color: "var(--muted)", fontWeight: 500 }}>({rows.length})</span>
              </button>
              <button type="button" disabled={!!busy || missing.length === 0} onClick={() => add(missing)} style={{ ...smallBtn, opacity: busy || missing.length === 0 ? 0.5 : 1 }}>
                {missing.length === 0 ? "Vše máš" : `Přidat vše (${missing.length})`}
              </button>
              {admin && (
                <button type="button" disabled={!!busy} onClick={() => remove(rows, `frakci „${faction}“ (${rows.length})`)} style={{ ...smallBtn, color: "#e0857c" }} aria-label={`Smazat frakci ${faction}`}>
                  ✕
                </button>
              )}
            </div>
            {expanded && (
              <div style={{ borderTop: "1px solid var(--field-border)" }}>
                {rows.map((r) => {
                  const have = ownKeys.has(`${norm(r.faction)}|${norm(r.name)}`);
                  return (
                    <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderTop: "1px solid var(--field-border)", fontSize: 12.5 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</div>
                        <div style={{ fontSize: 10.5, color: "var(--muted)" }}>
                          {r.model_count} {r.model_count === 1 ? "model" : "modelů"}
                          {r.points ? ` · ${r.points} b.` : ""}
                        </div>
                      </div>
                      {have ? (
                        <span style={{ fontSize: 10.5, color: "var(--muted)" }}>v knihovně</span>
                      ) : (
                        <button type="button" disabled={!!busy} onClick={() => add([r])} style={{ ...smallBtn, opacity: busy ? 0.5 : 1 }}>
                          + Přidat
                        </button>
                      )}
                      {admin && (
                        <button type="button" disabled={!!busy} onClick={() => remove([r], `„${r.name}“`)} style={{ ...smallBtn, color: "#e0857c" }} aria-label={`Smazat ${r.name}`}>
                          ✕
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
