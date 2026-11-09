// Matchup logic for the team planner ("Týmovka"). Two sources, both from listhammer.info:
//  - "site": the site's own matchup table of a faction (all players, Last 4 Weeks window): army vs army only;
//  - "lists": round-by-round results of the 4-1-or-better lists in the chosen period: also by the player's
//    disposition, but these are winners only, so win rates are inflated (compare, don't take them literally).
import { MATCH_RAW } from "./matchData";
import { DISP_DATA } from "./dispData";

export const MATCH_DISPOSITIONS = ["Purge the Foe", "Take and Hold", "Priority Assets", "Disruption", "Reconnaissance"];
const DISP_ALL = ["", ...MATCH_DISPOSITIONS];
const capDay = Math.round((Date.parse(MATCH_RAW.capturedAt) - Date.UTC(2026, 0, 1)) / 86400000);
const dayToDate = (d) => new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10);

export const MATCH_FACTIONS = MATCH_RAW.factions
  .filter((n, i) => MATCH_RAW.lists.some((l) => l[0] === i) || (MATCH_RAW.windows["4w"] && MATCH_RAW.windows["4w"].factions[n]))
  .slice()
  .sort((a, b) => a.localeCompare(b, "en"));
export const MATCH_MAX_DAYS = MATCH_RAW.days;
export const MATCH_CAPTURED = MATCH_RAW.capturedAt;
export const MATCH_SITE_LABEL = MATCH_RAW.windows["4w"] ? MATCH_RAW.windows["4w"].label : "";

// A period: { source: "site" } or { source: "lists", days }
export const MATCH_PERIOD_PRESETS = [
  { id: "site", label: "Poslední 4 týdny, všichni hráči (jen armáda vs armáda)", period: { source: "site" } },
  { id: "l28", label: "Vítězné listy: poslední 4 týdny", period: { source: "lists", days: 28 } },
  { id: "l61", label: "Vítězné listy: poslední 2 měsíce", period: { source: "lists", days: 61 } },
  { id: "l92", label: "Vítězné listy: poslední 3 měsíce", period: { source: "lists", days: 92 } },
];
export const periodText = (p) => (p.source === "site" ? `${MATCH_SITE_LABEL} (všichni hráči)` : `${dayToDate(capDay - p.days)} – ${MATCH_CAPTURED} (vítězné listy)`);

const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const siteWinRate = (name) => {
  const t = MATCH_RAW.windows["4w"] && MATCH_RAW.windows["4w"].factions[name];
  return t && t.winRate ? t.winRate / 100 : null;
};
const K = 4; // shrinkage strength (pseudo-games of the faction's own average)
const nameIdx = new Map(MATCH_RAW.factions.map((n, i) => [n, i]));

// all rounds of the lists in the window: [myFaction, dispIdx, oppFaction, result]
function roundsIn(days) {
  const out = [];
  MATCH_RAW.lists.forEach(([f, day, disp, , rounds]) => {
    if (day < capDay - days) return;
    rounds.forEach(([o, r]) => {
      if (o !== f) out.push([f, disp, o, r]);
    });
  });
  return out;
}
const roundsCache = new Map();
function getRounds(days) {
  if (!roundsCache.has(days)) roundsCache.set(days, roundsIn(days));
  return roundsCache.get(days);
}

function factionPrior(rounds, f) {
  let w = 0;
  let n = 0;
  rounds.forEach((r) => {
    if (r[0] === f) {
      w += r[3];
      n += 1;
    }
  });
  return n ? w / n : 0.5;
}

// Stats of my faction (+ optional disposition) against an opposing faction.
// -> { wr (raw 0-1 or null), p (shrunk 0-1), games }
export function pairStats(period, myFaction, myDisp, oppFaction) {
  // a mirror is 50 % by definition (and the sources leave mirrors out)
  if (myFaction === oppFaction) return { wr: 0.5, p: 0.5, games: 0, mirror: true };
  if (period.source === "site") {
    const t = MATCH_RAW.windows["4w"] && MATCH_RAW.windows["4w"].factions[myFaction];
    if (!t) return { wr: null, p: 0.5, games: 0 };
    const row = t.rows.find((r) => r[0] === oppFaction);
    const prior = t.winRate ? t.winRate / 100 : 0.5;
    if (!row) return { wr: null, p: prior, games: 0 };
    const games = row[3] || 0;
    if (row[1] == null) return { wr: null, p: prior, games };
    return { wr: row[1] / 100, p: (row[1] / 100 * games + K * prior) / (games + K), games };
  }
  const rounds = getRounds(period.days);
  const f = nameIdx.get(myFaction);
  const g = nameIdx.get(oppFaction);
  const d = myDisp ? DISP_ALL.indexOf(myDisp) : 0;
  const prior = factionPrior(rounds, f);
  let w = 0;
  let n = 0;
  rounds.forEach((r) => {
    if (r[0] === f && r[2] === g && (!d || r[1] === d)) {
      w += r[3];
      n += 1;
    }
  });
  // Winners-only rounds inflate every faction's win rate (~80 %). Shift the odds so the faction's average in
  // these rounds lands on its real win rate (all players, Last 4 Weeks); the differences between opponents stay.
  const real = period.calibrate === false ? null : siteWinRate(myFaction);
  const clamp = (x) => Math.min(0.995, Math.max(0.005, x));
  const cal = (x) => (real && prior > 0.02 && prior < 0.98 ? sigmoid(logit(clamp(x)) - logit(clamp(prior)) + logit(real)) : x);
  return { wr: n ? cal(w / n) : null, wrRaw: n ? w / n : null, p: cal((w + K * prior) / (n + K)), games: n };
}

