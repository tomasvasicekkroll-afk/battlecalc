import React, { useMemo, useState } from "react";
import { MATCH_FACTIONS, MATCH_DISPOSITIONS, MATCH_PERIOD_PRESETS, MATCH_MAX_DAYS, MATCH_CAPTURED, MATCH_MIN_DATE, MATCH_MAX_DATE, matchDateToDay, periodText, planTeam } from "./data/matchLogic";

const STORE_KEY = "team_plan_v1";
const EMPTY = { mine: Array.from({ length: 5 }, () => ({ faction: "", disp: "" })), opp: Array.from({ length: 5 }, () => ({ faction: "", disp: "" })), preset: "l92", custom: 45, minGames: 8, calibrate: true, noDisp: false };

function load() {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (v && Array.isArray(v.mine) && Array.isArray(v.opp)) {
      // older saves stored the enemy as a plain faction string
      const oppNorm = v.opp.map((o) => (typeof o === "string" ? { faction: o, disp: "" } : o));
      return { ...EMPTY, ...v, mine: [...v.mine, ...EMPTY.mine].slice(0, 5), opp: [...oppNorm, ...EMPTY.opp].slice(0, 5) };
    }
  } catch (e) {
    /* storage blocked or corrupt: start empty */
  }
  return EMPTY;
}

const pct = (p) => `${Math.round(p * 100)} %`;
// win rate text: the real win rate, or ~estimate when the site hides it (fewer than 10 games)
const wrText = (w, p) => (w != null ? pct(w) : `~${pct(p)}`);

