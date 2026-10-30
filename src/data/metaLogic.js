// Tournament meta logic: decodes the compact list data (metaRaw.js) and builds
//  - META_LISTS_30: the last-30-days detachment groups the "Stavba armády" view shows,
//  - idealList(): the "ideal list" for a faction + disposition (+ detachment) from ~2 months of lists.
// Same grouping rules everywhere: a unit is only counted in lists that use the SAME detachment(s).
import { META_RAW } from "./metaRaw";

const SEC = ["A", "C", "B", "T", "O", "L"];
export const META_DISPOSITIONS = META_RAW.disps.filter(Boolean);
const dayToDate = (d) => new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10);
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const round1 = (x) => Math.round(x * 10) / 10;
const detKey = (d) => [...d].map((x) => x.toLowerCase()).sort().join("|");

const decodedCache = new Map();
function decodeFaction(name) {
  if (decodedCache.has(name)) return decodedCache.get(name);
  const F = META_RAW.factions[name];
  if (!F) return [];
  const lists = F.lists.map(([day, rec, disp, dets, units, enh]) => ({
    day,
    date: dayToDate(day),
    rec: rec / 100,
    disp: META_RAW.disps[disp] || "",
    dets: dets.map((i) => F.dets[i]),
    units: units.map(([n, p, s]) => [F.names[n], p, SEC[s]]),
    enh: enh.map((i) => F.enhs[i]),
  }));
  decodedCache.set(name, lists);
  return lists;
}

