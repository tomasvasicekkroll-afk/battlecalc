// Paste as the body of one javascript_tool call while a listhammer.info page is open in the
// browser pane (see README.md, "Matchup data"). Installs window.__MU:
//   __MU.runFaction("/factions/<slug>")  -> site matchup table (Last 4 Weeks; the faction page cannot select Since Dataslate) and
//                                           round-by-round results of the 4-1+ lists of the last
//                                           window.__DAYS days (default 92)
//   __MU.exportAll()                      -> compact object for build_matchups.py
(() => {
const DAYS = window.__DAYS || 92;
const DISP = ["Purge the Foe", "Take and Hold", "Priority Assets", "Disruption", "Reconnaissance"];
const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const NOW = new Date();
const CUTOFF = new Date(NOW.getTime() - DAYS * 86400000);
const dlg = () => document.querySelector("[role=dialog], .p-dialog");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function dateOf(text) {
  const l = text.split("\n").map((x) => x.trim())[2] || "";
  const m = l.match(/·\s*([A-Z][a-z]{2})[a-z]*\.?\s+(\d{1,2})\s*$/);
  if (!m || !(m[1] in MON)) return null;
  const y = NOW.getFullYear();
  let d = new Date(y, MON[m[1]], +m[2], 12);
  if (d.getTime() > NOW.getTime() + 2 * 86400000) d = new Date(y - 1, MON[m[1]], +m[2], 12);
  return d;
}
// header of a list modal: player, record, event · date, faction, detachments..., disposition, "View"
function parseHead(text) {
  const lines = text.split("\n").map((l) => l.trim());
  const dt = dateOf(text);
  const vi = lines.indexOf("View");
  const head = lines.slice(0, vi > 0 ? vi : 8);
  const rec = (head[1] || "").match(/^(\d+)-(\d+)(?:-(\d+))?$/);
  const w = rec ? +rec[1] : 0, l = rec ? +rec[2] : 0, d = rec && rec[3] ? +rec[3] : 0;
  const mid = head.slice(4);
  const disp = mid.find((x) => DISP.includes(x)) || "";
  // rounds: "<player>'s matchups" then groups R#, W/L/D, faction, score
  const rounds = [];
  const mi = lines.findIndex((x) => /'s matchups$/.test(x));
  if (mi >= 0) {
    for (let i = mi + 1; i < lines.length; i++) {
      if (/^Hover for opponent|^Previous$/.test(lines[i])) break;
      if (/^R\d+$/.test(lines[i]) && /^[WLD]$/.test(lines[i + 1] || "") && lines[i + 2]) {
        rounds.push([lines[i + 2], lines[i + 1] === "W" ? 1 : lines[i + 1] === "D" ? 0.5 : 0]);
        i += 3;
      }
    }
  }
  return { date: dt, disp, rec: w + l + d ? (w + 0.5 * d) / (w + l + d) : 0, rounds, loading: /Loading matchups/.test(text), hasList: /Exported with App|points/i.test(text) };
}
async function setRange(prefix) {
  const sel = [...document.querySelectorAll(".p-select")].find((e) => /Weekend|Weeks|Dataslate/.test(e.innerText));
  if (!sel) return false;
  if (sel.innerText.trim().startsWith(prefix)) return true;
  sel.click();
  await sleep(700);
  const opt = [...document.querySelectorAll(".p-select-overlay [role=option], .p-select-overlay li")].find((o) => o.innerText.trim().startsWith(prefix));
  if (!opt) { document.body.click(); return false; }
  opt.click();
  await sleep(3000);
  return true;
}
function matchupTable() {
  const tbl = [...document.querySelectorAll("table")].find((t) => /Go 1st/.test(t.innerText));
  const txt = document.body.innerText;
  const g = (re) => { const m = txt.match(re); return m ? m[1] : null; };
  const rows = [];
  if (tbl) {
    [...tbl.querySelectorAll("tbody tr")].forEach((tr) => {
      const td = [...tr.querySelectorAll("td")].map((x) => x.innerText.trim());
      if (td.length < 6) return;
      const wr = parseFloat(td[1]);
      const diff = parseFloat(td[2]);
      rows.push([td[0], Number.isFinite(wr) ? wr : null, Number.isFinite(diff) ? diff : null, parseInt(td[5], 10) || 0]);
    });
  }
  return { label: g(/(\d{1,2} \w{3} - \d{1,2} \w{3} \d{4})/), winRate: g(/([\d.]+)%\s*Win Rate/), games: g(/(\d+)\s*Games/), rows };
}
async function closeDialog() {
  const d = dlg();
  if (!d) return;
  const x = d.querySelector('button[aria-label="Close"], .p-dialog-close-button, button[aria-label*="lose"]');
  if (x) x.click(); else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await sleep(400);
}
async function collectRounds() {
  const out = [];
  let older = 0;
  let stale = 0;
  for (let i = 0; i < 700; i++) {
    const d = dlg();
    if (!d) break;
    let t = d.innerText;
    for (let k = 0; k < 25 && /Loading matchups/.test(t); k++) { await sleep(120); t = (dlg() || d).innerText; }
    const h = parseHead(t);
    if (h.date && h.date < CUTOFF) older += 1; else older = 0;
    if (h.date && h.date >= CUTOFF) out.push({ day: Math.round((Date.UTC(h.date.getFullYear(), h.date.getMonth(), h.date.getDate()) - Date.UTC(2026, 0, 1)) / 86400000), disp: h.disp, rec: Math.round(h.rec * 100), rounds: h.rounds });
    if (older >= 6) break;
    const next = [...d.querySelectorAll("button")].find((b) => b.innerText.trim() === "Next");
    if (!next || next.disabled) break;
    next.click();
    let changed = false;
    for (let k = 0; k < 40; k++) { await sleep(100); const d2 = dlg(); if (d2 && d2.innerText !== t) { changed = true; break; } }
    if (!changed) { stale += 1; if (stale > 2) break; }
  }
  return out;
}
async function runFaction(href) {
  await closeDialog();
  const a = document.querySelector('a[href="' + href + '"]');
  if (!a) return { error: "no link" };
  if (location.pathname !== href) a.click();
  for (let i = 0; i < 80; i++) { await sleep(300); if (location.pathname === href && document.body.innerText.includes("Win Rate")) break; }
  await sleep(1500);
  const windows = {};
  if (await setRange("Last 4")) windows["4w"] = matchupTable();
  await setRange("Last 4");
  const hasBtn = () => [...document.querySelectorAll("button")].find((x) => (x.getAttribute("aria-label") || "").includes("army list"));
  for (let i = 0; i < 60 && !hasBtn(); i++) await sleep(300);
  const b = hasBtn();
  let lists = [];
  if (b) {
    b.click();
    for (let i = 0; i < 40 && !dlg(); i++) await sleep(150);
    await sleep(600);
    lists = await collectRounds();
    await closeDialog();
  }
  return { windows, lists };
}
function exportAll() {
  const names = Object.values(window.__MU_OUT).map((v) => v.name);
  const idx = (n) => { let i = names.indexOf(n); if (i < 0) { names.push(n); i = names.length - 1; } return i; };
  const disps = ["", ...DISP];
  const out = { capturedAt: NOW.toISOString().slice(0, 10), days: DAYS, factions: names, windows: {}, lists: [] };
  Object.values(window.__MU_OUT).forEach((v) => {
    ["4w", "ds"].forEach((w) => {
      const t = v.windows && v.windows[w];
      if (!t) return;
      out.windows[w] = out.windows[w] || { label: t.label, factions: {} };
      out.windows[w].factions[v.name] = { winRate: t.winRate ? +t.winRate : null, games: t.games ? +t.games : null, rows: t.rows };
    });
    (v.lists || []).forEach((L) => {
      out.lists.push([idx(v.name), L.day, disps.indexOf(L.disp), L.rec, L.rounds.map(([o, r]) => [o, r])]);
    });
  });
  return out;
}
window.__MU_OUT = window.__MU_OUT || {};
window.__MU = { runFaction, exportAll, parseHead, setRange, matchupTable, collectRounds, dlg, CUTOFF };
return { now: NOW.toISOString(), cutoff: CUTOFF.toISOString(), factions: [...document.querySelectorAll('a[href^="/factions/"]')].length };
})()
