// Paste this whole file as the body of one javascript_tool call while a listhammer.info
// faction page is open in the browser pane. It installs window.__LH; see README.md for the flow:
//   window.__LH.runFaction("/factions/<slug>")  -> collects + aggregates one faction (last 30 days)
//   window.__LH.compact("/factions/<slug>")     -> trimmed object that goes into the data file
// (keep results in window.__OUT, then return "JSONSTART" + JSON.stringify(out) + "JSONEND").
(() => {
const DISP = ["Purge the Foe", "Take and Hold", "Priority Assets", "Disruption", "Reconnaissance"];
const SECMAP = { "ATTACHED UNITS": "A", "CHARACTERS": "C", "BATTLELINE": "B", "DEDICATED TRANSPORTS": "T", "OTHER DATASHEETS": "O", "ALLIED UNITS": "L" };
const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const NOW = new Date();
const DAYS = window.__DAYS || 30;
const CUTOFF = new Date(NOW.getTime() - DAYS * 86400000);
const dlg = () => document.querySelector("[role=dialog], .p-dialog");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
function dateOf(text) {
  const l = text.split("\n").map((x) => x.trim())[2] || "";
  const m = l.match(/·\s*([A-Z][a-z]{2})[a-z]*\.?\s+(\d{1,2})\s*$/);
  if (!m || !(m[1] in MON)) return null;
  const y = NOW.getFullYear();
  let d = new Date(y, MON[m[1]], +m[2], 12);
  if (d.getTime() > NOW.getTime() + 2 * 86400000) d = new Date(y - 1, MON[m[1]], +m[2], 12);
  return d;
}
function parseList(text) {
  if (/OTRAS HOJAS|PERSONAJE|UNIDADES ALIADAS|LIGNE DE BATAILLE|PERSONNAGES|SCHLACHTLINIE|CHARAKTERE/i.test(text)) return null;
  const lines = text.split("\n").map((l) => l.trim());
  if (!lines.some((l) => SECMAP[l])) return null;
  const dt = dateOf(text);
  if (!dt || dt < CUTOFF) return null;
  const vi = lines.indexOf("View");
  const head = lines.slice(0, vi > 0 ? vi : 8);
  const rec = (head[1] || "").match(/^(\d+)-(\d+)(?:-(\d+))?$/);
  const wins = rec ? +rec[1] : 0, losses = rec ? +rec[2] : 0, draws = rec && rec[3] ? +rec[3] : 0;
  const mid = head.slice(4);
  const disp = mid.find((l) => DISP.includes(l)) || "";
  const dets = mid.filter((l) => !DISP.includes(l));
  const units = []; const enh = []; let sec = null;
  for (const l of lines) {
    if (/^Exported with App/i.test(l)) break;
    if (SECMAP[l]) { sec = SECMAP[l]; continue; }
    if (!sec) continue;
    if (/^[•◦]/.test(l)) { const em = l.match(/Enhancements?:\s*(.+)$/i); if (em) enh.push(em[1].trim()); continue; }
    const m = l.match(/^(.*[^\d\s(])\s*(\d+)\s+points$/i);
    if (m && !/^Attached unit \d+/i.test(l)) units.push([m[1].trim(), +m[2], sec]);
  }
  if (!units.length) return null;
  const games = wins + losses + draws;
  return { dets, disp, rec: games ? (wins + 0.5 * draws) / games : 0, units, enh, date: dt.toISOString().slice(0, 10) };
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const round1 = (x) => Math.round(x * 10) / 10;
function groupStats(lists, label, detachments) {
  const n = lists.length;
  const perUnit = new Map(); const secTot = {}; const dispC = {}; const enhC = new Map();
  lists.forEach((L) => {
    dispC[L.disp || "?"] = (dispC[L.disp || "?"] || 0) + 1;
    const copies = new Map();
    L.units.forEach(([name, pts, sec]) => {
      secTot[sec] = (secTot[sec] || 0) + pts;
      const e = copies.get(name) || { c: 0, p: 0, secs: {} };
      e.c += 1; e.p += pts; e.secs[sec] = (e.secs[sec] || 0) + 1;
      copies.set(name, e);
    });
    copies.forEach((e, name) => {
      const u = perUnit.get(name) || { lists: 0, cs: [], pts: 0, cnt: 0, secs: {} };
      u.lists += 1; u.cs.push(e.c); u.pts += e.p; u.cnt += e.c;
      Object.entries(e.secs).forEach(([s, v]) => (u.secs[s] = (u.secs[s] || 0) + v));
      perUnit.set(name, u);
    });
    L.enh.forEach((x) => enhC.set(x, (enhC.get(x) || 0) + 1));
  });
  const units = [...perUnit.entries()]
    .map(([name, u]) => [name, Math.round((u.lists / n) * 100), median(u.cs), Math.max(...u.cs), Math.round(u.pts / u.cnt), Object.entries(u.secs).sort((a, b) => b[1] - a[1])[0][0]])
    .filter((r) => r[1] >= 10 || n <= 4)
    .sort((a, b) => b[1] - a[1] || b[4] - a[4]);
  const sec = {};
  Object.entries(secTot).forEach(([s, v]) => (sec[s] = Math.round(v / n)));
  return { label, detachments, n, disp: dispC, avgUnits: round1(lists.reduce((a, L) => a + L.units.length, 0) / n), avgRec: Math.round((lists.reduce((a, L) => a + L.rec, 0) / n) * 100) / 100, sec, units, enh: [...enhC.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8) };
}
function aggregate(rawTexts) {
  const lists = rawTexts.map(parseList).filter(Boolean);
  const keyOf = (d) => [...d].map((x) => x.toLowerCase()).sort().join("|");
  const combos = new Map();
  lists.forEach((L) => { const k = keyOf(L.dets); if (!combos.has(k)) combos.set(k, { dets: L.dets, lists: [] }); combos.get(k).lists.push(L); });
  const groups = {}; const exactSingles = new Set();
  [...combos.values()].sort((a, b) => b.lists.length - a.lists.length).forEach((c) => {
    if (c.lists.length >= 3 && c.dets.length) {
      const label = c.dets.join(" + ");
      groups[label] = groupStats(c.lists, label, c.dets);
      if (c.dets.length === 1) exactSingles.add(c.dets[0].toLowerCase());
    }
  });
  const allDets = new Map();
  lists.forEach((L) => L.dets.forEach((d) => { if (!allDets.has(d.toLowerCase())) allDets.set(d.toLowerCase(), d); }));
  allDets.forEach((name, low) => {
    if (exactSingles.has(low)) return;
    const ls = lists.filter((L) => L.dets.some((d) => d.toLowerCase() === low));
    if (ls.length) groups["any:" + name] = groupStats(ls, "Libovolný list s " + name, [name]);
  });
  return { listsSeen: rawTexts.length, listsUsed: lists.length, groups };
}
async function collectOpen() {
  const raw = [];
  let older = 0;
  for (let i = 0; i < 500; i++) {
    const d = dlg();
    if (!d) break;
    const t = d.innerText;
    const dt = dateOf(t);
    if (dt && dt < CUTOFF) older += 1; else older = 0;
    raw.push(t);
    if (older >= 6) break;
    const next = [...d.querySelectorAll("button")].find((b) => b.innerText.trim() === "Next");
    if (!next || next.disabled) break;
    next.click();
    let changed = false;
    for (let k = 0; k < 40; k++) { await sleep(100); const d2 = dlg(); if (d2 && d2.innerText !== t) { changed = true; break; } }
    if (!changed) break;
    await sleep(120);
  }
  return raw;
}
function pageStats() {
  const txt = document.body.innerText;
  const g = (re) => { const m = txt.match(re); return m ? m[1] : null; };
  const win = g(/(\d{1,2} \w{3} - \d{1,2} \w{3} \d{4})/);
  const wr = g(/([\d.]+)%\s*Win Rate/);
  const games = g(/(\d+)\s*Games/);
  const players = g(/(\d+)\s*Players/);
  const detWR = {};
  const t = [...document.querySelectorAll("table")].find((tb) => /Combination/.test(tb.innerText));
  if (t) {
    [...t.querySelectorAll("tbody tr")].forEach((tr) => {
      const tds = [...tr.querySelectorAll("td")];
      if (tds.length < 3) return;
      const names = tds[0].innerText.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      const field = parseFloat(tds[1].innerText);
      const w = parseFloat(tds[2].innerText);
      detWR[names.join(" + ")] = { field: Number.isFinite(field) ? field : null, wr: Number.isFinite(w) ? w : null, names };
    });
  }
  return { window: win, mode: /Last 4 Weeks/.test(txt.slice(0, 900)) ? "4w" : "weekend", winRate: wr ? +wr : null, games: games ? +games : null, players: players ? +players : null, detWR };
}
function factions() {
  const seen = new Map();
  document.querySelectorAll('a[href^="/factions/"]').forEach((a) => { const h = a.getAttribute("href"); if (!seen.has(h)) seen.set(h, a.innerText.trim()); });
  return [...seen.entries()].map(([href, name]) => ({ href, name }));
}
async function closeDialog() {
  const d = dlg();
  if (!d) return;
  const x = d.querySelector('button[aria-label="Close"], .p-dialog-close-button, button[aria-label*="lose"]');
  if (x) x.click(); else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await sleep(400);
}
async function runFaction(href) {
  await closeDialog();
  const a = document.querySelector('a[href="' + href + '"]');
  if (!a) return { error: "no link" };
  if (location.pathname !== href) a.click();
  for (let i = 0; i < 80; i++) { await sleep(300); if (location.pathname === href && document.body.innerText.includes("Win Rate")) break; }
  await sleep(1500);
  const sw = [...document.querySelectorAll("button")].find((x) => /Switch to Last 4 Weeks/i.test(x.innerText));
  if (sw) { sw.click(); await sleep(2500); }
  let stats = pageStats();
  const hasBtn = () => [...document.querySelectorAll("button")].find((x) => (x.getAttribute("aria-label") || "").includes("army list"));
  for (let i = 0; i < 60 && !hasBtn(); i++) await sleep(300);
  const b = hasBtn();
  if (!b) return { stats, listsSeen: 0, listsUsed: 0, groups: {} };
  b.click();
  for (let i = 0; i < 40 && !dlg(); i++) await sleep(150);
  await sleep(600);
  const raw = await collectOpen();
  await closeDialog();
  stats = pageStats();
  const agg = aggregate(raw);
  return { stats, ...agg, rawCount: raw.length, lists: raw.map(parseList).filter(Boolean) };
}
const CUT = CUTOFF.toISOString().slice(0, 10);
const TODAY = NOW.toISOString().slice(0, 10);
function compact(href) {
  const r = window.__OUT && window.__OUT[href];
  if (!r || !r.groups) return null;
  const all = Object.entries(r.groups);
  const exact = all.filter(([k, g]) => !k.startsWith("any:") && g.n >= 3).sort((a, b) => b[1].n - a[1].n).slice(0, 7);
  const covered = new Set(exact.flatMap(([, g]) => (g.detachments.length === 1 ? [g.detachments[0].toLowerCase()] : [])));
  const anys = all.filter(([k, g]) => k.startsWith("any:") && g.n >= 2 && !covered.has(g.detachments[0].toLowerCase())).sort((a, b) => b[1].n - a[1].n).slice(0, Math.max(0, 9 - exact.length));
  const groups = {};
  [...exact, ...anys].forEach(([k, g]) => { groups[k] = { ...g, units: g.units.slice(0, 14) }; });
  const wr = {};
  Object.values(groups).forEach((g) => {
    if (g.label.startsWith("Libovolný")) return;
    const want = g.detachments.map(norm).sort().join("|");
    const hit = Object.values(r.stats.detWR || {}).find((d) => d.names.map(norm).sort().join("|") === want);
    if (hit) wr[g.label] = { field: hit.field, wr: hit.wr };
  });
  return { source: "https://listhammer.info" + href, capturedAt: TODAY, period: CUT + " – " + TODAY, siteStats: { window: r.stats.window, winRate: r.stats.winRate, games: r.stats.games, players: r.stats.players, detachmentWR: wr }, listsSeen: r.listsSeen, listsUsed: r.listsUsed, groups };
}
// Raw per-list export (used by the app to build "ideal lists" for any disposition): dictionary
// encoded so the file stays small. Day = days since 2026-01-01.
function exportRaw(hrefs) {
  const out = {};
  hrefs.forEach((href) => {
    const r = window.__OUT[href];
    if (!r || !r.lists || !r.lists.length) return;
    const names = [], dets = [], enhs = [];
    const idx = (arr, v) => { let i = arr.indexOf(v); if (i < 0) { arr.push(v); i = arr.length - 1; } return i; };
    const disps = ["", ...DISP];
    const lists = r.lists.map((L) => [
      Math.round((new Date(L.date + "T12:00:00Z") - Date.UTC(2026, 0, 1)) / 86400000),
      Math.round(L.rec * 100),
      disps.indexOf(L.disp),
      L.dets.map((d) => idx(dets, d)),
      L.units.map(([n, p, s]) => [idx(names, n), p, "ACBTOL".indexOf(s)]),
      L.enh.map((e) => idx(enhs, e)),
    ]);
    const detWR = {};
    Object.values(r.stats.detWR || {}).forEach((d) => { detWR[d.names.join(" + ")] = { field: d.field, wr: d.wr }; });
    out[href] = { name: r.name, source: "https://listhammer.info" + href, siteStats: { window: r.stats.window, winRate: r.stats.winRate, games: r.stats.games, players: r.stats.players, detachmentWR: detWR }, listsSeen: r.listsSeen, names, dets, enhs, lists };
  });
  return out;
}
window.__OUT = window.__OUT || {};
window.__LH = { parseList, aggregate, collectOpen, pageStats, factions, runFaction, compact, exportRaw, dlg, dateOf, CUTOFF };
return { now: NOW.toISOString(), cutoff: CUTOFF.toISOString(), factions: factions().length };
})()