function groupStats(lists, label, detachments) {
  const n = lists.length;
  const perUnit = new Map();
  const secTot = {};
  const dispC = {};
  const enhC = new Map();
  lists.forEach((L) => {
    dispC[L.disp || "?"] = (dispC[L.disp || "?"] || 0) + 1;
    const copies = new Map();
    L.units.forEach(([name, pts, sec]) => {
      secTot[sec] = (secTot[sec] || 0) + pts;
      const e = copies.get(name) || { c: 0, p: 0, secs: {} };
      e.c += 1;
      e.p += pts;
      e.secs[sec] = (e.secs[sec] || 0) + 1;
      copies.set(name, e);
    });
    copies.forEach((e, name) => {
      const u = perUnit.get(name) || { lists: 0, cs: [], pts: 0, cnt: 0, secs: {} };
      u.lists += 1;
      u.cs.push(e.c);
      u.pts += e.p;
      u.cnt += e.c;
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
  return {
    label,
    detachments,
    n,
    disp: dispC,
    avgUnits: round1(lists.reduce((a, L) => a + L.units.length, 0) / n),
    avgRec: Math.round((lists.reduce((a, L) => a + L.rec, 0) / n) * 100) / 100,
    sec,
    units,
    enh: [...enhC.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
  };
}

// Detachment combinations of a list set, biggest first.
function combosOf(lists) {
  const combos = new Map();
  lists.forEach((L) => {
    const k = detKey(L.dets);
    if (!combos.has(k)) combos.set(k, { key: k, dets: L.dets, lists: [] });
    combos.get(k).lists.push(L);
  });
  return [...combos.values()].filter((c) => c.dets.length).sort((a, b) => b.lists.length - a.lists.length);
}

// Groups for the meta view: exact detachment combos (>= 3 lists, max 7) + "any:<detachment>" (>= 2 lists) up to 9.
function metaGroups(lists) {
  const exact = combosOf(lists).filter((c) => c.lists.length >= 3).slice(0, 7);
  const groups = {};
  const singles = new Set();
  exact.forEach((c) => {
    const label = c.dets.join(" + ");
    groups[label] = groupStats(c.lists, label, c.dets);
    if (c.dets.length === 1) singles.add(c.dets[0].toLowerCase());
  });
  const allDets = new Map();
  lists.forEach((L) => L.dets.forEach((d) => { if (!allDets.has(d.toLowerCase())) allDets.set(d.toLowerCase(), d); }));
  const anys = [];
  allDets.forEach((name, low) => {
    if (singles.has(low)) return;
    const ls = lists.filter((L) => L.dets.some((d) => d.toLowerCase() === low));
    if (ls.length >= 2) anys.push([name, ls]);
  });
  anys.sort((a, b) => b[1].length - a[1].length).slice(0, Math.max(0, 9 - exact.length)).forEach(([name, ls]) => {
    groups["any:" + name] = groupStats(ls, "Libovolný list s " + name, [name]);
  });
  return groups;
}

const capDay = Math.round((Date.parse(META_RAW.capturedAt) - Date.UTC(2026, 0, 1)) / 86400000);

export const META_LISTS_30 = (() => {
  const out = {};
  Object.keys(META_RAW.factions)
    .sort((a, b) => a.localeCompare(b, "en"))
    .forEach((name) => {
      const F = META_RAW.factions[name];
      const lists = decodeFaction(name).filter((L) => L.day >= capDay - 30);
      if (!lists.length) return;
      const groups = metaGroups(lists);
      if (!Object.keys(groups).length) return;
      out[name] = {
        source: F.source,
        capturedAt: META_RAW.capturedAt,
        period: `${dayToDate(capDay - 30)} – ${META_RAW.capturedAt}`,
        siteStats: F.siteStats,
        listsSeen: lists.length,
        listsUsed: lists.length,
        groups,
      };
    });
  return out;
})();

export const META_FACTIONS = Object.keys(META_RAW.factions).sort((a, b) => a.localeCompare(b, "en"));
export const META_PERIOD = { from: dayToDate(capDay - META_RAW.periodDays), to: META_RAW.capturedAt, days: META_RAW.periodDays };

// Detachment combinations available for a faction (+ disposition), with list counts and the
// average result of those lists. Falls back to all dispositions when the chosen one has < 3 lists.
export function idealOptions(faction, disp) {
  const all = decodeFaction(faction);
  const byDisp = disp ? all.filter((L) => L.disp === disp) : all;
  const usedDisp = !disp || byDisp.length >= 3 ? disp || "" : "";
  const pool = usedDisp ? byDisp : all;
  const combos = combosOf(pool).map((c) => ({
    key: c.key,
    detachments: c.dets,
    label: c.dets.join(" + "),
    n: c.lists.length,
    avgRec: Math.round((c.lists.reduce((a, L) => a + L.rec, 0) / c.lists.length) * 100) / 100,
  }));
  const counts = new Map();
  pool.forEach((L) => L.dets.forEach((d) => counts.set(d, (counts.get(d) || 0) + 1)));
  const detachments = [...counts.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, "en"));
  return { combos, detachments, total: pool.length, fellBack: !!disp && !usedDisp, usedDisp };
}

// The ideal list: consensus of the lists that use this exact detachment combination in this
// disposition, cut to the points budget, plus the real list that matches the consensus best.
// `dets` = the detachments the user ticked (empty = the most common combination); `exact` = only
// lists with exactly these detachments (otherwise lists that use at least these).
export function idealList(faction, disp, dets, exact, budget) {
  const opts = idealOptions(faction, disp);
  const all = decodeFaction(faction);
  const pool = opts.usedDisp ? all.filter((L) => L.disp === opts.usedDisp) : all;
  let lists;
  let combo;
  let fellBackContains = false;
  if (dets && dets.length) {
    const want = dets.map((d) => d.toLowerCase());
    const matches = (L, strict) => want.every((w) => L.dets.some((d) => d.toLowerCase() === w)) && (!strict || L.dets.length === want.length);
    lists = pool.filter((L) => matches(L, exact));
    if (!lists.length && exact) {
      lists = pool.filter((L) => matches(L, false));
      fellBackContains = lists.length > 0;
    }
    if (!lists.length) return { opts, empty: true, noMatch: true, selected: dets };
    combo = { key: detKey(dets), dets };
  } else if (dets) {
    return { opts, empty: true, needPick: true };
  } else {
    const top = combosOf(pool)[0];
    if (!top) return { opts, empty: true };
    lists = top.lists;
    combo = { key: top.key, dets: top.dets };
  }
  const n = lists.length;
  const stats = new Map();
  lists.forEach((L) => {
    const copies = new Map();
    L.units.forEach(([name, pts, sec]) => {
      const e = copies.get(name) || { c: 0, p: 0, secs: {} };
      e.c += 1;
      e.p += pts;
      e.secs[sec] = (e.secs[sec] || 0) + 1;
      copies.set(name, e);
    });
    copies.forEach((e, name) => {
      const u = stats.get(name) || { name, lists: 0, cs: [], pts: 0, cnt: 0, secs: {} };
      u.lists += 1;
      u.cs.push(e.c);
      u.pts += e.p;
      u.cnt += e.c;
      Object.entries(e.secs).forEach(([s, v]) => (u.secs[s] = (u.secs[s] || 0) + v));
      stats.set(name, u);
    });
  });
  const rows = [...stats.values()]
    .map((u) => ({
      name: u.name,
      p: u.lists / n,
      typical: median(u.cs),
      max: Math.max(...u.cs),
      pts: Math.round(u.pts / u.cnt),
      sec: Object.entries(u.secs).sort((a, b) => b[1] - a[1])[0][0],
    }))
    .sort((a, b) => b.p - a.p || b.pts - a.pts);
  // Consensus list within the budget: core units (>= 50 %) with their typical copies, then
  // frequent ones (>= 20 %), then extra copies / the next most common while points are left.
  const take = new Map();
  let total = 0;
  const add = (r) => {
    if (total + r.pts > budget) return false;
    take.set(r.name, (take.get(r.name) || 0) + 1);
    total += r.pts;
    return true;
  };
  [[0.5, false], [0.2, false], [0.05, false], [0.5, true], [0.2, true]].forEach(([minP, extra]) => {
    rows.forEach((r) => {
      if (r.p < minP) return;
      const target = extra ? r.max : r.typical;
      while ((take.get(r.name) || 0) < target) if (!add(r)) break;
    });
  });
  const items = rows.filter((r) => take.has(r.name)).map((r) => ({ ...r, copies: take.get(r.name) }));
  const enhC = new Map();
  lists.forEach((L) => L.enh.forEach((e) => enhC.set(e, (enhC.get(e) || 0) + 1)));
  // the actual list closest to the consensus (average popularity of its units) among the better results
  const pOf = new Map(rows.map((r) => [r.name, r.p]));
  let best = null;
  lists.forEach((L) => {
    const names = [...new Set(L.units.map((u) => u[0]))];
    const sim = names.reduce((a, nme) => a + (pOf.get(nme) || 0), 0) / Math.max(1, names.length);
    const score = sim + 0.5 * L.rec;
    if (!best || score > best.score) best = { L, score };
  });
  let rep = null;
  if (best) {
    const m = new Map();
    best.L.units.forEach(([name, pts, sec]) => {
      const e = m.get(name) || { name, copies: 0, pts: 0, sec };
      e.copies += 1;
      e.pts += pts;
      m.set(name, e);
    });
    rep = { date: best.L.date, rec: best.L.rec, disp: best.L.disp, total: best.L.units.reduce((a, u) => a + u[1], 0), units: [...m.values()].sort((a, b) => b.pts - a.pts), enh: best.L.enh };
  }
  return {
    opts,
    empty: false,
    combo: { key: combo.key, label: combo.dets.join(" + "), detachments: combo.dets, n },
    fellBackContains,
    avgRec: Math.round((lists.reduce((a, L) => a + L.rec, 0) / n) * 100) / 100,
    items,
    total,
    budget,
    enh: [...enhC.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
    allRows: rows,
    rep,
    period: META_PERIOD,
  };
}