// Best pairing of my armies with the enemy armies (max total win chance); brute force (<= 5 x 5).
function bestAssignment(P, rows, cols) {
  const n = Math.min(rows, cols);
  let best = null;
  const usedC = new Array(cols).fill(false);
  const cur = [];
  const rec = (r, sum) => {
    if (r === rows) {
      if (cur.filter((x) => x >= 0).length === n && (!best || sum > best.total)) best = { total: sum, pairs: cur.map((c, i) => [i, c]).filter((p) => p[1] >= 0) };
      return;
    }
    const left = rows - r;
    const free = usedC.filter((u) => !u).length;
    if (cur.filter((x) => x >= 0).length + Math.min(left, free) < n) return;
    for (let c = 0; c < cols; c++) {
      if (usedC[c]) continue;
      usedC[c] = true;
      cur.push(c);
      rec(r + 1, sum + P[r][c]);
      cur.pop();
      usedC[c] = false;
    }
    if (rows > cols) {
      cur.push(-1);
      rec(r + 1, sum);
      cur.pop();
    }
  };
  rec(0, 0);
  return best;
}

// Disposition against disposition (all players, since the Dataslate): how much better or worse
// my disposition does against theirs than against an average opponent, as a log-odds shift.
const DISP_WINDOW = DISP_DATA.windows.ds;
export const DISP_WINDOW_LABEL = DISP_WINDOW.label;
export function dispEffect(myDisp, oppDisp) {
  if (!myDisp || !oppDisp) return null;
  const overall = DISP_WINDOW.overall[myDisp];
  if (!overall) return null;
  if (myDisp === oppDisp) return { delta: logit(0.5) - logit(overall[0] / 100), wr: 50, games: 0, same: true };
  const v = DISP_WINDOW.vs[myDisp] && DISP_WINDOW.vs[myDisp][oppDisp];
  if (!v) return null;
  return { delta: logit(v[0] / 100) - logit(overall[0] / 100), wr: v[0], games: v[1] };
}
const shift = (p, eff) => (eff ? sigmoid(logit(Math.min(0.995, Math.max(0.005, p))) + eff.delta) : p);

// mine: [{faction, disp}], opp: [{faction, disp}]; minDispGames: how many games a disposition cell needs.
export function planTeam(period, mine, opp, minDispGames = 8, noDisp = false) {
  const rows = mine.length;
  const cols = opp.length;
  const useDisp = period.source === "lists";
  const cells = mine.map((m) =>
    opp.map((o) => {
      const eff = noDisp ? null : dispEffect(m.disp, o.disp);
      const army0 = pairStats(period, m.faction, "", o.faction);
      // w = the plain win rate (wins / games, shifted by the disposition effect); p = the shrunk estimate used for ranking
      const army = eff ? { ...army0, p0: army0.p, p: shift(army0.p, eff), w: army0.wr == null ? null : shift(army0.wr, eff) } : { ...army0, w: army0.wr };
      let disp = !noDisp && useDisp && m.disp ? pairStats(period, m.faction, m.disp, o.faction) : null;
      if (disp) disp = eff ? { ...disp, p0: disp.p, p: shift(disp.p, eff), w: disp.wr == null ? null : shift(disp.wr, eff) } : { ...disp, w: disp.wr };
      const dispOk = !!disp && disp.games >= minDispGames;
      return { army, disp, dispOk, eff };
    })
  );
  const Parmy = cells.map((r) => r.map((c) => c.army.p));
  const Pdisp = cells.map((r) => r.map((c) => (c.dispOk ? c.disp.p : c.army.p)));
  const anyDisp = cells.some((r) => r.some((c) => c.dispOk));
  return {
    cells,
    armyPlan: rows && cols ? bestAssignment(Parmy, rows, cols) : null,
    dispPlan: rows && cols && anyDisp ? bestAssignment(Pdisp, rows, cols) : null,
    anyDisp,
  };
}
