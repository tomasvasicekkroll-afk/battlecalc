import React, { useMemo, useState } from "react";
import { MATCH_FACTIONS, MATCH_DISPOSITIONS, MATCH_PERIOD_PRESETS, MATCH_MAX_DAYS, MATCH_CAPTURED, periodText, planTeam } from "./data/matchLogic";

const STORE_KEY = "team_plan_v1";
const EMPTY = { mine: Array.from({ length: 5 }, () => ({ faction: "", disp: "" })), opp: Array.from({ length: 5 }, () => ""), preset: "l92", custom: 45, minGames: 8 };

function load() {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (v && Array.isArray(v.mine) && Array.isArray(v.opp)) {
      return { ...EMPTY, ...v, mine: [...v.mine, ...EMPTY.mine].slice(0, 5), opp: [...v.opp, ...EMPTY.opp].slice(0, 5) };
    }
  } catch (e) {
    /* storage blocked or corrupt: start empty */
  }
  return EMPTY;
}

const pct = (p) => `${Math.round(p * 100)} %`;

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
  const period = st.preset === "custom" ? { source: "lists", days: Math.max(1, Math.min(MATCH_MAX_DAYS, Number(st.custom) || 30)) } : (preset || MATCH_PERIOD_PRESETS[3]).period;
  const mine = st.mine.map((m, i) => ({ ...m, i })).filter((m) => m.faction);
  const opp = st.opp.map((f, j) => ({ faction: f, j })).filter((o) => o.faction);
  const plan = useMemo(
    () => (mine.length && opp.length ? planTeam(period, mine.map((m) => ({ faction: m.faction, disp: m.disp })), opp.map((o) => o.faction), Number(st.minGames) || 8) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(st), period.source, period.days]
  );

  const box = { background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 10, padding: 12, marginBottom: 12 };
  const h = { fontSize: 11, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 };
  const selStyle = { background: "var(--field-bg)", color: "var(--text)", border: "1px solid var(--field-border)", borderRadius: 6, padding: "5px 6px", fontSize: 12.5, minWidth: 0 };
  const label = (m) => `${m.faction}${m.disp ? ` (${m.disp})` : ""}`;

  const cellInfo = (c) => (c.dispOk ? { p: c.disp.p, n: c.disp.games, viaDisp: true } : { p: c.army.p, n: c.army.games, viaDisp: false });
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
            </select>
            {st.preset === "custom" && (
              <>
                <input type="number" min={1} max={MATCH_MAX_DAYS} value={st.custom} onChange={(e) => update({ ...st, custom: e.target.value })} style={{ ...selStyle, width: 70 }} />
                <span style={{ fontSize: 12, color: "var(--muted)" }}>dní (nejvýš {MATCH_MAX_DAYS})</span>
              </>
            )}
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 10 }}>
            Použité období: {periodText(period)}; data stažená {MATCH_CAPTURED}.
            {period.source === "lists" ? " Jsou to jen výsledky hráčů s listem 4-1 a lépe, takže win rate je nadsazený; porovnávej mezi sebou, ne s 50 %." : " Win rate je z tabulky matchupů listhammeru (bez mirrorů)."}
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
                  <select value={m.disp} onChange={(e) => update({ ...st, mine: st.mine.map((x, k) => (k === i ? { ...x, disp: e.target.value } : x)) })} style={{ ...selStyle, width: 120 }} disabled={period.source === "site"} title={period.source === "site" ? "Dispozice jsou jen ve zdroji „vítězné listy“" : ""}>
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
              {st.opp.map((f, j) => (
                <div key={j} style={{ marginBottom: 5 }}>
                  <select value={f} onChange={(e) => update({ ...st, opp: st.opp.map((x, k) => (k === j ? e.target.value : x)) })} style={{ ...selStyle, width: "100%" }}>
                    <option value="">— {j + 1}. soupeř —</option>
                    {MATCH_FACTIONS.map((x) => (
                      <option key={x} value={x}>{x}</option>
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
              <div style={h}>Šance na výhru (odhad)</div>
              <div style={{ overflowX: "auto", marginBottom: 10 }}>
                <table style={{ borderCollapse: "collapse", width: "100%" }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", fontSize: 10, color: "var(--muted)", padding: "3px 5px" }}>Moje ↓ / soupeř →</th>
                      {opp.map((o) => (
                        <th key={o.j} style={{ fontSize: 10.5, color: "var(--label)", padding: "3px 5px", textAlign: "center" }}>{o.faction}</th>
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
                                <div style={{ fontSize: 13, fontWeight: 800, fontFamily: "var(--mono)", color: "var(--muted)" }}>{cell.army.mirror ? "50 %" : "—"}</div>
                                <div style={{ fontSize: 10, color: "var(--muted)" }}>{cell.army.mirror ? "zrcadlo" : "bez dat"}</div>
                              </td>
                            );
                          }
                          return (
                            <td key={o.j} style={{ textAlign: "center", padding: "4px 5px", verticalAlign: "top" }}>
                              <div style={{ fontSize: 13, fontWeight: 800, fontFamily: "var(--mono)", color: few ? "var(--muted)" : col }}>{pct(ci.p)}</div>
                              <div style={{ fontSize: 10, color: "var(--muted)" }}>{cell.army.games} her{cell.army.games < 5 ? " ⚠" : ""}</div>
                              {cell.disp && (
                                <div style={{ fontSize: 10, color: cell.dispOk ? "var(--accent-text)" : "var(--muted)" }}>
                                  {m.disp}: {cell.dispOk ? `${pct(cell.disp.p)} (${cell.disp.games})` : `málo dat (${cell.disp.games})`}
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
                Číslo je odhad stažený k průměru armády (málo her se nepřeceňuje); zelená/červená = o 4 body nad/pod průměrem řádku; ⚠ = méně než 5 her. Pod číslem je počet her armády proti armádě{period.source === "lists" ? ", a u zvolené dispozice výsledek jen když je dost her (modře)" : ""}.
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
                    <b>{label(m)}</b>: nejlíp proti <b style={{ color: "#3ddc84" }}>{best.o.faction}</b> ({pct(best.p)}, {best.n} her)
                    {ps.length > 1 && (
                      <>
                        , nejhůř proti <b style={{ color: "#ff6b5e" }}>{worst.o.faction}</b> ({pct(worst.p)}, {worst.n} her)
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
                      {label(mine[r])} <span style={{ color: "var(--accent-text)" }}>→</span> {opp[c].faction} <span style={{ fontFamily: "var(--mono)", color: "var(--muted)" }}>({pct(plan.cells[r][c].army.p)})</span>
                    </div>
                  ))}
                  <div style={{ color: "var(--muted)", marginTop: 3 }}>{period.source === "lists" ? `Součet šancí ${plan.armyPlan.total.toFixed(2)} z ${plan.armyPlan.pairs.length} (z vítězných listů, skutečné výsledky budou nižší; hlavně jde o pořadí).` : `Očekávaně ${plan.armyPlan.total.toFixed(2)} výher z ${plan.armyPlan.pairs.length}.`}</div>
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
                          {label(mine[r])} <span style={{ color: "var(--accent-text)" }}>→</span> {opp[c].faction} <span style={{ fontFamily: "var(--mono)", color: "var(--muted)" }}>({pct(ci.p)}{ci.viaDisp ? ", podle dispozice" : ", jen armáda"})</span>
                        </div>
                      );
                    })}
                    <div style={{ color: "var(--muted)", marginTop: 3 }}>Součet šancí {plan.dispPlan.total.toFixed(2)} z {plan.dispPlan.pairs.length} (z vítězných listů; hlavně jde o pořadí).</div>
                  </div>
                </>
              )}
              <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 8, lineHeight: 1.45 }}>
                Přiřazení maximalizuje součet šancí a nepočítá s tím, kdo si vybírá první ani s tím, jak se vybírá v týmovém formátu (pick/ban). Hráči se liší, takže je to jen jeden z podkladů. Dispozice soupeře nejsou ve zdrojích známé, počítá se jen s tou tvou.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