// "Týmovka": who of my team should face whom, from listhammer matchup data.
export default function TeamPlanner() {
  const [st, setSt] = useState(load);
  const [open, setOpen] = useState(false);
  const update = (next) => {
    setSt(next);
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(next));
    } catch (e) {
      /* the planner still works without saving */
    }
  };
  const preset = MATCH_PERIOD_PRESETS.find((p) => p.id === st.preset) || null;
  const rangeFrom = st.from || MATCH_MIN_DATE;
  const rangeTo = st.to || MATCH_MAX_DATE;
  const [dayA, dayB] = [matchDateToDay(rangeFrom), matchDateToDay(rangeTo)].sort((a, b) => a - b);
  const basePeriod = st.preset === "range" ? { source: "lists", fromDay: dayA, toDay: dayB } : st.preset === "custom" ? { source: "lists", days: Math.max(1, Math.min(MATCH_MAX_DAYS, Number(st.custom) || 30)) } : (preset || MATCH_PERIOD_PRESETS[3]).period;
  const period = basePeriod.source === "lists" ? { ...basePeriod, calibrate: st.calibrate !== false } : basePeriod;
  const mine = st.mine.map((m, i) => ({ ...m, i })).filter((m) => m.faction);
  const opp = st.opp.map((o, j) => ({ faction: o.faction, disp: o.disp, j })).filter((o) => o.faction);
  const plan = useMemo(
    () => (mine.length && opp.length ? planTeam(period, mine.map((m) => ({ faction: m.faction, disp: m.disp })), opp.map((o) => ({ faction: o.faction, disp: o.disp })), Number(st.minGames) || 8, !!st.noDisp) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(st), JSON.stringify(period)]
  );

  const box = { background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 10, padding: 12, marginBottom: 12 };
  const h = { fontSize: 11, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 };
  const selStyle = { background: "var(--field-bg)", color: "var(--text)", border: "1px solid var(--field-border)", borderRadius: 6, padding: "5px 6px", fontSize: 12.5, minWidth: 0 };
  const label = (m) => `${m.faction}${m.disp && !st.noDisp ? ` (${m.disp})` : ""}`;
  const dpts = (cell, ci) => { const base = ci.viaDisp ? cell.disp.p0 : cell.army.p0; return base == null ? null : Math.round((ci.p - base) * 100); };

  const cellInfo = (c) => (c.dispOk ? { p: c.disp.p, w: c.disp.w, raw: c.disp.wrRaw, n: c.disp.games, viaDisp: true } : { p: c.army.p, w: c.army.w, raw: c.army.wrRaw, n: c.army.games, viaDisp: false });
  const rowAvg = (r) => (plan ? plan.cells[r].reduce((a, c) => a + c.army.p, 0) / plan.cells[r].length : 0.5);

  return (
    <div style={{ ...box, borderColor: "var(--accent)" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="wh40k-btn"
        style={{ display: "flex", width: "100%", alignItems: "center", gap: 8, background: "transparent", border: "none", color: "var(--text)", cursor: "pointer", padding: 0, textAlign: "left" }}
      >
        <span className="gd-title" style={{ flex: 1, fontSize: 13.5, fontWeight: 800 }}>Týmovka: kdo proti komu</span>
        <span style={{ color: "var(--accent-text)", fontSize: 12 }}>{open ? "skrýt" : "otevřít"}</span>
      </button>
      {open && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 8, lineHeight: 1.45 }}>
            Zadej až 5 svých armád (frakce + dispozice) a až 5 soupeřových frakcí. Appka podle dat z listhammer.info spočítá, proti čemu má která tvoje armáda nejlepší šanci, a doporučí přiřazení. Nejdřív armáda proti armádě, a když je dost her, i s tvou dispozicí.
          </div>

          <div style={h}>Období a zdroj dat</div>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <select value={st.preset} onChange={(e) => update({ ...st, preset: e.target.value })} style={{ ...selStyle, maxWidth: "100%" }}>
              {MATCH_PERIOD_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
              <option value="custom">Vítězné listy: vlastní počet dní…</option>
              <option value="range">Vítězné listy: časový úsek od – do…</option>
            </select>
            {st.preset === "range" && (
              <>
                <input type="date" min={MATCH_MIN_DATE} max={MATCH_MAX_DATE} value={rangeFrom} onChange={(e) => update({ ...st, from: e.target.value })} style={{ ...selStyle, width: 140 }} />
                <span style={{ fontSize: 12, color: "var(--muted)" }}>až</span>
                <input type="date" min={MATCH_MIN_DATE} max={MATCH_MAX_DATE} value={rangeTo} onChange={(e) => update({ ...st, to: e.target.value })} style={{ ...selStyle, width: 140 }} />
                <span style={{ fontSize: 11.5, color: "var(--muted)" }}>(data jsou od {MATCH_MIN_DATE} do {MATCH_MAX_DATE})</span>
              </>
            )}
            {st.preset === "custom" && (
              <>
                <input type="number" min={1} max={MATCH_MAX_DAYS} value={st.custom} onChange={(e) => update({ ...st, custom: e.target.value })} style={{ ...selStyle, width: 70 }} />
                <span style={{ fontSize: 12, color: "var(--muted)" }}>dní (nejvýš {MATCH_MAX_DAYS})</span>
              </>
            )}
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 10 }}>
            Použité období: {periodText(period)}; data stažená {MATCH_CAPTURED}.
            {period.source === "lists" ? (period.calibrate ? " Jsou to výsledky hráčů s listem 4-1 a lépe. Ti vyhrávají kolem 80 % her, takže jsem win rate přepočítal na úroveň všech hráčů dané armády (rozdíly mezi soupeři zůstávají). Surové číslo je v bublině po najetí na hodnotu." : " Jsou to jen výsledky hráčů s listem 4-1 a lépe, takže win rate je nadsazený; porovnávej mezi sebou, ne s 50 %.") : " Win rate je z tabulky matchupů listhammeru (bez mirrorů)."}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginBottom: 10, fontSize: 12 }}>
            {period.source === "lists" && (
              <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                <input type="checkbox" checked={st.calibrate !== false} onChange={(e) => update({ ...st, calibrate: e.target.checked })} />
                Přepočítat na win rate všech hráčů (jinak nadsazené)
              </label>
            )}
            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
              <input type="checkbox" checked={!!st.noDisp} onChange={(e) => update({ ...st, noDisp: e.target.checked })} />
              Bez dispozic (jen armáda proti armádě)
            </label>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.3fr) minmax(0, 1fr)", gap: 12, marginBottom: 10 }}>
            <div>
              <div style={h}>Moje armády</div>
              {st.mine.map((m, i) => (
                <div key={i} style={{ display: "flex", gap: 6, marginBottom: 5 }}>
                  <select value={m.faction} onChange={(e) => update({ ...st, mine: st.mine.map((x, k) => (k === i ? { ...x, faction: e.target.value } : x)) })} style={{ ...selStyle, flex: 1 }}>
                    <option value="">— {i + 1}. armáda —</option>
                    {MATCH_FACTIONS.map((f) => (
                      <option key={f} value={f}>{f}</option>
                    ))}
                  </select>
                  <select value={m.disp} onChange={(e) => update({ ...st, mine: st.mine.map((x, k) => (k === i ? { ...x, disp: e.target.value } : x)) })} style={{ ...selStyle, width: 120, opacity: st.noDisp ? 0.4 : 1 }} disabled={!!st.noDisp}>
                    <option value="">dispozice?</option>
                    {MATCH_DISPOSITIONS.map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            <div>
              <div style={h}>Soupeři</div>
              {st.opp.map((o, j) => (
                <div key={j} style={{ display: "flex", gap: 6, marginBottom: 5 }}>
                  <select value={o.faction} onChange={(e) => update({ ...st, opp: st.opp.map((x, k) => (k === j ? { ...x, faction: e.target.value } : x)) })} style={{ ...selStyle, flex: 1 }}>
                    <option value="">— {j + 1}. soupeř —</option>
                    {MATCH_FACTIONS.map((x) => (
                      <option key={x} value={x}>{x}</option>
                    ))}
                  </select>
                  <select value={o.disp} onChange={(e) => update({ ...st, opp: st.opp.map((x, k) => (k === j ? { ...x, disp: e.target.value } : x)) })} style={{ ...selStyle, width: 110, opacity: st.noDisp ? 0.4 : 1 }} disabled={!!st.noDisp}>
                    <option value="">dispozice?</option>
                    {MATCH_DISPOSITIONS.map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, fontSize: 12, color: "var(--muted)" }}>
            Dispozice počítám od
            <input type="number" min={3} max={30} value={st.minGames} onChange={(e) => update({ ...st, minGames: e.target.value })} style={{ ...selStyle, width: 56 }} />
            her (míň je málo dat).
            <button onClick={() => update({ ...EMPTY, preset: st.preset, custom: st.custom })} className="wh40k-btn" style={{ marginLeft: "auto", border: "1px solid var(--field-border)", background: "transparent", color: "var(--muted)", borderRadius: 6, padding: "3px 9px", fontSize: 11.5, cursor: "pointer" }}>
              Vyprázdnit
            </button>
          </div>

          {!plan && <div style={{ fontSize: 12, color: "var(--amber)" }}>Vyber aspoň jednu svou armádu a jednoho soupeře.</div>}
          {plan && (
            <>
              <div style={h}>Win rate</div>
              <div style={{ overflowX: "auto", marginBottom: 10 }}>
                <table style={{ borderCollapse: "collapse", width: "100%" }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", fontSize: 10, color: "var(--muted)", padding: "3px 5px" }}>Moje ↓ / soupeř →</th>
                      {opp.map((o) => (
                        <th key={o.j} style={{ fontSize: 10.5, color: "var(--label)", padding: "3px 5px", textAlign: "center" }}>{o.faction}{o.disp && !st.noDisp ? <div style={{ fontSize: 9.5, color: "var(--muted)", fontWeight: 400 }}>{o.disp}</div> : null}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {mine.map((m, r) => (
                      <tr key={m.i} style={{ borderTop: "1px solid var(--field-border)" }}>
                        <td style={{ fontSize: 12, fontWeight: 700, padding: "4px 5px" }}>{label(m)}</td>
                        {opp.map((o, c) => {
                          const cell = plan.cells[r][c];
                          const ci = cellInfo(cell);
                          const avg = rowAvg(r);
                          const col = ci.p >= avg + 0.04 ? "#3ddc84" : ci.p <= avg - 0.04 ? "#ff6b5e" : "var(--text)";
                          const few = ci.n < 5;
                          if (cell.army.mirror || (cell.army.games === 0 && !cell.dispOk)) {
                            return (
                              <td key={o.j} style={{ textAlign: "center", padding: "4px 5px", verticalAlign: "top" }}>
                                <div style={{ fontSize: 13, fontWeight: 800, fontFamily: "var(--mono)", color: "var(--muted)" }}>{cell.army.mirror ? pct(cell.army.w ?? cell.army.p) : "—"}</div>
                                <div style={{ fontSize: 10, color: "var(--muted)" }}>{cell.army.mirror ? "zrcadlo" : "bez dat"}</div>
                              </td>
                            );
                          }
                          return (
                            <td key={o.j} style={{ textAlign: "center", padding: "4px 5px", verticalAlign: "top" }}>
                              <div style={{ fontSize: 13, fontWeight: 800, fontFamily: "var(--mono)", color: few ? "var(--muted)" : col }} title={period.calibrate && ci.raw != null ? `Surově ve vítězných listech: ${pct(ci.raw)}` : undefined}>{wrText(ci.w, ci.p)}</div>
                              <div style={{ fontSize: 10, color: "var(--muted)" }}>{cell.army.games} her{cell.army.games < 5 ? " ⚠" : ""}</div>
                              {cell.eff && (
                                <div style={{ fontSize: 10, color: "var(--accent-text)" }} title={`${m.disp} proti ${o.disp}: ${cell.eff.wr} % ${cell.eff.same ? "" : `(${cell.eff.games} her)`}`}>
                                  {m.disp} vs {o.disp}: {dpts(cell, ci) > 0 ? "+" : ""}{dpts(cell, ci)} pp
                                </div>
                              )}
                              {cell.disp && (
                                <div style={{ fontSize: 10, color: cell.dispOk ? "var(--accent-text)" : "var(--muted)" }}>
                                  {m.disp}: {cell.dispOk ? `${wrText(cell.disp.w, cell.disp.p)} (${cell.disp.games})` : `málo dat (${cell.disp.games})`}
                                </div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ fontSize: 10.5, color: "var(--muted)", marginBottom: 10 }}>
                Číslo je win rate{period.source === "lists" && period.calibrate ? " přepočtený na úroveň všech hráčů" : " (výhry / hry) bez úprav"}; ~ před číslem = win rate je skrytý (listhammer ho u méně než 10 her neukazuje) a je to odhad. Pořadí a doporučení se počítají z odhadu staženého k průměru armády, aby pár her nevytvořilo 100 %. Zelená/červená = o 4 body nad/pod průměrem řádku; ⚠ = méně než 5 her. Pod číslem je počet her armády proti armádě{period.source === "lists" ? ", a u zvolené dispozice výsledek jen když je dost her (modře)" : ""}.
              </div>

              <div style={h}>Nejlepší a nejhorší soupeř pro každou moji armádu</div>
              {mine.map((m, r) => {
                const ps = opp.map((o, c) => ({ o, ...cellInfo(plan.cells[r][c]), mirror: plan.cells[r][c].army.mirror })).filter((x) => x.n > 0 && !x.mirror);
                if (!ps.length) {
                  return (
                    <div key={m.i} style={{ fontSize: 12.5, marginBottom: 3 }}>
                      <b>{label(m)}</b>: v tomhle období nemám pro tyhle soupeře žádné hry.
                    </div>
                  );
                }
                const best = ps.reduce((a, b) => (b.p > a.p ? b : a));
                const worst = ps.reduce((a, b) => (b.p < a.p ? b : a));
                return (
                  <div key={m.i} style={{ fontSize: 12.5, marginBottom: 3 }}>
                    <b>{label(m)}</b>: nejlíp proti <b style={{ color: "#3ddc84" }}>{best.o.faction}</b> ({wrText(best.w, best.p)}, {best.n} her)
                    {ps.length > 1 && (
                      <>
                        , nejhůř proti <b style={{ color: "#ff6b5e" }}>{worst.o.faction}</b> ({wrText(worst.w, worst.p)}, {worst.n} her)
                      </>
                    )}
                    .
                  </div>
                );
              })}

              <div style={{ ...h, marginTop: 12 }}>Doporučené přiřazení (armáda vs armáda)</div>
              {plan.armyPlan ? (
                <div style={{ fontSize: 12.5 }}>
                  {plan.armyPlan.pairs.map(([r, c]) => (
                    <div key={r} style={{ marginBottom: 2 }}>
                      {label(mine[r])} <span style={{ color: "var(--accent-text)" }}>→</span> {label(opp[c])} <span style={{ fontFamily: "var(--mono)", color: "var(--muted)" }}>({wrText(plan.cells[r][c].army.w, plan.cells[r][c].army.p)})</span>
                    </div>
                  ))}
                  <div style={{ color: "var(--muted)", marginTop: 3 }}>{period.source === "lists" ? `Součet odhadovaných šancí ${plan.armyPlan.total.toFixed(2)} z ${plan.armyPlan.pairs.length} (z vítězných listů, skutečné výsledky budou nižší; hlavně jde o pořadí).` : `Očekávaně ${plan.armyPlan.total.toFixed(2)} výher z ${plan.armyPlan.pairs.length}.`}</div>
                </div>
              ) : null}
              {plan.dispPlan && (
                <>
                  <div style={{ ...h, marginTop: 12 }}>Doporučené přiřazení (s dispozicemi, kde je dost her)</div>
                  <div style={{ fontSize: 12.5 }}>
                    {plan.dispPlan.pairs.map(([r, c]) => {
                      const ci = cellInfo(plan.cells[r][c]);
                      return (
                        <div key={r} style={{ marginBottom: 2 }}>
                          {label(mine[r])} <span style={{ color: "var(--accent-text)" }}>→</span> {label(opp[c])} <span style={{ fontFamily: "var(--mono)", color: "var(--muted)" }}>({wrText(ci.w, ci.p)}{ci.viaDisp ? ", podle dispozice" : ", jen armáda"})</span>
                        </div>
                      );
                    })}
                    <div style={{ color: "var(--muted)", marginTop: 3 }}>Součet odhadovaných šancí {plan.dispPlan.total.toFixed(2)} z {plan.dispPlan.pairs.length} (z vítězných listů; hlavně jde o pořadí).</div>
                  </div>
                </>
              )}
              <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 8, lineHeight: 1.45 }}>
                Přiřazení maximalizuje součet šancí a nepočítá s tím, kdo si vybírá první ani s tím, jak se vybírá v týmovém formátu (pick/ban). Hráči se liší, takže je to jen jeden z podkladů. Dispozice soupeře se do výpočtu dostane jen jako úprava podle tabulky „dispozice proti dispozici“ (všichni hráči, od Dataslate): ukazuje, o kolik bodů je tvoje dispozice proti jeho lepší nebo horší než proti průměrnému soupeři. Počítá se, že dispozice a frakce působí nezávisle, a rozdíly bývají malé (kolem 0-3 bodů, výrazný je jen Disruption proti Priority Assets). Výsledky konkrétních párů frakce + dispozice proti frakce + dispozice na to není dost her.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
