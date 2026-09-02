import React, { useState, useEffect, useMemo, useCallback, useRef, useId } from "react";
import {
  Swords,
  Shield,
  Plus,
  Trash2,
  Pencil,
  ChevronDown,
  ChevronRight,
  Save,
  Percent,
  Upload,
  AlertTriangle,
  Crosshair,
  Sword,
  Star,
  FolderPlus,
  Menu,
  Settings,
  Home,
  Search,
  Folder,
  Clock,
  List,
  ArrowLeft,
  Swords as SwordsAlt,
  Maximize2,
  Minimize2,
  HelpCircle,
  LayoutGrid,
  ArrowLeftRight,
  Map as MapIcon,
} from "lucide-react";
import { storage } from "./lib/storage";
import { supabase } from "./lib/supabaseClient";

const REROLL_OPTIONS = [
  { value: "none", label: "Žádný" },
  { value: "ones", label: "Jedničky" },
  { value: "all", label: "Vše (neúspěšné)" },
];

const WEAPON_TYPE_OPTIONS = [
  { value: "ranged", label: "Na dálku" },
  { value: "melee", label: "Na blízko" },
];

// Shared -3..+3 modifier dropdown options. Positive = better for the
// attacker (lower target number to hit/wound), negative = worse — matches
// how hitMod/woundMod are subtracted from the target number in computeWeapon.
const MOD_OPTIONS_3 = [-3, -2, -1, 0, 1, 2, 3].map((n) => ({ value: String(n), label: n > 0 ? `+${n}` : String(n) }));


// Anti-X Y+: against a unit with keyword X, an unmodified wound roll of Y+
// always counts as a Critical Wound (auto-wounds), regardless of the normal
// S vs T table. Modeled as taking the better (lower) of the two thresholds —
// see computeWeapon.
const ANTI_KEYWORD_OPTIONS = [
  { value: "none", label: "Žádné" },
  { value: "monster", label: "MONSTER" },
  { value: "vehicle", label: "VEHICLE" },
  { value: "character", label: "CHARACTER" },
  { value: "infantry", label: "INFANTRY" },
];

const emptyWeapon = () => ({
  id: crypto.randomUUID(),
  name: "Zbraň",
  type: "ranged",
  attacks: 1,
  hitX: 3,
  strength: 4,
  ap: 0,
  damage: 1,
  lethalHits: false,
  sustained: 0,
  critHitsOn: 6,
  critWoundOn: 6,
  devastatingWounds: false,
  melta: 0,
  rapidFire: 0,
  antiKeyword: "none",
  antiValue: 4,
  isPsychic: false,
  rerollVsKeywords: { monster: false, vehicle: false, character: false },
  rerollHit: "none",
  rerollWound: "none",
  rerollOneHit: false,
  rerollOneWound: false,
  damageDice: "",
  rerollOneDamage: false,
  copies: 1,
  needsStats: false,
  note: "",
});

const emptyMember = () => ({
  id: crypto.randomUUID(),
  name: "Model",
  count: 1,
  weapons: [emptyWeapon()],
});

const emptyUnit = () => ({
  id: crypto.randomUUID(),
  faction: "",
  name: "",
  points: "",
  toughness: 4,
  save: 3,
  invul: 0,
  wounds: 2,
  fnp: 0,
  psychicFnp: 0,
  woundDebuff: false,
  damageReduction: 0,
  keywords: { monster: false, vehicle: false, character: false, infantry: false },
  // Model base diameter in mm, for the battlefield board (token size). Just a
  // display default — editable per unit, not sourced from any official GW
  // base-size chart.
  baseSize: 32,
  members: [emptyMember()],
  needsStats: false,
  isLeader: false,
  isFavorite: false,
});

// Guards the initial-load calls below against a stuck network/Supabase
// request — without this, a request that never settles would leave the
// "Načítám…" message on screen forever instead of falling back to "not
// loaded" and letting the person retry.
function withTimeout(promise, ms = 10000) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}

function clampNum(v, fallback = 0) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function totalModels(unit) {
  return (unit.members || []).reduce((s, m) => s + (clampNum(m.count) || 0), 0);
}

// Produces a stable signature for a unit's actual content, ignoring randomly
// generated ids and fields that can legitimately differ between imports of the
// same unit without it being a different unit (points cost, favorite flag) — so
// re-importing the same unit from a different list doesn't create a duplicate.
const SIGNATURE_IGNORE_KEYS = new Set(["id", "points", "isFavorite"]);
function stripIds(value) {
  if (Array.isArray(value)) return value.map(stripIds);
  if (value && typeof value === "object") {
    const out = {};
    Object.keys(value)
      .filter((k) => !SIGNATURE_IGNORE_KEYS.has(k))
      .sort()
      .forEach((k) => {
        out[k] = stripIds(value[k]);
      });
    return out;
  }
  return value;
}
function unitSignature(unit) {
  return JSON.stringify(stripIds(unit));
}

// Priority order for combining rerolls: "all" > "ones" > "none"
const REROLL_PRIORITY = { none: 0, ones: 1, all: 2 };
function betterReroll(a, b) {
  return (REROLL_PRIORITY[a] || 0) >= (REROLL_PRIORITY[b] || 0) ? a : b;
}

// Looks at what a unit's weapons already have built in, so the quick attack-bonus
// panel starts pre-checked to match reality rather than always defaulting to off.
function emptyBonus() {
  return {
    lethalHits: false,
    sustained: 0,
    rerollHit: "none",
    rerollWound: "none",
    apMod: 0,
    hitMod: 0,
    woundMod: 0,
    mortalWounds: 0,
    // Fire Overwatch stratagem: only ranged attacks, hits only on an
    // unmodified roll of 6 (see computeWeapon's effectiveHitX handling).
    fireOverwatch: false,
  };
}

// Cheat sheet only: a "slot" (Útočníci or Cíle) can hold BOTH offensive and
// defensive modifiers, since after "Prohodit útočníky a cíle" the same army
// may sit in either role — see emptySlotModifiers below.
function emptyFullModifier() {
  return {
    ...emptyBonus(),
    fnp: 0,
    woundDebuff: false,
    damageReduction: 0,
    benefitOfCover: false, // only meaningful for the ranged slice — cover doesn't apply in melee
    saveReroll: "none",
  };
}
function emptySlotModifiers() {
  return { ranged: emptyFullModifier(), melee: emptyFullModifier(), toughnessMod: 0, saveMod: 0 };
}

function autoDetectBonus(unit) {
  const result = { ranged: emptyBonus(), melee: emptyBonus() };
  if (!unit) return result;
  unit.members.forEach((m) => {
    m.weapons.forEach((w) => {
      const key = w.type === "melee" ? "melee" : "ranged";
      if (w.lethalHits) result[key].lethalHits = true;
      if (w.sustained > result[key].sustained) result[key].sustained = w.sustained;
      result[key].rerollHit = betterReroll(result[key].rerollHit, w.rerollHit || "none");
      result[key].rerollWound = betterReroll(result[key].rerollWound, w.rerollWound || "none");
    });
  });
  return result;
}

// ---------------------------------------------------------------------------
// Core probability math for a single weapon profile vs a defender profile
// ---------------------------------------------------------------------------
function computeWeapon(weapon, modelCount, def, bonus) {
  const b = bonus || emptyBonus();
  // Some units (e.g. GMNDK) can re-roll all hit and wound rolls specifically
  // against a keyword like MONSTER/VEHICLE — distinct from Anti-X, which
  // instead lowers the auto-wound threshold.
  const rerollKeywordActive =
    !!weapon.rerollVsKeywords &&
    !!def.keywords &&
    Object.keys(weapon.rerollVsKeywords).some((k) => weapon.rerollVsKeywords[k] && def.keywords[k]);
  // "Re-roll one damage roll" (e.g. a weapon whose ability lets you re-roll a
  // bad damage die): only meaningful when the raw dice notation (e.g. "D6")
  // is known, since it needs the actual spread of outcomes, not just the
  // average. Modeled as a flat bonus added on top of weapon.damage — that
  // average already carries the flat notation's own bonus (e.g. "D3+3") plus
  // any upstream adjustments like a Melta bump, so only the extra value the
  // reroll itself adds needs to be computed and layered on here.
  let rerollDamageBonus = 0;
  if (weapon.rerollOneDamage && weapon.damageDice) {
    const dist = parseDiceDistribution(weapon.damageDice);
    if (dist) {
      const baseMean = Array.from(dist.entries()).reduce((s, [v, p]) => s + v * p, 0);
      rerollDamageBonus = expectedValueWithOneReroll(dist) - baseMean;
    }
  }
  const att = {
    models: modelCount * (weapon.copies || 1),
    attacks: weapon.attacks,
    hitX: weapon.hitX,
    strength: weapon.strength,
    ap: weapon.ap - (b.apMod || 0),
    damage: weapon.damage + rerollDamageBonus,
    lethalHits: weapon.lethalHits || b.lethalHits,
    sustained: Math.max(weapon.sustained, b.sustained),
    // Critical Hit/Wound threshold: normally an unmodified 6, but some
    // abilities lower it (e.g. "Critical Hits on 5+"). A lower number is
    // "better" (easier), so an unset weapon field just falls back to 6.
    critHitsOn: Math.max(2, Math.min(6, weapon.critHitsOn || 6)),
    critWoundOn: Math.max(2, Math.min(6, weapon.critWoundOn || 6)),
    devastatingWounds: !!weapon.devastatingWounds,
    antiKeyword: weapon.antiKeyword || "none",
    antiValue: weapon.antiValue || 0,
    rerollHit: betterReroll(betterReroll(weapon.rerollHit || "none", b.rerollHit), rerollKeywordActive ? "all" : "none"),
    rerollWound: betterReroll(betterReroll(weapon.rerollWound || "none", b.rerollWound), rerollKeywordActive ? "all" : "none"),
  };

  // Hit-roll modifier: weapons that auto-hit (hitX === 1, e.g. Torrent) ignore modifiers.
  // Benefit of Cover (11th ed.): -1 to the attacker's Ballistic Skill against
  // ranged attacks — def.benefitOfCover is only ever set on the ranged
  // defender profile, so this naturally never applies to melee weapons.
  const coverPenalty = def.benefitOfCover ? 1 : 0;
  // Fire Overwatch stratagem: the unit can only score a hit on an unmodified
  // hit roll of 6 — ignores the weapon's normal BS and every hit modifier
  // (including cover above). Reusing effectiveHitX = 6 for this means every
  // downstream formula (reroll-hit, Sustained Hits, Lethal Hits, "reroll one
  // hit") keeps working unchanged, since they only ever look at the
  // resulting probability, not at hitX itself.
  const effectiveHitX = att.hitX <= 1 ? att.hitX : b.fireOverwatch ? 6 : Math.max(2, Math.min(6, att.hitX - (b.hitMod || 0) + coverPenalty));

  const pHitBase = (7 - effectiveHitX) / 6;
  const pHitAdj =
    att.rerollHit === "ones"
      ? pHitBase + (1 / 6) * pHitBase
      : att.rerollHit === "all"
      ? 1 - (1 - pHitBase) ** 2
      : pHitBase;
  // Critical Hit: normally only an unmodified roll of 6, but some weapons
  // score one on a lower unmodified roll (e.g. "Critical Hits on 5+") — the
  // "1/6" chance-of-a-fresh-crit below generalizes to that threshold, while
  // the leading "1/6" (chance the original roll was a natural 1, eligible
  // for a "re-roll ones") stays fixed regardless of the crit threshold.
  const pCritBase = (7 - att.critHitsOn) / 6;
  const pCritAdj =
    att.rerollHit === "ones"
      ? pCritBase + (1 / 6) * pCritBase
      : att.rerollHit === "all"
      ? pCritBase + (1 - pHitBase) * pCritBase
      : pCritBase;

  const attacks = att.models * att.attacks;
  const hitsNormal = attacks * pHitAdj;
  const critHits = attacks * pCritAdj;
  const sustainedExtra = att.sustained > 0 ? critHits * att.sustained : 0;
  // "Re-roll one Hit roll" (e.g. a master-crafted weapon) is a single extra
  // attempt, not a blanket reroll — modeled as: chance there was at least one
  // failure among this attack's hit rolls, times the chance of succeeding on
  // that one reroll.
  const rerollOneHitBonus = weapon.rerollOneHit && attacks > 0 ? (1 - (1 - pHitAdj) ** attacks) * pHitAdj : 0;
  const hitsTotal = hitsNormal + sustainedExtra + rerollOneHitBonus;

  const S = att.strength;
  const T = def.toughness;
  let woundNeed;
  if (S >= 2 * T) woundNeed = 2;
  else if (S > T) woundNeed = 3;
  else if (S === T) woundNeed = 4;
  else if (S * 2 <= T) woundNeed = 6;
  else woundNeed = 5;
  // Defensive ability some units have: worsen the wound roll by 1 whenever the
  // attacking weapon's Strength is greater than this unit's Toughness.
  const woundDebuffApplied = !!(def.woundDebuff && S > T);
  if (woundDebuffApplied) woundNeed += 1;
  woundNeed = Math.max(2, Math.min(6, woundNeed - (b.woundMod || 0)));
  // Anti-X Y+: against a defender with keyword X, a wound roll of Y+ always
  // counts as a Critical Wound — take whichever threshold is easier to hit.
  if (att.antiKeyword !== "none" && att.antiValue > 0 && def.keywords && def.keywords[att.antiKeyword]) {
    woundNeed = Math.min(woundNeed, att.antiValue);
  }

  const pWoundBase = (7 - woundNeed) / 6;
  const pWoundAdj =
    att.rerollWound === "ones"
      ? pWoundBase + (1 / 6) * pWoundBase
      : att.rerollWound === "all"
      ? 1 - (1 - pWoundBase) ** 2
      : pWoundBase;

  const hitsForWound = att.lethalHits ? hitsTotal - critHits : hitsTotal;
  const autoWounds = att.lethalHits ? critHits : 0;
  const woundsFromRoll = hitsForWound * pWoundAdj;
  // Same one-shot logic as the hit re-roll, applied to the wound roll instead.
  const rerollOneWoundBonus = weapon.rerollOneWound && hitsForWound > 0 ? (1 - (1 - pWoundAdj) ** hitsForWound) * pWoundAdj : 0;
  const woundsTotal = woundsFromRoll + autoWounds + rerollOneWoundBonus;

  // Devastating Wounds: a Critical Wound (an unmodified wound roll of 6, or
  // lower via an ability) inflicts its damage directly as mortal wounds —
  // no saving throw of any kind, normal or invulnerable. A critical wound is
  // always also a successful one, so it's a subset of woundsFromRoll here;
  // simplification: only the main wound-roll bucket is eligible (not the
  // Lethal Hits auto-wounds, which never rolled to wound at all, nor the
  // one-shot "re-roll one wound" attempt, kept out to avoid double-counting).
  const pCritWoundBase = (7 - att.critWoundOn) / 6;
  const pCritWoundAdj =
    att.rerollWound === "ones"
      ? pCritWoundBase + (1 / 6) * pCritWoundBase
      : att.rerollWound === "all"
      ? pCritWoundBase + (1 - pWoundBase) * pCritWoundBase
      : pCritWoundBase;
  const devWounds = att.devastatingWounds ? hitsForWound * pCritWoundAdj : 0;
  const normalWoundsPortion = woundsTotal - devWounds;

  const apAbs = Math.abs(att.ap);
  const normalSave = Math.min(def.save + apAbs, 7);
  const effSave = def.invul > 0 && def.invul < normalSave ? def.invul : normalSave;
  const pSaveSuccessBase = Math.min(1, Math.max(0, (7 - effSave) / 6));
  // Re-roll Saving Throws (defender ability) — same "ones" vs "all" reroll
  // convention as the attacker's hit/wound rerolls, just applied to the
  // defender's own save success chance instead.
  const pSaveSuccessAdj =
    def.saveReroll === "ones"
      ? pSaveSuccessBase + (1 / 6) * pSaveSuccessBase
      : def.saveReroll === "all"
      ? 1 - (1 - pSaveSuccessBase) ** 2
      : pSaveSuccessBase;
  const failProb = 1 - pSaveSuccessAdj;
  const through = normalWoundsPortion * failProb + devWounds;

  // Some units have a Feel No Pain that only applies against a specific kind
  // of attack (e.g. a Culexus Assassin: FNP 2+ against Psychic Attacks) —
  // on top of, not instead of, any general FNP the unit might also have.
  // Take whichever applicable threshold is better (lower).
  let effectiveFnp = def.fnp || 0;
  if (weapon.isPsychic && def.psychicFnp > 0) {
    effectiveFnp = effectiveFnp > 0 ? Math.min(effectiveFnp, def.psychicFnp) : def.psychicFnp;
  }
  const fnpProb = effectiveFnp > 0 ? (7 - effectiveFnp) / 6 : 0;
  const afterFnp = through * (1 - fnpProb);
  // Some very tough units (e.g. C'tan Shards) have an ability that subtracts a
  // flat amount from the Damage characteristic of each attack against them,
  // never going below 1 — apply that here before totaling damage.
  const effectiveDamage = def.damageReduction > 0 ? Math.max(1, att.damage - def.damageReduction) : att.damage;
  const totalDamage = afterFnp * effectiveDamage;

  // For transparency in the result screen: how much damage FNP and the flat
  // damage-reduction ability each actually took off, computed additively so
  // grossDamage - reductionSaved - fnpSaved = totalDamage.
  const grossDamage = through * att.damage;
  const afterReductionOnly = through * effectiveDamage;
  const reductionSaved = grossDamage - afterReductionOnly;
  const fnpSaved = afterReductionOnly - totalDamage;

  const dmgPerHit = effectiveDamage > 0 ? effectiveDamage : 1;
  const effWoundsPerKill = Math.ceil(def.wounds / dmgPerHit) * dmgPerHit;
  const killedModels = effWoundsPerKill > 0 ? totalDamage / effWoundsPerKill : 0;

  // For transparency: how many of the hits/wounds above specifically came
  // from "re-roll hit" (both the blanket all/ones reroll and the one-shot
  // reroll) and from Lethal Hits (crits that skipped the wound roll
  // entirely). Computed additively against the no-reroll / no-Lethal-Hits
  // baseline, then converted to a damage-equivalent using the same
  // save/FNP/per-hit-damage rate as the rest of this weapon's damage, so
  // it's directly comparable to the "Poškození" total shown per weapon.
  const hitsFromRerollHit = attacks > 0 ? attacks * (pHitAdj - pHitBase) + rerollOneHitBonus : 0;
  const woundsFromLethalHits = att.lethalHits ? critHits * (1 - pWoundAdj) : 0;
  const damageConvFactor = failProb * (1 - fnpProb) * effectiveDamage;
  const damageFromRerollHit = hitsFromRerollHit * pWoundAdj * damageConvFactor;
  const damageFromLethalHits = woundsFromLethalHits * damageConvFactor;

  return {
    totalDamage,
    killedModels,
    detail: {
      attacks,
      hitX: effectiveHitX,
      pHit: pHitAdj,
      hitsTotal,
      woundNeed,
      woundDebuffApplied,
      pWound: pWoundAdj,
      woundsTotal,
      effSave,
      failProb,
      through,
      fnpProb,
      afterFnp,
      effWoundsPerKill,
      damageReduction: def.damageReduction || 0,
      fnpValue: effectiveFnp,
      reductionSaved,
      fnpSaved,
      hitsFromRerollHit,
      woundsFromLethalHits,
      damageFromRerollHit,
      damageFromLethalHits,
    },
  };
}

// Sums every member/weapon of an attacking unit against a defender profile,
// split into ranged vs melee damage.
// def/bonus can each be either a single object (used for every weapon regardless
// of type) or a { ranged, melee } pair (used only for the matching weapon type).
function pickByType(value, type) {
  if (value && typeof value === "object" && value.ranged && value.melee) {
    return type === "melee" ? value.melee : value.ranged;
  }
  return value;
}

function computeUnitVsUnit(attackerUnit, def, bonus) {
  let rangedDamage = 0;
  let meleeDamage = 0;
  let killedModels = 0;
  const breakdown = [];

  (attackerUnit.members || []).forEach((member) => {
    (member.weapons || []).forEach((weapon) => {
      const d = pickByType(def, weapon.type);
      const b = pickByType(bonus, weapon.type);
      const r = computeWeapon(weapon, clampNum(member.count), d, b);
      if (weapon.type === "melee") meleeDamage += r.totalDamage;
      else rangedDamage += r.totalDamage;
      killedModels += r.killedModels;
      breakdown.push({
        member: member.name,
        weapon: weapon.name,
        type: weapon.type,
        damage: r.totalDamage,
        killedModels: r.killedModels,
        detail: r.detail,
      });
    });
  });

  // Flat mortal-wound bonus (e.g. from a charge ability) — a one-off amount
  // for the whole unit, not scaled by attacks/models. Bypasses save/invuln
  // but is still reduced by Feel No Pain, same as other damage. Folded into
  // the breakdown as its own row so it flows through killedModels/remainingPct
  // and the result screen's totals consistently with everything else.
  ["ranged", "melee"].forEach((type) => {
    const wb = pickByType(bonus, type);
    const raw = (wb && wb.mortalWounds) || 0;
    if (raw <= 0) return;
    const d = pickByType(def, type);
    const fnpProb = d.fnp > 0 ? (7 - d.fnp) / 6 : 0;
    const dmg = raw * (1 - fnpProb);
    const effWoundsPerKill = Math.max(1, d.wounds);
    const killed = dmg / effWoundsPerKill;
    if (type === "melee") meleeDamage += dmg;
    else rangedDamage += dmg;
    killedModels += killed;
    breakdown.push({
      member: "Mortal wounds",
      weapon: "mimo save (např. z charge)",
      type,
      damage: dmg,
      killedModels: killed,
      isMortalWounds: true,
      detail: {
        attacks: 0,
        hitX: 1,
        pHit: 1,
        hitsTotal: 0,
        woundNeed: 1,
        pWound: 1,
        woundsTotal: raw,
        effSave: 7,
        failProb: 1,
        through: raw,
        fnpProb,
        afterFnp: dmg,
        effWoundsPerKill,
        damageReduction: 0,
        fnpValue: d.fnp || 0,
        reductionSaved: 0,
        fnpSaved: raw - dmg,
      },
    });
  });

  const refDef = pickByType(def, "ranged");
  const totalDamage = rangedDamage + meleeDamage;
  const unitPool = refDef.wounds * refDef.models;
  const consumed = killedModels * refDef.wounds;
  const remainingPct = unitPool > 0 ? Math.max(0, (unitPool - consumed) / unitPool) : 0;

  return { rangedDamage, meleeDamage, totalDamage, killedModels, remainingPct, breakdown };
}

function defenderProfile(unit, overrides) {
  const o = overrides || {};
  // Save/invul are always a die-roll target of 2–6 (0 = "none"); clamp defensively
  // so a bad import or stray value can never produce a nonsensical save like "40+".
  const clampSave = (n, fallback) => {
    const v = clampNum(n, fallback);
    if (v <= 0) return 0;
    return Math.max(2, Math.min(6, v));
  };
  // "Nurgle's gifts"-style attacker abilities that worsen the defender's own
  // characteristics for this fight (e.g. -1 Toughness, -1 to Save
  // characteristic) — applied to the base characteristic before AP/invuln.
  // Entered exactly like the ability is worded on a datasheet: typing -1
  // makes the stat worse for the defender in BOTH fields, even though that
  // means "+ the typed value" for Toughness (lower T is worse) but "- the
  // typed value" for Save (a *higher* Sv number is worse).
  const rawToughness = Math.max(1, clampNum(unit.toughness, 4));
  const toughness = Math.max(1, rawToughness + clampNum(o.toughnessMod, 0));
  const rawSave = clampSave(unit.save, 3) || 7;
  const save = rawSave >= 7 ? 7 : Math.max(2, Math.min(7, rawSave - clampNum(o.saveMod, 0)));
  return {
    toughness,
    save,
    // Benefit of Cover (11th ed.): -1 to the attacker's Ballistic Skill
    // against ranged attacks — read by computeWeapon, not applied here,
    // since it worsens the hit roll rather than any defender characteristic.
    benefitOfCover: !!o.benefitOfCover,
    // Re-roll Saving Throws (of 1s, or all failed ones) — a defender-side
    // ability, so it lives here alongside the other defender modifiers
    // rather than in the attacker's bonus object.
    saveReroll: o.saveReroll || "none",
    invul: clampSave(unit.invul, 0),
    wounds: Math.max(1, clampNum(unit.wounds, 1)),
    models: o.models !== undefined && o.models !== null ? Math.max(0, clampNum(o.models, 1)) : totalModels(unit) || 1,
    fnp: clampSave(o.fnp !== undefined && o.fnp !== null ? o.fnp : unit.fnp, 0),
    psychicFnp: clampSave(unit.psychicFnp, 0),
    woundDebuff: o.woundDebuff !== undefined && o.woundDebuff !== null ? !!o.woundDebuff : !!unit.woundDebuff,
    damageReduction: Math.max(0, clampNum(o.damageReduction !== undefined && o.damageReduction !== null ? o.damageReduction : unit.damageReduction, 0)),
    keywords: o.keywords || unit.keywords || {},
  };
}

// ---------------------------------------------------------------------------
// New Recruit plain-text export parser (no combat stats available in this
// format — produces one placeholder weapon per unit, flagged needsStats)
// ---------------------------------------------------------------------------
function parseNewRecruitText(text) {
  const rawLines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  let faction = "";
  const factionLine = rawLines.find((l) => l.toUpperCase().startsWith("+ FACTION KEYWORD"));
  if (factionLine) {
    const value = factionLine.split(":").slice(1).join(":").trim();
    const segs = value.split("-").map((s) => s.trim()).filter(Boolean);
    faction = segs[segs.length - 1] || value;
  }

  const unitRegex = /^(?:[A-Za-z]+\d*:\s*)?(\d+)x\s+(.+?)\s*\((\d+)\s*pts?\)(?::\s*(.*))?$/i;
  const drafts = [];

  for (const line of rawLines) {
    if (line.startsWith("•") || line.startsWith("+") || line.startsWith("&")) continue;
    const m = line.match(unitRegex);
    if (!m) continue;
    const models = parseInt(m[1], 10) || 1;
    const baseName = m[2].trim();
    const points = m[3];
    const wargear = (m[4] || "").trim();
    drafts.push({ baseName, models, points, wargear });
  }

  const counts = {};
  drafts.forEach((d) => {
    counts[d.baseName] = (counts[d.baseName] || 0) + 1;
  });

  const units = drafts.map((d) => {
    const name = counts[d.baseName] > 1 ? `${d.baseName} (${d.points} pts)` : d.baseName;
    return {
      id: crypto.randomUUID(),
      faction: faction || "Neznámá frakce",
      name,
      points: d.points,
      toughness: 4,
      save: 3,
      invul: 0,
      wounds: 1,
      fnp: 0,
      woundDebuff: false,
      damageReduction: 0,
      members: [
        {
          id: crypto.randomUUID(),
          name: d.baseName,
          count: d.models,
          weapons: [
            {
              ...emptyWeapon(),
              name: d.wargear ? "Zbraň (uprav dle loadoutu)" : "Zbraň (uprav)",
              needsStats: true,
              note: d.wargear,
            },
          ],
        },
      ],
      needsStats: true,
      isLeader: false,
      isFavorite: false,
    };
  });

  return { faction, units };
}

// ---------------------------------------------------------------------------
// New Recruit "full text list" export (the newer app-export style: a list
// name/points header, faction/detachment lines, then one heading line per
// unit like "Wolf Guard Terminators (345 points)" followed by indented "•"
// wargear bullets). Unlike parseNewRecruitText above, this doesn't build new
// placeholder units — it only extracts (name, points) pairs so they can be
// matched against units the person already has in their library with real
// stats, to quickly assemble a named army for the cheat sheet without
// re-uploading a full JSON roster every time.
// ---------------------------------------------------------------------------
const ARMY_TEXT_SKIP_PATTERNS = /detachment|strike force|incursion|onslaught|combat patrol|exported with|data version/i;

function parseArmyTextForMatching(text) {
  const rawLines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (rawLines.length === 0) return { listName: "", entries: [] };

  // The list's own name is always the export's first line — strip a trailing
  // "(N points)" if present, but use the line either way rather than only
  // when that exact pattern matches (some export variants format it slightly
  // differently).
  const listName = rawLines[0].replace(/\s*\(\d+\s*points?\)\s*$/i, "").trim();

  const unitLineRegex = /^(.+?)\s*\((\d+)\s*points?\)$/i;
  const entries = [];
  // Units listed under the same "Attached Unit N" heading (a leader + the
  // unit it's leading) get merged into a single library entry on JSON import
  // — combined points, combined name. The plain text still lists them as
  // separate lines though, so each entry here also remembers which group
  // (if any) it belongs to, letting the matcher try the group's combined
  // points as a fallback against that merged entry.
  let groupIndex = 0;
  let inGroup = false;
  for (let i = 1; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (/^attached unit\b/i.test(line)) {
      groupIndex += 1;
      inGroup = true;
      continue;
    }
    if (/^(characters|other datasheets|attached units)$/i.test(line)) {
      inGroup = false;
      continue;
    }
    if (line.startsWith("•")) continue;
    if (ARMY_TEXT_SKIP_PATTERNS.test(line)) continue;
    const m = line.match(unitLineRegex);
    if (!m) continue;
    entries.push({ name: m[1].trim(), points: m[2], group: inGroup ? groupIndex : null });
  }

  const groupTotals = {};
  entries.forEach((e) => {
    if (e.group === null) return;
    groupTotals[e.group] = (groupTotals[e.group] || 0) + parseInt(e.points, 10);
  });
  entries.forEach((e) => {
    if (e.group !== null && groupTotals[e.group] !== undefined) {
      e.altPoints = String(groupTotals[e.group]);
    }
  });

  return { listName, entries };
}

// Tiered matching against the existing library: prefer an exact name+points
// match (handles multiple same-named units at different loadouts/costs);
// fall back to a unique exact name match; fall back to a unique "library name
// starts with this name" match (catches units renamed by the attached-leader
// merge, e.g. "Wolf Guard Terminators (vede Logan Grimnar)"). Anything still
// unresolved is reported back instead of guessed at.
function matchArmyEntriesToLibrary(entries, library) {
  const matchedIds = new Set();
  const unmatched = [];

  entries.forEach((entry) => {
    const nameLower = entry.name.toLowerCase();
    const pointsToTry = entry.altPoints ? [entry.points, entry.altPoints] : [entry.points];
    for (const pts of pointsToTry) {
      const exact = library.filter((u) => u.name.toLowerCase() === nameLower && String(u.points) === String(pts));
      if (exact.length > 0) {
        matchedIds.add(exact[0].id);
        return;
      }
    }
    // The group's combined points might also show up on a library entry
    // whose name is the *other* member of the pair with a "(vede X)"-style
    // suffix (the leader's own name never survives the merge) — try a
    // prefix match at the combined points before giving up on that tier.
    if (entry.altPoints) {
      const byPrefixAndPoints = library.filter((u) => u.name.toLowerCase().startsWith(nameLower) && String(u.points) === String(entry.altPoints));
      if (byPrefixAndPoints.length === 1) {
        matchedIds.add(byPrefixAndPoints[0].id);
        return;
      }
    }
    const byNameOnly = library.filter((u) => u.name.toLowerCase() === nameLower);
    if (byNameOnly.length === 1) {
      matchedIds.add(byNameOnly[0].id);
      return;
    }
    const byPrefix = library.filter((u) => u.name.toLowerCase().startsWith(nameLower));
    if (byPrefix.length === 1) {
      matchedIds.add(byPrefix[0].id);
      return;
    }
    unmatched.push(entry);
  });

  return { matchedIds: Array.from(matchedIds), unmatched };
}

// ---------------------------------------------------------------------------
// BattleScribe / New Recruit JSON roster parser — pulls real characteristics
// ---------------------------------------------------------------------------
function parseDiceAvg(text) {
  if (text === undefined || text === null) return 0;
  const t = String(text).trim();
  if (!t || t === "N/A" || t === "-") return 0;
  const m = /^(\d*)D(\d+)(?:\+(\d+))?$/i.exec(t);
  if (m) {
    const count = m[1] ? parseInt(m[1], 10) : 1;
    const die = parseInt(m[2], 10);
    const bonus = m[3] ? parseInt(m[3], 10) : 0;
    return count * ((die + 1) / 2) + bonus;
  }
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : 0;
}

// Full probability distribution for a dice-notation string like "D6", "2D6",
// "D3+3" — used to model "re-roll one damage roll" (see below), which needs
// the actual spread of outcomes, not just the average parseDiceAvg gives.
// Returns null for anything that isn't recognized dice notation (flat
// numbers, blank, "N/A", …), so callers can fall back to a no-op.
function parseDiceDistribution(text) {
  if (text === undefined || text === null) return null;
  const t = String(text).trim();
  if (!t) return null;
  const m = /^(\d*)D(\d+)(?:\+(\d+))?$/i.exec(t);
  if (!m) return null;
  const count = m[1] ? parseInt(m[1], 10) : 1;
  const die = parseInt(m[2], 10);
  const flatBonus = m[3] ? parseInt(m[3], 10) : 0;
  if (!count || !die || count > 10 || die > 20) return null;
  // Convolve `count` uniform 1..die dice together.
  let dist = new Map([[0, 1]]);
  for (let i = 0; i < count; i++) {
    const next = new Map();
    dist.forEach((p, sum) => {
      for (let face = 1; face <= die; face++) {
        const key = sum + face;
        next.set(key, (next.get(key) || 0) + p / die);
      }
    });
    dist = next;
  }
  if (flatBonus) {
    const shifted = new Map();
    dist.forEach((p, sum) => shifted.set(sum + flatBonus, p));
    dist = shifted;
  }
  return dist;
}

// "Re-roll one damage roll" (e.g. "you can re-roll the damage roll"): a
// rational player only takes the reroll when the roll came out low, keeping
// it otherwise. Finds the break-even threshold that maximizes the expected
// result — reroll totals at or below it, keep totals above it — and returns
// that expected value. For a plain D6 this lands on "re-roll 3 or less,
// keep 4+", matching how the ability plays out in practice.
function expectedValueWithOneReroll(dist) {
  const entries = Array.from(dist.entries()).sort((a, b) => a[0] - b[0]);
  const baseMean = entries.reduce((s, [v, p]) => s + v * p, 0);
  let best = baseMean;
  let cumP = 0;
  // Threshold t: reroll every value <= t, keep every value > t.
  for (const [t] of entries) {
    cumP += dist.get(t);
    const keptE = entries.filter(([x]) => x > t).reduce((s, [x, p]) => s + x * p, 0);
    const e = cumP * baseMean + keptE;
    if (e > best) best = e;
  }
  return best;
}

function parseHitVal(text) {
  if (!text) return 3;
  const t = String(text).trim();
  if (t.toUpperCase() === "N/A") return 1; // auto-hit (e.g. Torrent weapons)
  const n = parseInt(t.replace("+", ""), 10);
  return Number.isFinite(n) ? n : 3;
}

function parseSaveVal(text) {
  if (!text) return 0;
  const t = String(text).trim();
  if (t === "-" || t.toUpperCase() === "N/A") return 0;
  const n = parseInt(t.replace("+", ""), 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // A save/invulnerable characteristic is always a 2–6 die-roll target; clamp
  // defensively in case the source text is malformed, so it can never come out
  // as something like "40+".
  return Math.max(2, Math.min(6, n));
}

function parseIntSafe(text, fallback = 0) {
  if (text === undefined || text === null) return { value: fallback, ok: false };
  const t = String(text).trim();
  const n = parseInt(t.replace("+", ""), 10);
  return Number.isFinite(n) ? { value: n, ok: true } : { value: fallback, ok: false };
}

function parseWeaponCharacteristics(wc) {
  const keywords = (wc && wc.Keywords) || "";
  const lethalHits = /lethal hits/i.test(keywords);
  let sustained = 0;
  const susMatch = keywords.match(/sustained hits\s*(d?\d*)/i);
  if (susMatch) sustained = susMatch[1] ? parseDiceAvg(susMatch[1]) : 1;

  // Melta X: within half range, add X to the Damage characteristic. We can't
  // know actual table distance, so we store the value and let the person
  // toggle "within half range" per weapon for a given calculation.
  let melta = 0;
  const meltaMatch = keywords.match(/melta\s*(\d+)/i);
  if (meltaMatch) melta = parseInt(meltaMatch[1], 10) || 0;

  // Rapid Fire X: within half range, add X to the Attacks characteristic.
  // Same "can't know actual table distance" caveat as Melta above — stored
  // and toggled per weapon for a given calculation.
  let rapidFire = 0;
  const rapidFireMatch = keywords.match(/rapid fire\s*(\d+)/i);
  if (rapidFireMatch) rapidFire = parseInt(rapidFireMatch[1], 10) || 0;

  // Twin-linked: re-roll the wound roll for this weapon.
  const twinLinked = /twin-linked/i.test(keywords);

  // Anti-X Y+ (e.g. "Anti-Monster 3+") — only the keywords the app has a
  // toggle for on the defender side are recognized; anything else is left
  // as "none" for the person to set up manually if it matters.
  let antiKeyword = "none";
  let antiValue = 0;
  const antiMatch = keywords.match(/anti-(monster|vehicle|character)\s*(\d)\+?/i);
  if (antiMatch) {
    antiKeyword = antiMatch[1].toLowerCase();
    antiValue = parseInt(antiMatch[2], 10) || 0;
  }

  const isMelee = wc && wc.Range && String(wc.Range).trim().toLowerCase() === "melee";
  const hitText = wc ? (isMelee ? wc.WS : wc.BS) : null;
  const strengthParsed = wc ? parseIntSafe(wc.S, 4) : { value: 4, ok: true };

  return {
    type: isMelee ? "melee" : "ranged",
    attacks: wc ? parseDiceAvg(wc.A) || 1 : 1,
    hitX: wc ? parseHitVal(hitText) : 3,
    strength: strengthParsed.value,
    ap: wc ? -Math.abs(parseIntSafe(wc.AP, 0).value) : 0,
    damage: wc ? parseDiceAvg(wc.D) || 1 : 1,
    // Raw dice notation (e.g. "D6", "2D6") kept alongside the averaged
    // `damage` above so a "re-roll one damage roll" ability can be modeled
    // exactly instead of just off the average.
    damageDice: wc && wc.D ? String(wc.D).trim() : "",
    lethalHits,
    sustained,
    melta,
    rapidFire,
    antiKeyword,
    antiValue,
    twinLinked,
    rerollHit: "none",
    rerollWound: twinLinked ? "all" : "none",
    needsStats: !strengthParsed.ok,
    note: wc ? [wc.Range, keywords].filter(Boolean).join(" · ") : "",
  };
}

// New Recruit lists each attack profile of a multi-profile melee weapon (e.g. an
// Axe with separate "Sweep" and "Strike" profiles) as its own entry under the
// same wargear selection. A model can only ever use ONE of them per fight, so we
// group profiles from the same node together and treat them as alternates of a
// single weapon rather than adding both.
function cleanProfileLabel(name, groupName) {
  let n = String(name || "").replace(/^[➤▶►\s]+/, "").trim();
  const prefix = `${groupName} - `;
  if (n.startsWith(prefix)) n = n.slice(prefix.length);
  return n || name || "";
}

// Picks a sensible default profile when a weapon has more than one (e.g. Sweep
// vs Strike) — whichever deals more expected damage against a generic mid-tier
// target (T4, 3+ save), so the default at least reflects a real trade-off rather
// than an arbitrary pick. The user can still switch it in the unit editor.
function pickDefaultProfileIndex(profiles) {
  const genericDef = { toughness: 4, save: 3, invul: 0, wounds: 1, models: 1, fnp: 0, woundDebuff: false, damageReduction: 0 };
  const genericBonus = { lethalHits: false, sustained: 0, rerollHit: "none", rerollWound: "none", apMod: 0, hitMod: 0, woundMod: 0 };
  let bestIdx = 0;
  let bestDmg = -1;
  profiles.forEach((p, i) => {
    const r = computeWeapon(p, 1, genericDef, genericBonus);
    if (r.totalDamage > bestDmg) {
      bestDmg = r.totalDamage;
      bestIdx = i;
    }
  });
  return bestIdx;
}

// Scans a unit's own ability descriptions for two common defensive rules text
// patterns: "Feel No Pain X+" and "subtract/reduce ... Damage characteristic
// ... by N" (e.g. a C'tan Shard's damage-reduction ability) — so both get
// applied automatically instead of needing to be typed in by hand every time.
function detectDefensiveAbilities(topSel) {
  let fnp = 0;
  let damageReduction = 0;
  const checkText = (text) => {
    const fnpMatch = text.match(/feel no pain[^\d]{0,12}(\d)\s*\+/i);
    if (fnpMatch) {
      const v = parseInt(fnpMatch[1], 10);
      if (Number.isFinite(v) && (fnp === 0 || v < fnp)) fnp = v;
    }
    const dmgMatch = text.match(/subtract (\d+) from the damage characteristic|reduce(?:s|d)? the damage characteristic[^.]*by (\d+)|damage characteristic[^.]*(?:reduced|worsened|subtract(?:ed)?)[^.]*by (\d+)/i);
    if (dmgMatch) {
      const v = parseInt(dmgMatch[1] || dmgMatch[2] || dmgMatch[3], 10);
      if (Number.isFinite(v) && v > damageReduction) damageReduction = v;
    } else if (/damage characteristic/i.test(text) && /(reduced|worsened|subtract)/i.test(text) && /\bby 1\b/i.test(text)) {
      damageReduction = Math.max(damageReduction, 1);
    }
  };
  const scan = (node) => {
    // Generic named rules (e.g. "Feel No Pain 5+") live in their own "rules"
    // array — separate from "profiles" — with the actual value usually in the
    // rule's own name rather than its description text.
    (node.rules || []).forEach((r) => {
      checkText(`${r.name || ""} ${r.description || ""}`);
    });
    // Datasheet-specific abilities (e.g. a C'tan's damage-reduction rule) show
    // up as "Abilities"-typeName profiles instead, with the value in either
    // the profile's own name or its characteristic text.
    (node.profiles || []).forEach((p) => {
      const nameText = p.name || "";
      const bodyText = (p.characteristics || []).map((c) => c["$text"] || "").join(" ");
      checkText(`${nameText} ${bodyText}`);
    });
    (node.selections || []).forEach(scan);
  };
  scan(topSel);
  return { fnp, damageReduction };
}

// Scans a unit's own ability text for offensive "re-roll Hit/Wound rolls
// against a keyword" abilities (e.g. a Grand Master in Nemesis Dreadknight:
// "Each time this model makes a melee attack that targets a Monster or
// Vehicle unit, you can re-roll the Hit roll [and] Wound roll") — applied
// automatically to every matching weapon on import instead of needing to be
// ticked by hand. Scoped to melee/ranged/both depending on the ability text;
// the Damage-roll part of such abilities isn't modeled (Damage here is
// already an averaged value, not a live per-attack die roll).
function detectOffensiveRerollAbilities(topSel) {
  const result = { melee: { monster: false, vehicle: false, character: false }, ranged: { monster: false, vehicle: false, character: false } };
  const checkText = (text) => {
    if (!/re-?roll/i.test(text)) return;
    if (!/hit roll/i.test(text) && !/wound roll/i.test(text)) return;
    const scopes = [];
    if (/melee attack/i.test(text)) scopes.push("melee");
    if (/ranged attack/i.test(text)) scopes.push("ranged");
    if (scopes.length === 0) scopes.push("melee", "ranged");
    const kws = [];
    if (/\bmonster\b/i.test(text)) kws.push("monster");
    if (/\bvehicle\b/i.test(text)) kws.push("vehicle");
    if (/\bcharacter\b/i.test(text)) kws.push("character");
    if (kws.length === 0) return;
    scopes.forEach((s) => kws.forEach((k) => (result[s][k] = true)));
  };
  const scan = (node) => {
    (node.rules || []).forEach((r) => checkText(`${r.name || ""} ${r.description || ""}`));
    (node.profiles || []).forEach((p) => {
      const nameText = p.name || "";
      const bodyText = (p.characteristics || []).map((c) => c["$text"] || "").join(" ");
      checkText(`${nameText} ${bodyText}`);
    });
    (node.selections || []).forEach(scan);
  };
  scan(topSel);
  return result;
}

function extractUnitChars(up) {
  const uc = {};
  (up.characteristics || []).forEach((c) => {
    uc[c.name] = c["$text"];
  });
  return {
    toughness: parseIntSafe(uc.T, 4).value,
    save: parseSaveVal(uc.Sv),
    invul: parseSaveVal(uc.InSv),
    wounds: parseIntSafe(uc.W, 1).value,
    // Rare, but some data sources list Feel No Pain as its own characteristic
    // column right alongside T/Sv/W rather than as ability description text.
    fnp: parseSaveVal(uc.FNP || uc["Feel No Pain"] || uc.FNPSave || uc.FnP),
  };
}

function parseBattleScribeJSON(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return null;
  }
  const roster = data && data.roster ? data.roster : data;
  if (!roster || !Array.isArray(roster.forces)) return null;

  const armyUnits = [];

  for (const force of roster.forces) {
    const catalogueName = force.catalogueName || "";
    const segs = catalogueName.split("-").map((s) => s.trim()).filter(Boolean);
    const faction = segs[segs.length - 1] || catalogueName || "Neznámá frakce";

    const findUnitProfile = (node) => (node.profiles || []).find((p) => p.typeName === "Unit");

    // "number" on a weapon-selection node is ambiguous in New Recruit's export:
    // for infantry it usually equals the model-line's own model count (one weapon
    // per model), but for a single model carrying multiple copies of the same
    // weapon (e.g. a Land Raider Redeemer's 2x Flamestorm Cannon) it's the copy
    // count instead. Dividing by the model-line's own count disambiguates both.
    // Multiple weapon-typeName profiles found on the SAME node (like Sweep/Strike
    // on one Axe) are grouped together as alternate profiles of one weapon.
    const collectWeaponsLocal = (node, weapons, modelCount) => {
      const profilesHere = (node.profiles || []).filter((p) => p.typeName === "Ranged Weapons" || p.typeName === "Melee Weapons");
      if (profilesHere.length > 0) {
        const rawNumber = node.number || 1;
        const copies = modelCount > 0 ? Math.max(1, Math.round(rawNumber / modelCount)) : 1;
        weapons.push({ profiles: profilesHere, copies, groupName: node.name });
      }
      (node.selections || []).forEach((child) => {
        if (findUnitProfile(child)) return;
        collectWeaponsLocal(child, weapons, modelCount);
      });
    };

    const collectMembers = (node, members) => {
      const up = findUnitProfile(node);
      if (up) {
        const modelCount = node.number || 1;
        const weaponGroups = [];
        collectWeaponsLocal(node, weaponGroups, modelCount);
        const weapons = weaponGroups.map((wg) => {
          const builtProfiles = wg.profiles.map((p) => {
            const wc = {};
            (p.characteristics || []).forEach((c) => {
              wc[c.name] = c["$text"];
            });
            return { name: cleanProfileLabel(p.name, wg.groupName), ...parseWeaponCharacteristics(wc) };
          });
          const displayName = wg.copies > 1 ? `${wg.copies}x ${wg.groupName}` : wg.groupName;
          const base = { id: crypto.randomUUID(), name: displayName, copies: wg.copies };
          if (builtProfiles.length <= 1) {
            return { ...base, ...builtProfiles[0] };
          }
          const activeIdx = pickDefaultProfileIndex(builtProfiles);
          const anyNeedsStats = builtProfiles.some((p) => p.needsStats);
          return { ...base, ...builtProfiles[activeIdx], needsStats: anyNeedsStats, profiles: builtProfiles, activeProfileIndex: activeIdx };
        });
        members.push({
          id: crypto.randomUUID(),
          name: node.name,
          count: modelCount,
          chars: extractUnitChars(up),
          weapons,
        });
      }
      (node.selections || []).forEach((child) => collectMembers(child, members));
    };

    for (const topSel of force.selections || []) {
      const members = [];
      collectMembers(topSel, members);
      if (members.length === 0) continue;

      const needsStats = members.some((m) => m.weapons.some((w) => w.needsStats));
      const isLeader = (topSel.categories || []).some((c) => (c.name || "").trim().toLowerCase() === "leader");
      const categoryNames = (topSel.categories || []).map((c) => (c.name || "").trim().toLowerCase());
      const keywords = {
        monster: categoryNames.includes("monster"),
        vehicle: categoryNames.includes("vehicle"),
        character: categoryNames.includes("character"),
      };
      const ptsCost = (topSel.costs || []).find((c) => c.name === "pts");
      const points = ptsCost ? String(ptsCost.value) : "";
      const defensiveAbilities = detectDefensiveAbilities(topSel);

      const offensiveRerolls = detectOffensiveRerollAbilities(topSel);
      members.forEach((m) => {
        m.weapons.forEach((w) => {
          const scope = w.type === "melee" ? offensiveRerolls.melee : offensiveRerolls.ranged;
          if (scope.monster || scope.vehicle || scope.character) {
            const existing = w.rerollVsKeywords || {};
            w.rerollVsKeywords = {
              monster: existing.monster || scope.monster,
              vehicle: existing.vehicle || scope.vehicle,
              character: existing.character || scope.character,
            };
          }
        });
      });

      armyUnits.push({
        id: crypto.randomUUID(),
        sourceId: topSel.id,
        associations: topSel.associations || [],
        faction,
        name: topSel.name,
        points,
        members, // still carrying .chars per member at this point — stripped after merge below
        needsStats,
        isLeader,
        keywords,
        fnp: defensiveAbilities.fnp,
        damageReduction: defensiveAbilities.damageReduction,
      });
    }
  }

  // Fold attached leaders (e.g. "Logan Grimnar" Leading "Wolf Guard Terminators") into
  // the unit they lead, so their weapons count as part of that unit's total output —
  // this mirrors how an attached character actually fights as part of the unit.
  const bySource = new Map(armyUnits.map((u) => [u.sourceId, u]));
  const toRemove = new Set();
  armyUnits.forEach((u) => {
    (u.associations || []).forEach((a) => {
      if (a.action === "group" && bySource.has(a.to)) {
        const target = bySource.get(a.to);
        if (target && target !== u) {
          target.members = [...target.members, ...u.members];
          target.name = `${target.name} (vede ${u.name})`;
          target.needsStats = target.needsStats || u.needsStats;
          const p1 = parseInt(target.points, 10);
          const p2 = parseInt(u.points, 10);
          if (Number.isFinite(p1) && Number.isFinite(p2)) target.points = String(p1 + p2);
          toRemove.add(u.id);
        }
      }
    });
  });

  const finalUnits = armyUnits
    .filter((u) => !toRemove.has(u.id))
    .map((u) => {
      const weightedPick = (key) => {
        const tally = new Map();
        u.members.forEach((m) => {
          const v = m.chars[key];
          tally.set(v, (tally.get(v) || 0) + m.count);
        });
        let best = null;
        let bestW = -1;
        tally.forEach((w, v) => {
          if (w > bestW) {
            bestW = w;
            best = v;
          }
        });
        return best;
      };
      const total = u.members.reduce((s, m) => s + m.count, 0);
      const weightedWounds = total > 0 ? u.members.reduce((s, m) => s + m.count * m.chars.wounds, 0) / total : 1;
      // FNP can come from either the ability-text scan (u.fnp) or a direct FNP
      // characteristic column on the member's Unit profile (m.chars.fnp) —
      // whichever actually found a value wins (prefer the lower/better one).
      const charsFnp = weightedPick("fnp") || 0;
      const combinedFnp = u.fnp > 0 && charsFnp > 0 ? Math.min(u.fnp, charsFnp) : u.fnp || charsFnp || 0;

      return {
        id: u.id,
        faction: u.faction,
        name: u.name,
        points: u.points,
        toughness: weightedPick("toughness"),
        save: weightedPick("save"),
        invul: weightedPick("invul"),
        wounds: Math.round(weightedWounds * 100) / 100,
        fnp: combinedFnp,
        woundDebuff: false,
        damageReduction: u.damageReduction || 0,
        keywords: u.keywords || { monster: false, vehicle: false, character: false },
        members: u.members.map((m) => ({ id: m.id, name: m.name, count: m.count, weapons: m.weapons })),
        needsStats: u.needsStats,
        isLeader: u.isLeader,
        isFavorite: false,
      };
    });

  return finalUnits;
}

// ---------------------------------------------------------------------------
// UI primitives
// ---------------------------------------------------------------------------
function NumberField({ label, value, onChange, step = 1, min, hint, small }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: small ? 11 : 12.5, color: "var(--label)", fontWeight: 600, letterSpacing: 0.2 }}>{label}</span>
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        onChange={(e) => onChange(clampNum(e.target.value))}
        className="wh40k-input"
        style={{
          background: "var(--field-bg)",
          border: "1px solid var(--field-border)",
          borderRadius: 6,
          color: "var(--text)",
          padding: small ? "5px 7px" : "7px 9px",
          fontSize: small ? 12.5 : 14,
          fontFamily: "var(--mono)",
          width: "100%",
          boxSizing: "border-box",
        }}
      />
      {hint && <span style={{ fontSize: 10.5, color: "var(--muted)" }}>{hint}</span>}
    </label>
  );
}

function TextField({ label, value, onChange, placeholder, small }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: small ? 11 : 12.5, color: "var(--label)", fontWeight: 600 }}>{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="wh40k-input"
        style={{
          background: "var(--field-bg)",
          border: "1px solid var(--field-border)",
          borderRadius: 6,
          color: "var(--text)",
          padding: small ? "5px 7px" : "7px 9px",
          fontSize: small ? 12.5 : 14,
          width: "100%",
          boxSizing: "border-box",
        }}
      />
    </label>
  );
}

function SelectField({ label, value, onChange, options, small }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: small ? 11 : 12.5, color: "var(--label)", fontWeight: 600 }}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="wh40k-select"
        style={{
          background: "var(--field-bg)",
          border: "1px solid var(--field-border)",
          borderRadius: 6,
          color: "var(--text)",
          padding: small ? "5px 7px" : "7px 9px",
          fontSize: small ? 12.5 : 14,
          width: "100%",
          boxSizing: "border-box",
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ToggleField({ label, value, onChange, small, hint }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: small ? 11 : 12.5, color: "var(--label)", fontWeight: 600 }}>{label}</span>
      <button
        onClick={() => onChange(!value)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: value ? "var(--accent-dim)" : "var(--field-bg)",
          border: `1px solid ${value ? "var(--accent)" : "var(--field-border)"}`,
          borderRadius: 6,
          color: value ? "var(--accent-text)" : "var(--text)",
          padding: small ? "5px 7px" : "7px 9px",
          fontSize: small ? 12 : 13,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        {value ? "ANO" : "NE"}
      </button>
      {hint && <span style={{ fontSize: 10.5, color: "var(--muted)" }}>{hint}</span>}
    </div>
  );
}

function Row({ children, cols = 3 }) {
  return <div className={`wh40k-row wh40k-row-${cols}`}>{children}</div>;
}

function SectionLabel({ children }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "var(--muted)", margin: "12px 0 6px" }}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Weapon / member editors (used inside the unit form)
// ---------------------------------------------------------------------------
function WeaponEditor({ weapon, onChange, onRemove }) {
  const set = (k) => (v) => onChange({ ...weapon, [k]: v });
  const setRerollKw = (k) => (v) => onChange({ ...weapon, rerollVsKeywords: { ...(weapon.rerollVsKeywords || {}), [k]: v } });
  return (
    <div style={{ background: "var(--field-bg)", border: "1px solid var(--field-border)", borderRadius: 8, padding: 10, marginTop: 6 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 6 }}>
        <div style={{ flex: 1 }}>
          <TextField label="Název zbraně" value={weapon.name} onChange={set("name")} small />
        </div>
        <div style={{ width: 130 }}>
          <SelectField label="Typ" value={weapon.type} onChange={set("type")} options={WEAPON_TYPE_OPTIONS} small />
        </div>
        <button
          onClick={onRemove}
          title="Odebrat zbraň"
          style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer", padding: 6 }}
        >
          <Trash2 size={14} />
        </button>
      </div>
      <Row cols={3}>
        <NumberField label="Útoků" value={weapon.attacks} onChange={set("attacks")} min={0} small />
        <NumberField label={weapon.type === "melee" ? "Zásah WS (X+)" : "Zásah BS (X+)"} value={weapon.hitX} onChange={set("hitX")} min={1} small />
        <NumberField label="Síla (S)" value={weapon.strength} onChange={set("strength")} min={0} small />
      </Row>
      <Row cols={3}>
        <NumberField label="AP" value={weapon.ap} onChange={set("ap")} small />
        <NumberField label="Damage" value={weapon.damage} onChange={set("damage")} min={0} small />
        <NumberField label="Kopií na model" value={weapon.copies || 1} onChange={set("copies")} min={1} hint="např. 2x Flamestorm Cannon" small />
      </Row>
      <Row cols={4}>
        <ToggleField label="Lethal Hits" value={weapon.lethalHits} onChange={set("lethalHits")} small />
        <NumberField label="Sustained (extra)" value={weapon.sustained} onChange={set("sustained")} min={0} small />
        <SelectField label="Přehoz hit rollu" value={weapon.rerollHit} onChange={set("rerollHit")} options={REROLL_OPTIONS} small />
        <SelectField label="Přehoz wound rollu" value={weapon.rerollWound} onChange={set("rerollWound")} options={REROLL_OPTIONS} small />
      </Row>
      <Row cols={3}>
        <NumberField
          label="Critical Hit na (X+)"
          value={weapon.critHitsOn || 6}
          onChange={set("critHitsOn")}
          min={2}
          hint="normálně 6; např. Critical Hits on 5+"
          small
        />
        <NumberField
          label="Critical Wound na (X+)"
          value={weapon.critWoundOn || 6}
          onChange={set("critWoundOn")}
          min={2}
          hint="normálně 6; např. Critical Wounds on 5+"
          small
        />
        <ToggleField
          label="Devastating Wounds"
          value={weapon.devastatingWounds}
          onChange={set("devastatingWounds")}
          hint="Critical Wound = mortal wounds mimo jakýkoli save"
          small
        />
      </Row>
      <Row cols={2}>
        <ToggleField label="Přehoz 1 hitu (jednorázově)" value={weapon.rerollOneHit} onChange={set("rerollOneHit")} small />
        <ToggleField label="Přehoz 1 woundu (jednorázově)" value={weapon.rerollOneWound} onChange={set("rerollOneWound")} small />
      </Row>
      <Row cols={2}>
        <TextField
          label="Kostky Damage (nepovinné)"
          value={weapon.damageDice || ""}
          onChange={set("damageDice")}
          placeholder="např. D6, 2D6, D3+3"
          small
        />
        <ToggleField
          label="Přehoz 1 damage rollu (jednorázově)"
          value={weapon.rerollOneDamage}
          onChange={set("rerollOneDamage")}
          hint={weapon.damageDice ? undefined : "vyžaduje vyplněné kostky Damage výše"}
          small
        />
      </Row>
      <Row cols={2}>
        <ToggleField
          label="Psychický útok (Psychic)"
          value={weapon.isPsychic}
          onChange={set("isPsychic")}
          hint="pro obránce s FNP jen proti Psychic Attacks (např. Culexus)"
          small
        />
        <div />
      </Row>
      <Row cols={2}>
        <NumberField
          label="Melta (0 = žádná)"
          value={weapon.melta || 0}
          onChange={set("melta")}
          min={0}
          hint="+X k Damage v polovičním dosahu (Twin-linked = přehoz zranění vše)"
          small
        />
        <NumberField
          label="Rapid Fire (0 = žádný)"
          value={weapon.rapidFire || 0}
          onChange={set("rapidFire")}
          min={0}
          hint="+X útoků v polovičním dosahu (Rapid Fire 2 = +2 Attacks)"
          small
        />
      </Row>
      <Row cols={2}>
        <SelectField
          label="Anti- klíčové slovo"
          value={weapon.antiKeyword || "none"}
          onChange={set("antiKeyword")}
          options={ANTI_KEYWORD_OPTIONS}
          small
        />
        <NumberField
          label="Anti- práh (X+)"
          value={weapon.antiValue || 0}
          onChange={set("antiValue")}
          min={2}
          hint="proti tomuto klíč. slovu automaticky zraní na tento hod"
          small
        />
      </Row>
      <div style={{ marginTop: 2 }}>
        <div style={{ fontSize: 11, color: "var(--label)", fontWeight: 600, marginBottom: 4 }}>Přehoz vše (zásah i zranění) proti klíč. slovu</div>
        <Row cols={3}>
          <ToggleField label="vs MONSTER" value={!!(weapon.rerollVsKeywords || {}).monster} onChange={setRerollKw("monster")} small />
          <ToggleField label="vs VEHICLE" value={!!(weapon.rerollVsKeywords || {}).vehicle} onChange={setRerollKw("vehicle")} small />
          <ToggleField label="vs CHARACTER" value={!!(weapon.rerollVsKeywords || {}).character} onChange={setRerollKw("character")} small />
        </Row>
        <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: -2, marginBottom: 6 }}>např. GMNDK proti MONSTER i VEHICLE zároveň</div>
      </div>
      {weapon.note && <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 2 }}>{weapon.note}</div>}
    </div>
  );
}

function MemberEditor({ member, onChange, onRemove }) {
  const setField = (k) => (v) => onChange({ ...member, [k]: v });
  const setWeapon = (idx) => (w) => {
    const weapons = member.weapons.slice();
    weapons[idx] = w;
    onChange({ ...member, weapons });
  };
  const addWeapon = () => onChange({ ...member, weapons: [...member.weapons, emptyWeapon()] });
  const removeWeapon = (idx) => onChange({ ...member, weapons: member.weapons.filter((_, i) => i !== idx) });

  return (
    <div style={{ background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 8, padding: 10, marginTop: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <div style={{ flex: 1 }}>
          <TextField label="Název modelu / role" value={member.name} onChange={setField("name")} small />
        </div>
        <div style={{ width: 90 }}>
          <NumberField label="Počet" value={member.count} onChange={setField("count")} min={0} small />
        </div>
        <button onClick={onRemove} title="Odebrat model" style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer", padding: 6 }}>
          <Trash2 size={14} />
        </button>
      </div>
      {member.weapons.map((w, idx) => (
        <WeaponEditor key={w.id} weapon={w} onChange={setWeapon(idx)} onRemove={() => removeWeapon(idx)} />
      ))}
      <button
        onClick={addWeapon}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          border: "1px dashed var(--field-border)",
          background: "transparent",
          color: "var(--text)",
          borderRadius: 6,
          padding: "5px 10px",
          fontSize: 12,
          cursor: "pointer",
          marginTop: 6,
        }}
      >
        <Plus size={12} /> Přidat zbraň
      </button>
    </div>
  );
}

function UnitForm({ initial, onSave, onCancel }) {
  const [u, setU] = useState(initial);
  const set = (k) => (v) => setU((s) => ({ ...s, [k]: v }));
  const setKeyword = (k) => (v) => setU((s) => ({ ...s, keywords: { ...(s.keywords || {}), [k]: v } }));

  const setMember = (idx) => (m) => {
    const members = u.members.slice();
    members[idx] = m;
    setU((s) => ({ ...s, members }));
  };
  const addMember = () => setU((s) => ({ ...s, members: [...s.members, emptyMember()] }));
  const removeMember = (idx) => setU((s) => ({ ...s, members: s.members.filter((_, i) => i !== idx) }));

  return (
    <div style={{ background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 10, padding: 16, marginTop: 10 }}>
      {u.needsStats && (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            background: "var(--accent-dim)",
            border: "1px solid var(--accent)",
            borderRadius: 6,
            padding: "8px 10px",
            marginBottom: 12,
            fontSize: 12,
            color: "var(--accent-text)",
          }}
        >
          <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>Některé hodnoty jsou zástupné nebo nejisté (např. síla zbraně &quot;User&quot;) — zkontroluj je před uložením.</span>
        </div>
      )}

      <Row cols={3}>
        <TextField label="Frakce" value={u.faction} onChange={set("faction")} placeholder="např. Space Wolves" />
        <div style={{ gridColumn: "span 2" }}>
          <TextField label="Název jednotky" value={u.name} onChange={set("name")} placeholder="např. Wolf Guard Terminators" />
        </div>
      </Row>

      <SectionLabel>Obranné staty jednotky (T / Sv / Invul / Wounds na model)</SectionLabel>
      <Row cols={4}>
        <NumberField label="Odolnost (T)" value={u.toughness} onChange={set("toughness")} min={0} />
        <NumberField label="Save (X+)" value={u.save} onChange={set("save")} min={1} />
        <NumberField label="Invul (0 = žádný)" value={u.invul} onChange={set("invul")} min={0} />
        <NumberField label="Wounds na model" value={u.wounds} onChange={set("wounds")} min={0} />
      </Row>
      <Row cols={2}>
        <NumberField
          label="Base (mm, pro Desku)"
          value={u.baseSize || 32}
          onChange={set("baseSize")}
          min={1}
          hint="průměr base pro token na Desce"
        />
        <div />
      </Row>
      <Row cols={3}>
        <NumberField label="Feel No Pain (0 = žádný)" value={u.fnp} onChange={set("fnp")} min={0} />
        <NumberField
          label="FNP proti Psychic (0 = žádný)"
          value={u.psychicFnp || 0}
          onChange={set("psychicFnp")}
          min={0}
          hint="jen proti zbraním označeným jako Psychic, např. Culexus Assassin"
        />
        <ToggleField label="Může vést jednotku (Leader)" value={u.isLeader} onChange={set("isLeader")} hint="jen jednotky s touto schopností lze připojit jako vůdce" />
      </Row>
      <Row cols={3}>
        <ToggleField
          label="Debuff: -1 WR pokud S > T"
          value={u.woundDebuff}
          onChange={set("woundDebuff")}
          hint="ztíží hod na zranění, když má útočník vyšší sílu než tato jednotka toughness"
        />
      </Row>
      <Row cols={3}>
        <NumberField
          label="Redukce damage (0 = žádná)"
          value={u.damageReduction}
          onChange={set("damageReduction")}
          min={0}
          hint="např. C'tan Shard: -1 k Damage každého útoku, min. 1"
        />
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end", fontSize: 12, color: "var(--muted)" }}>
          Celkem modelů v jednotce: <b style={{ color: "var(--text)" }}>{totalModels(u)}</b>
        </div>
      </Row>
      <Row cols={3}>
        <ToggleField label="Klíčové slovo: MONSTER" value={!!(u.keywords || {}).monster} onChange={setKeyword("monster")} hint="pro Anti-MONSTER X+ u útočníkových zbraní" small />
        <ToggleField label="Klíčové slovo: VEHICLE" value={!!(u.keywords || {}).vehicle} onChange={setKeyword("vehicle")} hint="pro Anti-VEHICLE X+ u útočníkových zbraní" small />
        <ToggleField label="Klíčové slovo: CHARACTER" value={!!(u.keywords || {}).character} onChange={setKeyword("character")} hint="pro Anti-CHARACTER X+ u útočníkových zbraní" small />
        <ToggleField label="Klíčové slovo: INFANTRY" value={!!(u.keywords || {}).infantry} onChange={setKeyword("infantry")} hint="pro Anti-INFANTRY X+ u útočníkových zbraní" small />
      </Row>

      <SectionLabel>Modely a jejich zbraně</SectionLabel>
      {u.members.map((m, idx) => (
        <MemberEditor key={m.id} member={m} onChange={setMember(idx)} onRemove={() => removeMember(idx)} />
      ))}
      <button
        onClick={addMember}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          border: "1px dashed var(--field-border)",
          background: "transparent",
          color: "var(--text)",
          borderRadius: 6,
          padding: "7px 12px",
          fontSize: 12.5,
          cursor: "pointer",
          marginTop: 8,
        }}
      >
        <Plus size={13} /> Přidat skupinu modelů
      </button>

      <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
        <button
          onClick={onCancel}
          style={{ border: "1px solid var(--field-border)", background: "transparent", color: "var(--text)", borderRadius: 6, padding: "7px 14px", fontSize: 13, cursor: "pointer" }}
        >
          Zrušit
        </button>
        <button
          onClick={() => {
            if (!u.name.trim()) return;
            onSave({ ...u, needsStats: false });
          }}
          className="wh40k-btn"
          style={{
            border: "none",
            background: "var(--accent)",
            color: "var(--accent-on)",
            borderRadius: 6,
            padding: "7px 14px",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <Save size={14} /> Uložit jednotku
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Import box
// ---------------------------------------------------------------------------
function ImportBox({ onImport }) {
  const [text, setText] = useState("");
  const [summary, setSummary] = useState(null);
  const [fileName, setFileName] = useState("");

  const handleFile = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => setText(String(ev.target.result || ""));
    reader.onerror = () => setSummary({ error: true, message: "Soubor se nepodařilo přečíst." });
    reader.readAsText(file);
  };

  const handleImport = () => {
    const trimmed = text.trim();
    if (!trimmed) return;

    if (trimmed.startsWith("{")) {
      const units = parseBattleScribeJSON(trimmed);
      if (!units || units.length === 0) {
        setSummary({ error: true, message: "Nepodařilo se rozpoznat strukturu JSON rosteru. Zkontroluj, že jde o export z New Recruit / BattleScribe." });
        return;
      }
      let rosterName = "";
      try {
        const parsed = JSON.parse(trimmed);
        rosterName = (parsed && parsed.roster && parsed.roster.name) || "";
      } catch (e) {
        rosterName = "";
      }
      // Roster export often has no name set in New Recruit — fall back to
      // something so this import always ends up selectable as one army in
      // the cheat sheet, instead of silently skipping army creation.
      if (!rosterName.trim()) {
        rosterName = `${units[0]?.faction || "Import"} ${new Date().toLocaleDateString("cs-CZ")}`;
      }
      const flagged = units.filter((u) => u.needsStats).length;
      const { added, skipped } = onImport(units, rosterName);
      setSummary({ error: false, count: added, skipped, faction: units[0]?.faction, flagged, full: true, rosterName });
      setText("");
      setFileName("");
      return;
    }

    const { faction, units } = parseNewRecruitText(trimmed);
    if (units.length === 0) {
      setSummary({ error: true, message: "Ve vloženém textu se nepodařilo najít žádné jednotky." });
      return;
    }
    const { added, skipped } = onImport(units);
    setSummary({ error: false, faction, count: added, skipped, full: false });
    setText("");
    setFileName("");
  };

  return (
    <div style={{ background: "var(--field-bg)", border: "1px dashed var(--field-border)", borderRadius: 8, padding: 12, marginTop: 10 }}>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>
        Nahraj JSON export z New Recruit (soubor, nebo vlož obsah níže) — vytáhnou se z něj i skutečné bojové staty
        pro každý model i zbraň v jednotce. Jde to i s obyčejným textovým exportem, ale ten staty neobsahuje a doplní
        se placeholder, který si pak upravíš ručně.
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            border: "1px solid var(--field-border)",
            borderRadius: 6,
            padding: "6px 12px",
            fontSize: 12.5,
            cursor: "pointer",
            color: "var(--text)",
          }}
        >
          <Upload size={13} /> Nahrát soubor (.json)
          <input type="file" accept=".json,application/json" onChange={handleFile} style={{ display: "none" }} />
        </label>
        {fileName && <span style={{ fontSize: 12, color: "var(--muted)" }}>{fileName}</span>}
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="…nebo sem vlož obsah JSON / textového exportu přímo…"
        rows={5}
        style={{
          width: "100%",
          boxSizing: "border-box",
          background: "var(--panel)",
          border: "1px solid var(--field-border)",
          borderRadius: 6,
          color: "var(--text)",
          padding: "8px 9px",
          fontSize: 12,
          fontFamily: "var(--mono)",
          resize: "vertical",
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
        <button
          onClick={handleImport}
          className="wh40k-btn"
          style={{ display: "flex", alignItems: "center", gap: 6, border: "none", background: "var(--accent)", color: "var(--accent-on)", borderRadius: 6, padding: "7px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
        >
          <Upload size={14} /> Naimportovat
        </button>
        {summary && !summary.error && summary.full && (
          <span style={{ fontSize: 12, color: "var(--muted)" }}>
            Naimportováno {summary.count} jednotek {summary.faction ? `(${summary.faction})` : ""} se skutečnými staty.
            {summary.skipped > 0 && <> {summary.skipped}× už v knihovně bylo identické, přeskočeno.</>}
            {summary.flagged > 0 && <> {summary.flagged}× nešlo bezpečně rozpoznat sílu zbraně — zkontroluj ručně.</>}
            {summary.rosterName && (
              <>
                {" "}
                Uloženo jako armáda "{summary.rosterName}".
              </>
            )}
          </span>
        )}
        {summary && !summary.error && !summary.full && (
          <span style={{ fontSize: 12, color: "var(--muted)" }}>
            Naimportováno {summary.count} jednotek {summary.faction ? `(${summary.faction})` : ""} — doplň jim bojové staty.
            {summary.skipped > 0 && <> {summary.skipped}× už v knihovně bylo identické, přeskočeno.</>}
          </span>
        )}
        {summary && summary.error && <span style={{ fontSize: 12, color: "#e0857c" }}>{summary.message}</span>}
      </div>
    </div>
  );
}

function ArmyTextMatchBox({ onMatch }) {
  const [text, setText] = useState("");
  const [summary, setSummary] = useState(null);

  const handleMatch = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const result = onMatch(trimmed);
    setSummary(result);
    if (!result.error) setText("");
  };

  return (
    <div style={{ background: "var(--field-bg)", border: "1px dashed var(--field-border)", borderRadius: 8, padding: 12, marginTop: 10 }}>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>
        Vlož prostý textový export listu z New Recruit (jen jména a body, žádné staty). Appka jednotky spáruje podle
        jména a bodů s tím, co už máš v knihovně, a uloží/aktualizuje z nich armádu pro cheat sheet. Jednotky, které
        se nenajdou, je potřeba mít nejdřív v knihovně (naimportované z JSON).
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="…sem vlož textový export listu…"
        rows={5}
        style={{
          width: "100%",
          boxSizing: "border-box",
          background: "var(--panel)",
          border: "1px solid var(--field-border)",
          borderRadius: 6,
          color: "var(--text)",
          padding: "8px 9px",
          fontSize: 12,
          fontFamily: "var(--mono)",
          resize: "vertical",
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
        <button
          onClick={handleMatch}
          className="wh40k-btn"
          style={{ display: "flex", alignItems: "center", gap: 6, border: "none", background: "var(--accent)", color: "var(--accent-on)", borderRadius: 6, padding: "7px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
        >
          <FolderPlus size={14} /> Spárovat s knihovnou
        </button>
        {summary && !summary.error && (
          <span style={{ fontSize: 12, color: "var(--muted)" }}>
            Armáda "{summary.name}": spárováno {summary.matchedCount} z {summary.totalCount} jednotek.
            {summary.unmatched.length > 0 && (
              <>
                {" "}
                Nenalezeno: {summary.unmatched.map((u) => `${u.name} (${u.points} pts)`).join(", ")}.
              </>
            )}
          </span>
        )}
        {summary && summary.error && <span style={{ fontSize: 12, color: "#e0857c" }}>{summary.message}</span>}
      </div>
    </div>
  );
}

function ExportImportBox({ library, armies, onImport }) {
  const [mode, setMode] = useState("export"); // export | import
  const [importText, setImportText] = useState("");
  const [importSummary, setImportSummary] = useState(null);
  const [importFileName, setImportFileName] = useState("");
  const [copied, setCopied] = useState(false);

  // Pretty-printed so the "paste as text" fallback stays at least readable —
  // the file download below is the main path now.
  const exportPayload = JSON.stringify({ battlecalcExport: true, units: library, armies }, null, 2);
  const exportFileName = `battlecalc-export-${new Date().toISOString().slice(0, 10)}.json`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(exportPayload);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      setCopied(false);
    }
  };

  const handleDownload = () => {
    const blob = new Blob([exportPayload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exportFileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const importFromText = (text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    let data;
    try {
      data = JSON.parse(trimmed);
    } catch (e) {
      setImportSummary({ error: true, message: "Tohle nevypadá jako platný export z Battlecalc (neplatný JSON)." });
      return;
    }
    const units = Array.isArray(data.units) ? data.units : Array.isArray(data) ? data : null;
    if (!units) {
      setImportSummary({ error: true, message: "Tohle nevypadá jako platný export z Battlecalc." });
      return;
    }
    const armiesIn = Array.isArray(data.armies) ? data.armies : [];
    const { added, skipped } = onImport(units, armiesIn);
    setImportSummary({ error: false, added, skipped, armiesAdded: armiesIn.length });
    setImportText("");
    setImportFileName("");
  };

  const handleImport = () => importFromText(importText);

  const handleImportFile = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setImportFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => importFromText(String(ev.target.result || ""));
    reader.onerror = () => setImportSummary({ error: true, message: "Soubor se nepodařilo přečíst." });
    reader.readAsText(file);
  };

  return (
    <div style={{ background: "var(--field-bg)", border: "1px dashed var(--field-border)", borderRadius: 8, padding: 12, marginTop: 10 }}>
      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        <button
          onClick={() => setMode("export")}
          style={{
            flex: 1,
            border: "1px solid " + (mode === "export" ? "var(--accent)" : "var(--field-border)"),
            background: mode === "export" ? "var(--accent-dim)" : "transparent",
            color: mode === "export" ? "var(--accent-text)" : "var(--text)",
            borderRadius: 6,
            padding: "6px 0",
            fontSize: 12,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Export (pošli kamarádovi)
        </button>
        <button
          onClick={() => setMode("import")}
          style={{
            flex: 1,
            border: "1px solid " + (mode === "import" ? "var(--accent)" : "var(--field-border)"),
            background: mode === "import" ? "var(--accent-dim)" : "transparent",
            color: mode === "import" ? "var(--accent-text)" : "var(--text)",
            borderRadius: 6,
            padding: "6px 0",
            fontSize: 12,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Import (od kamaráda)
        </button>
      </div>

      {mode === "export" ? (
        <>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>
            Stáhni soubor a pošli ho kamarádovi (mail, Discord, cokoliv). On si ho pak v téhle appce nahraje přes záložku "Import".
          </div>
          <button
            onClick={handleDownload}
            className="wh40k-btn"
            style={{ display: "flex", alignItems: "center", gap: 6, border: "none", background: "var(--accent)", color: "#fff", borderRadius: 6, padding: "7px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
          >
            <Save size={14} /> Stáhnout jako soubor
          </button>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 6, marginBottom: 10 }}>
            Obsahuje {library.length} jednotek a {armies.length} uložených armád z tvé knihovny ({exportFileName}).
          </div>

          <details>
            <summary style={{ fontSize: 11.5, color: "var(--muted)", cursor: "pointer" }}>Nebo zkopírovat jako text</summary>
            <textarea
              readOnly
              value={exportPayload}
              rows={5}
              style={{ width: "100%", boxSizing: "border-box", marginTop: 8, background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 6, color: "var(--text)", padding: "8px 9px", fontSize: 11, fontFamily: "var(--mono)", resize: "vertical" }}
              onFocus={(e) => e.target.select()}
            />
            <button
              onClick={handleCopy}
              className="wh40k-btn"
              style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6, border: "1px solid var(--field-border)", background: "transparent", color: "var(--text)", borderRadius: 6, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
            >
              {copied ? "Zkopírováno ✓" : "Kopírovat"}
            </button>
          </details>
        </>
      ) : (
        <>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>Nahraj soubor, který ti poslal kamarád, nebo vlož jeho obsah jako text.</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                border: "1px solid var(--field-border)",
                borderRadius: 6,
                padding: "6px 12px",
                fontSize: 12.5,
                cursor: "pointer",
                color: "var(--text)",
              }}
            >
              <Upload size={13} /> Nahrát soubor (.json)
              <input type="file" accept=".json,application/json" onChange={handleImportFile} style={{ display: "none" }} />
            </label>
            {importFileName && <span style={{ fontSize: 12, color: "var(--muted)" }}>{importFileName}</span>}
          </div>
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            rows={5}
            placeholder="…nebo sem vlož exportovaný text…"
            style={{ width: "100%", boxSizing: "border-box", background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 6, color: "var(--text)", padding: "8px 9px", fontSize: 11, fontFamily: "var(--mono)", resize: "vertical" }}
          />
          <button
            onClick={handleImport}
            className="wh40k-btn"
            style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6, border: "none", background: "var(--accent)", color: "#fff", borderRadius: 6, padding: "7px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
          >
            Importovat
          </button>
          {importSummary && !importSummary.error && (
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 6 }}>
              Přidáno {importSummary.added} jednotek{importSummary.skipped > 0 ? ` (${importSummary.skipped}× už jsi měl, přeskočeno)` : ""}
              {importSummary.armiesAdded > 0 ? `, ${importSummary.armiesAdded} armád` : ""}.
            </div>
          )}
          {importSummary && importSummary.error && <div style={{ fontSize: 12, color: "#e0857c", marginTop: 6 }}>{importSummary.message}</div>}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unit picker (Faction -> Unit dropdowns)
// ---------------------------------------------------------------------------
function ArmyForm({ initial, groupedLibrary, onSave, onCancel }) {
  const [name, setName] = useState(initial.name);
  const [unitIds, setUnitIds] = useState(new Set(initial.unitIds));

  const toggle = (id) =>
    setUnitIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <div style={{ background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 10, padding: 16, marginTop: 10 }}>
      <TextField label="Název armády" value={name} onChange={setName} placeholder="např. Space Wolves 2000pts turnaj" />
      <SectionLabel>Jednotky v armádě</SectionLabel>
      {Object.entries(groupedLibrary).map(([faction, units]) => (
        <div key={faction} style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--amber)", textTransform: "uppercase", marginBottom: 3 }}>{faction}</div>
          {units.map((u) => (
            <label key={u.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, padding: "2px 0", cursor: "pointer" }}>
              <input type="checkbox" checked={unitIds.has(u.id)} onChange={() => toggle(u.id)} />
              {u.name}
            </label>
          ))}
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
        <button
          onClick={onCancel}
          style={{ border: "1px solid var(--field-border)", background: "transparent", color: "var(--text)", borderRadius: 6, padding: "7px 14px", fontSize: 13, cursor: "pointer" }}
        >
          Zrušit
        </button>
        <button
          onClick={() => {
            if (!name.trim() || unitIds.size === 0) return;
            onSave({ id: initial.id, name: name.trim(), unitIds: Array.from(unitIds) });
          }}
          style={{ border: "none", background: "var(--accent)", color: "var(--accent-on)", borderRadius: 6, padding: "7px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}
          className="wh40k-btn"
        >
          <Save size={14} /> Uložit armádu
        </button>
      </div>
    </div>
  );
}

// Distinguishing summary of a unit's weapon loadout, with how many models carry
// each weapon — e.g. "9x Storm Bolter, 9x Power Weapon, 1x Relic Great Axe" — so
// two similarly-named units with different wargear don't look identical in a list.
function weaponSummary(unit) {
  const parts = [];
  (unit.members || []).forEach((m) => {
    (m.weapons || []).forEach((w) => {
      if (!w.name) return;
      parts.push(`${m.count}x ${w.name}`);
    });
  });
  return parts.join(", ");
}

function LibraryRow({ u, onEdit, onDelete, onToggleFavorite }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 8px", borderRadius: 6, fontSize: 13 }}>
      <span style={{ display: "flex", flexDirection: "column" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {u.name}
          <span style={{ fontSize: 11, color: "var(--muted)" }}>
            ({totalModels(u)}x, {u.members.length} typ{u.members.length === 1 ? "" : "y"})
          </span>
          {u.isLeader && (
            <span style={{ fontSize: 10, fontWeight: 700, color: "#a9c6e5", border: "1px solid #a9c6e5", borderRadius: 4, padding: "1px 5px", textTransform: "uppercase", letterSpacing: 0.3 }}>
              vůdce
            </span>
          )}
          {u.needsStats && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, fontWeight: 700, color: "var(--amber)", border: "1px solid var(--amber)", borderRadius: 4, padding: "1px 5px", textTransform: "uppercase", letterSpacing: 0.3 }}>
              <AlertTriangle size={10} /> chybí staty
            </span>
          )}
        </span>
        {weaponSummary(u) && <span style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 1 }}>{weaponSummary(u)}</span>}
      </span>
      <span style={{ display: "flex", gap: 4 }}>
        <button onClick={onToggleFavorite} aria-label="Oblíbené" style={{ background: "transparent", border: "none", color: u.isFavorite ? "#e0c34a" : "var(--muted)", cursor: "pointer", padding: 4 }}>
          <Star size={14} fill={u.isFavorite ? "#e0c34a" : "none"} />
        </button>
        <button onClick={onEdit} aria-label="Upravit" style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer", padding: 4 }}>
          <Pencil size={14} />
        </button>
        <button onClick={onDelete} aria-label="Smazat" style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer", padding: 4 }}>
          <Trash2 size={14} />
        </button>
      </span>
    </div>
  );
}

function UnitPicker({ library, selectedId, onSelect }) {
  const factions = useMemo(() => Array.from(new Set(library.map((u) => u.faction || "Bez frakce"))).sort(), [library]);
  const [faction, setFaction] = useState("");

  useEffect(() => {
    if (selectedId) {
      const u = library.find((x) => x.id === selectedId);
      if (u) setFaction(u.faction || "Bez frakce");
    }
  }, [selectedId, library]);

  const unitsInFaction = library.filter((u) => (u.faction || "Bez frakce") === faction);

  if (library.length === 0) {
    return (
      <div style={{ fontSize: 12.5, color: "var(--muted)", background: "var(--field-bg)", border: "1px dashed var(--field-border)", borderRadius: 6, padding: "10px 12px" }}>
        Knihovna je zatím prázdná. Přidej jednotky níže a pak si je vyber tady.
      </div>
    );
  }

  return (
    <div className="wh40k-row wh40k-row-2" style={{ marginBottom: 0 }}>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 12.5, color: "var(--label)", fontWeight: 600 }}>Frakce</span>
        <select
          value={faction}
          onChange={(e) => {
            setFaction(e.target.value);
            onSelect(null);
          }}
          style={{ background: "var(--field-bg)", border: "1px solid var(--field-border)", borderRadius: 6, color: "var(--text)", padding: "7px 9px", fontSize: 13.5 }}
        >
          <option value="">— vyber frakci —</option>
          {factions.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 12.5, color: "var(--label)", fontWeight: 600 }}>Jednotka</span>
        <select
          value={selectedId || ""}
          onChange={(e) => onSelect(e.target.value || null)}
          disabled={!faction}
          style={{ background: "var(--field-bg)", border: "1px solid var(--field-border)", borderRadius: 6, color: "var(--text)", padding: "7px 9px", fontSize: 13.5, opacity: faction ? 1 : 0.5 }}
        >
          <option value="">— vyber jednotku —</option>
          {unitsInFaction.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name} ({totalModels(u)}x)
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function StatChip({ label, value }) {
  return (
    <div
      style={{
        background: "var(--field-bg)",
        border: "1px solid var(--field-border)",
        borderRadius: 6,
        padding: "3px 7px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        minWidth: 30,
      }}
    >
      <span style={{ fontSize: 8.5, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.3, lineHeight: 1.3 }}>{label}</span>
      <span style={{ fontSize: 12, fontWeight: 700, fontFamily: "var(--mono)", color: "var(--text)", lineHeight: 1.3 }}>{value}</span>
    </div>
  );
}

// A draggable token on the battlefield board — sized in both dimensions as a
// % of the board container so it renders as a true circle regardless of the
// container's actual rendered pixel size (see the "Deska" view for the math:
// width-%/height-% both derive from the same base-size-in-inches, just
// divided by the board's width-in-inches vs height-in-inches respectively).
function BoardTokenView({ token, unit, containerRef, sizePctW, sizePctH, onMove, onCommit, onRemove }) {
  const draggingRef = useRef(false);

  const handlePointerDown = (e) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
  };
  const handlePointerMove = (e) => {
    if (!draggingRef.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const xPct = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
    const yPct = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
    onMove(token.id, xPct, yPct);
  };
  const handlePointerUp = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    onCommit();
  };

  const label = unit ? unit.name.slice(0, 3).toUpperCase() : "?";
  const count = unit ? totalModels(unit) : 1;
  const color = token.side === "mine" ? "var(--accent)" : "#c0392b";

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onRemove(token.id);
      }}
      title={unit ? `${unit.name} — táhni pro přesun, dvojklik pro odebrání` : "dvojklik pro odebrání"}
      style={{
        position: "absolute",
        left: `${token.xPct}%`,
        top: `${token.yPct}%`,
        width: `${sizePctW}%`,
        height: `${sizePctH}%`,
        transform: "translate(-50%, -50%)",
        minWidth: 14,
        minHeight: 14,
        borderRadius: "50%",
        background: color,
        border: "2px solid rgba(255,255,255,0.85)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        fontSize: 8,
        fontWeight: 800,
        color: "#fff",
        cursor: "grab",
        userSelect: "none",
        touchAction: "none",
        boxShadow: "0 2px 6px rgba(0,0,0,0.4)",
        zIndex: 2,
      }}
    >
      {label}
      {count > 1 && (
        <span
          style={{
            position: "absolute",
            bottom: -5,
            right: -5,
            background: "#0a121e",
            border: "1px solid rgba(255,255,255,0.6)",
            borderRadius: 8,
            fontSize: 8,
            lineHeight: 1.4,
            padding: "0 3px",
            fontWeight: 700,
          }}
        >
          {count}
        </span>
      )}
    </div>
  );
}

function UnitComposition({ unit, profileChoices, onChooseProfile, meltaActive, onToggleMelta, rapidFireActive, onToggleRapidFire }) {
  if (!unit) return null;

  // Flatten to {member, weapon} pairs and put multi-profile weapons (e.g. an axe
  // with separate Sweep/Strike profiles) first, so the choice that actually
  // needs making is immediately visible instead of buried in the list.
  const flat = [];
  unit.members.forEach((m) => {
    m.weapons.forEach((w) => flat.push({ member: m, weapon: w }));
  });
  flat.sort((a, b) => {
    const aMulti = a.weapon.profiles && a.weapon.profiles.length > 1 ? 0 : 1;
    const bMulti = b.weapon.profiles && b.weapon.profiles.length > 1 ? 0 : 1;
    return aMulti - bMulti;
  });

  return (
    <div style={{ marginTop: 10, fontSize: 12 }}>
      {flat.map(({ member: m, weapon: w }) => {
        const hasProfiles = w.profiles && w.profiles.length > 1;
        const meltaOn = !!(meltaActive && meltaActive[w.id]);
        const rapidFireOn = !!(rapidFireActive && rapidFireActive[w.id]);
        // w.damage/w.attacks here already include the melta/rapid-fire bump
        // when active (applied once, upstream in effectiveAttackerUnit) —
        // don't add it again.
        const displayDamage = w.damage;
        return (
          <div
            key={w.id}
            style={{
              background: "var(--field-bg)",
              border: `1px solid ${hasProfiles ? "var(--accent)" : "var(--field-border)"}`,
              borderRadius: 8,
              padding: "6px 8px",
              marginBottom: 6,
            }}
          >
            <div style={{ fontSize: 9.5, color: "var(--muted)", marginBottom: 2 }}>
              {m.count}× {m.name}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 5, color: "var(--text)", fontSize: 11.5, fontWeight: 600, marginBottom: 5, flexWrap: "wrap" }}>
              {w.type === "melee" ? <Sword size={11} color="var(--accent-text)" /> : <Crosshair size={11} color="#a9c6e5" />}
              {w.name}
              {w.lethalHits && (
                <span style={{ fontSize: 8.5, fontWeight: 700, color: "var(--accent-text)", border: "1px solid var(--accent)", borderRadius: 4, padding: "0 4px", textTransform: "uppercase" }}>
                  Lethal
                </span>
              )}
              {(w.critHitsOn || 6) < 6 && (
                <span style={{ fontSize: 8.5, fontWeight: 700, color: "var(--accent-text)", border: "1px solid var(--accent)", borderRadius: 4, padding: "0 4px", textTransform: "uppercase" }}>
                  Crit Hit {w.critHitsOn}+
                </span>
              )}
              {(w.critWoundOn || 6) < 6 && (
                <span style={{ fontSize: 8.5, fontWeight: 700, color: "var(--accent-text)", border: "1px solid var(--accent)", borderRadius: 4, padding: "0 4px", textTransform: "uppercase" }}>
                  Crit Wound {w.critWoundOn}+
                </span>
              )}
              {w.devastatingWounds && (
                <span style={{ fontSize: 8.5, fontWeight: 700, color: "var(--accent-text)", border: "1px solid var(--accent)", borderRadius: 4, padding: "0 4px", textTransform: "uppercase" }}>
                  Dev. Wounds
                </span>
              )}
              {w.sustained > 0 && (
                <span style={{ fontSize: 8.5, fontWeight: 700, color: "#a9c6e5", border: "1px solid var(--blue)", borderRadius: 4, padding: "0 4px", textTransform: "uppercase" }}>
                  Sust. {fmtNum(w.sustained)}
                </span>
              )}
              {w.twinLinked && (
                <span style={{ fontSize: 8.5, fontWeight: 700, color: "#a9c6e5", border: "1px solid var(--blue)", borderRadius: 4, padding: "0 4px", textTransform: "uppercase" }}>
                  Twin-linked
                </span>
              )}
              {w.melta > 0 && (
                <span style={{ fontSize: 8.5, fontWeight: 700, color: "var(--amber)", border: "1px solid var(--amber)", borderRadius: 4, padding: "0 4px", textTransform: "uppercase" }}>
                  Melta {w.melta}
                </span>
              )}
              {w.rapidFire > 0 && (
                <span style={{ fontSize: 8.5, fontWeight: 700, color: "var(--amber)", border: "1px solid var(--amber)", borderRadius: 4, padding: "0 4px", textTransform: "uppercase" }}>
                  Rapid Fire {w.rapidFire}
                </span>
              )}
            </div>
            {hasProfiles && (
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 6, alignItems: "center" }}>
                <span style={{ fontSize: 9.5, color: "var(--muted)" }}>Profil (jen jeden najednou):</span>
                {w.profiles.map((p, i) => {
                  const active = i === (w.activeProfileIndex ?? 0);
                  return (
                    <button
                      key={p.name + i}
                      onClick={() => onChooseProfile && onChooseProfile(w.id, i)}
                      style={{
                        fontSize: 10.5,
                        fontWeight: 700,
                        padding: "2px 8px",
                        borderRadius: 5,
                        border: `1px solid ${active ? "var(--accent)" : "var(--field-border)"}`,
                        background: active ? "var(--accent-dim)" : "transparent",
                        color: active ? "var(--accent-text)" : "var(--muted)",
                        cursor: onChooseProfile ? "pointer" : "default",
                      }}
                    >
                      {p.name}
                    </button>
                  );
                })}
              </div>
            )}
            {w.melta > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                <span style={{ fontSize: 9.5, color: "var(--muted)" }}>V polovičním dosahu (melta):</span>
                <button
                  onClick={() => onToggleMelta && onToggleMelta(w.id)}
                  style={{
                    fontSize: 10.5,
                    fontWeight: 700,
                    padding: "2px 8px",
                    borderRadius: 5,
                    border: `1px solid ${meltaOn ? "var(--amber)" : "var(--field-border)"}`,
                    background: meltaOn ? "rgba(232,167,47,0.15)" : "transparent",
                    color: meltaOn ? "var(--amber)" : "var(--muted)",
                    cursor: onToggleMelta ? "pointer" : "default",
                  }}
                >
                  {meltaOn ? `ANO (+${w.melta} Dmg)` : "NE"}
                </button>
              </div>
            )}
            {w.rapidFire > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                <span style={{ fontSize: 9.5, color: "var(--muted)" }}>V polovičním dosahu (rapid fire):</span>
                <button
                  onClick={() => onToggleRapidFire && onToggleRapidFire(w.id)}
                  style={{
                    fontSize: 10.5,
                    fontWeight: 700,
                    padding: "2px 8px",
                    borderRadius: 5,
                    border: `1px solid ${rapidFireOn ? "var(--amber)" : "var(--field-border)"}`,
                    background: rapidFireOn ? "rgba(232,167,47,0.15)" : "transparent",
                    color: rapidFireOn ? "var(--amber)" : "var(--muted)",
                    cursor: onToggleRapidFire ? "pointer" : "default",
                  }}
                >
                  {rapidFireOn ? `ANO (+${w.rapidFire} Atk)` : "NE"}
                </button>
              </div>
            )}
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
              <StatChip label="Atk" value={fmtNum(w.attacks)} />
              <StatChip label="Hit" value={w.hitX <= 1 ? "auto" : `${w.hitX}+`} />
              <StatChip label="Str" value={w.strength} />
              <StatChip label="AP" value={w.ap} />
              <StatChip label="Dmg" value={fmtNum(displayDamage)} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Shared cranium outline, reused by SkullIcon below and by the cheat sheet's
// skull-shaped pie chart (same silhouette, different fill treatment).
const SKULL_OUTLINE_D =
  "M12 2.5C7.3 2.5 3.5 6.3 3.5 11c0 3.1 1.65 5.8 4.1 7.3.22.13.35.36.35.62V20a1 1 0 0 0 1 1h.55v1.1c0 .5.4.9.9.9h3.2c.5 0 .9-.4.9-.9V21h.55a1 1 0 0 0 1-1v-1.08c0-.26.13-.49.35-.62 2.45-1.5 4.1-4.2 4.1-7.3 0-4.7-3.8-8.5-8.5-8.5z";

// Custom skull icon — lucide's built-in "Skull" reads as an abstract blob at
// small UI sizes, so we draw a proper cranium + eye sockets + nose + teeth.
function SkullIcon({ size = 16, color = "currentColor", filled = false, style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={style} xmlns="http://www.w3.org/2000/svg">
      <path
        d={SKULL_OUTLINE_D}
        fill={filled ? color : "none"}
        stroke={color}
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <ellipse cx="8.7" cy="11.2" rx="1.6" ry="2" fill={filled ? "var(--panel)" : color} />
      <ellipse cx="15.3" cy="11.2" rx="1.6" ry="2" fill={filled ? "var(--panel)" : color} />
      <path d="M12 12.3l-1.1 2.3h2.2L12 12.3z" fill={filled ? "var(--panel)" : color} />
      <path d="M9.3 17.3h5.4M10.3 17.3v1.3M12 17.3v1.6M13.7 17.3v1.3" stroke={filled ? "var(--panel)" : color} strokeWidth="1" strokeLinecap="round" fill="none" />
    </svg>
  );
}

// Pure-SVG pie slice (not a CSS background) so it reliably shows up when
// printed, regardless of the browser's "print background graphics" setting.
function MiniPie({ frac, size = 34, color = "#1b5faa", trackColor = "#ddd" }) {
  const clamped = Math.max(0, Math.min(1, frac));
  const r = size / 2;
  let slice = null;
  if (clamped >= 0.999) {
    slice = <circle cx={r} cy={r} r={r} fill={color} />;
  } else if (clamped > 0) {
    const angle = clamped * 2 * Math.PI;
    const x = r + r * Math.sin(angle);
    const y = r - r * Math.cos(angle);
    const largeArc = clamped > 0.5 ? 1 : 0;
    slice = <path d={`M ${r} ${r} L ${r} 0 A ${r} ${r} 0 ${largeArc} 1 ${x} ${y} Z`} fill={color} />;
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: "block" }}>
      <circle cx={r} cy={r} r={r} fill={trackColor} />
      {slice}
      <circle cx={r} cy={r} r={r} fill="none" stroke="#999" strokeWidth="0.75" />
    </svg>
  );
}

// Row of small skull glyphs (reusing SkullIcon's path) filling in proportionally
// — the cheat sheet's print-friendly stand-in for a pie chart, at a size that
// actually fits a narrow matrix column instead of a full 34px circle.
// Pie chart clipped to the skull silhouette instead of a circle — same "fill
// sweeps clockwise from the top" reading as MiniPie, just skull-shaped.
function MiniSkullPie({ frac, size = 34, color = "#1b5faa", trackColor = "#ddd" }) {
  const clamped = Math.max(0, Math.min(1, frac));
  const clipId = useId();
  const cx = 12;
  const cy = 12;
  const r = 17; // covers the whole 24x24 viewBox from center at any angle
  let slice = null;
  if (clamped >= 0.999) {
    slice = <rect x="0" y="0" width="24" height="24" fill={color} />;
  } else if (clamped > 0) {
    const angle = clamped * 2 * Math.PI;
    const x = cx + r * Math.sin(angle);
    const y = cy - r * Math.cos(angle);
    const largeArc = clamped > 0.5 ? 1 : 0;
    slice = <path d={`M ${cx} ${cy} L ${cx} ${cy - r} A ${r} ${r} 0 ${largeArc} 1 ${x} ${y} Z`} fill={color} />;
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: "block" }}>
      <defs>
        <clipPath id={clipId}>
          <path d={SKULL_OUTLINE_D} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <rect x="0" y="0" width="24" height="24" fill={trackColor} />
        {slice}
      </g>
      <path d={SKULL_OUTLINE_D} fill="none" stroke="#999" strokeWidth="0.6" />
    </svg>
  );
}

function PieChart({ frac, size = 64 }) {
  const clamped = Math.max(0, Math.min(1, frac));
  const angle = clamped * 360;
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: `conic-gradient(var(--accent) ${angle}deg, var(--field-border) ${angle}deg)`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        marginTop: 10,
        boxShadow: clamped > 0 ? "0 0 14px rgba(47,143,232,0.35)" : "none",
      }}
    >
      <div
        style={{
          width: size * 0.68,
          height: size * 0.68,
          borderRadius: "50%",
          background: "var(--panel)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 13,
          fontWeight: 700,
          color: "var(--accent-text)",
          fontFamily: "var(--mono)",
        }}
      >
        {(clamped * 100).toFixed(0)}%
      </div>
    </div>
  );
}

function SkullRow({ killed, total }) {
  const frac = total > 0 ? Math.max(0, Math.min(1, killed / total)) : 0;
  // A single-model target (a character, vehicle, C'tan…) isn't well described
  // by "X of 10 models destroyed" — show how much of that one model's health
  // pool is spent instead, as a simple pie chart.
  if (total <= 1) {
    return <PieChart frac={frac} />;
  }
  const totalIcons = 10;
  const filled = Math.round(frac * totalIcons);
  return (
    <div style={{ display: "flex", gap: 4, marginTop: 10 }}>
      {Array.from({ length: totalIcons }).map((_, i) => (
        <SkullIcon key={i} size={18} color={i < filled ? "var(--accent-text)" : "var(--field-border)"} filled={i < filled} />
      ))}
    </div>
  );
}

function fmtNum(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// ---------------------------------------------------------------------------
// Real binomial probabilities tied to the actual number of save rolls this
// attack generates (M) and the real chance of failing one of them (q) — e.g.
// "10 attacks, 4+ save → ~5 expected to get through" is exactly this model,
// not an approximation around the average.
// ---------------------------------------------------------------------------
function binomialCDF(k, n, p) {
  if (!Number.isFinite(p) || n <= 0) return k >= 0 ? 1 : 0;
  if (p <= 0) return 1; // failure is impossible → always "at or under k" failures
  if (p >= 1) return k >= n ? 1 : 0;
  if (k < 0) return 0;
  if (k >= n) return 1;
  let pmf = Math.pow(1 - p, n);
  let cdf = pmf;
  for (let i = 1; i <= k; i++) {
    pmf = pmf * ((n - i + 1) / i) * (p / (1 - p));
    cdf += pmf;
  }
  return Math.max(0, Math.min(1, cdf));
}

// Sums the killedModels contributed by just one weapon type (ranged or melee)
// out of a computeUnitVsUnit result's breakdown — used to show Shoot/Melee
// separately in the cheat sheet instead of only the combined figure.
function killedModelsByType(res, type) {
  if (!res || !res.breakdown) return 0;
  return res.breakdown.filter((b) => b.type === type).reduce((s, b) => s + b.killedModels, 0);
}

// Given a computeUnitVsUnit-style result (with .breakdown and .totalDamage) and
// the target unit being attacked, works out: M = how many wound rolls actually
// reach a save this round, q = the real chance a given one of those fails its
// save, then uses the binomial distribution over those M independent rolls to
// get the chance of killing at least one model / wiping the whole unit.
function computeSurvivalStats(res, defenderUnit, defenderModelsCount) {
  const zero = { chanceAtLeast1: 0, chanceDestroyUnit: 0 };
  if (!res || !defenderUnit || !res.breakdown) return zero;
  let wounds = 0;
  let through = 0;
  res.breakdown.forEach((b) => {
    wounds += b.detail.woundsTotal;
    through += b.detail.through;
  });
  const M = Math.round(wounds);
  if (M <= 0 || through <= 0 || res.totalDamage <= 0) return zero;
  const q = Math.max(0, Math.min(1, through / wounds));
  const avgDmgPerFail = res.totalDamage / through;
  if (avgDmgPerFail <= 0) return zero;

  const woundsPerModel = clampNum(defenderUnit.wounds, 1);
  const totalWoundsPool = defenderModelsCount * woundsPerModel;
  const maxTolerable = Math.floor(totalWoundsPool / avgDmgPerFail);
  const failsToKillOne = Math.max(1, Math.ceil(woundsPerModel / avgDmgPerFail));

  const survivalChance = binomialCDF(maxTolerable, M, q);
  const chanceAtLeast1 = 1 - binomialCDF(failsToKillOne - 1, M, q);

  return {
    chanceAtLeast1: Math.max(0, Math.min(1, chanceAtLeast1)),
    chanceDestroyUnit: Math.max(0, Math.min(1, 1 - survivalChance)),
  };
}

function SkullLogo({ size = 28 }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        border: "2px solid var(--accent)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        boxShadow: "0 0 14px rgba(47,143,232,0.55)",
        background: "radial-gradient(circle, rgba(47,143,232,0.18), transparent 70%)",
      }}
    >
      <SkullIcon size={size * 0.58} color="var(--accent-text)" />
    </div>
  );
}

function TileButton({ icon: Icon, label, value, onClick }) {
  return (
    <button onClick={onClick} className="wh40k-card wh40k-btn" style={{ textAlign: "left", background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 12, padding: "13px 14px", cursor: "pointer", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6 }}>{label}</span>
        <Icon size={16} color="var(--accent-text)" />
      </div>
      <span style={{ fontSize: 13, color: "var(--text)" }}>{value}</span>
    </button>
  );
}

function SearchBox({ value, onChange, placeholder }) {
  return (
    <div style={{ position: "relative", marginBottom: 10 }}>
      <Search size={14} color="var(--muted)" style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)" }} />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="wh40k-input"
        style={{ width: "100%", boxSizing: "border-box", background: "var(--field-bg)", border: "1px solid var(--field-border)", borderRadius: 8, color: "var(--text)", padding: "9px 10px 9px 32px", fontSize: 13.5 }}
      />
    </div>
  );
}

function UnitListRow({ u, selected, onClick, onNext, nextLabel }) {
  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      className="wh40k-btn"
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 10,
        background: selected ? "var(--accent-dim)" : "var(--field-bg)",
        border: `1px solid ${selected ? "var(--accent)" : "var(--field-border)"}`,
        borderRadius: 8,
        padding: "9px 10px",
        cursor: "pointer",
        marginBottom: 6,
        textAlign: "left",
      }}
    >
      <SkullLogo size={26} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{u.name}</div>
        <div style={{ fontSize: 11, color: "var(--muted)" }}>
          {u.faction || "Bez frakce"}
          {u.points ? ` · ${u.points} pts` : ""}
        </div>
        {weaponSummary(u) && (
          <div style={{ fontSize: 10.5, color: "var(--muted)", opacity: 0.85, lineHeight: 1.4, marginTop: 1 }}>{weaponSummary(u)}</div>
        )}
      </div>
      {selected && onNext ? (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onNext();
          }}
          className="wh40k-btn"
          style={{
            border: "none",
            background: "var(--accent)",
            color: "#fff",
            borderRadius: 6,
            padding: "7px 11px",
            fontSize: 11.5,
            fontWeight: 700,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 4,
            flexShrink: 0,
            whiteSpace: "nowrap",
          }}
        >
          {nextLabel || "Další"} <ChevronRight size={13} />
        </button>
      ) : (
        <ChevronRight size={15} color="var(--muted)" style={{ flexShrink: 0 }} />
      )}
    </div>
  );
}

function PickerRow({ icon: Icon, label, count, onClick }) {
  return (
    <button
      onClick={onClick}
      className="wh40k-btn"
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 10,
        background: "var(--field-bg)",
        border: "1px solid var(--field-border)",
        borderRadius: 8,
        padding: "10px 10px",
        cursor: "pointer",
        marginBottom: 6,
        textAlign: "left",
      }}
    >
      <div style={{ width: 26, height: 26, borderRadius: 7, background: "var(--accent-dim)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <Icon size={14} color="var(--accent-text)" />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{label}</div>
        <div style={{ fontSize: 11, color: "var(--muted)" }}>
          {count} jednot{count === 1 ? "ka" : count >= 2 && count <= 4 ? "ky" : "ek"}
        </div>
      </div>
      <ChevronRight size={15} color="var(--muted)" />
    </button>
  );
}

function BonusFieldsGroup({ bonus, setBonus, isRanged }) {
  return (
    <>
      <Row cols={2}>
        <ToggleField label="Lethal Hits" value={bonus.lethalHits} onChange={(v) => setBonus((s) => ({ ...s, lethalHits: v }))} small />
        <NumberField label="Sustained (extra)" value={bonus.sustained} onChange={(v) => setBonus((s) => ({ ...s, sustained: v }))} min={0} small />
      </Row>
      {isRanged && (
        <Row cols={2}>
          <ToggleField
            label="Fire Overwatch (stratagem)"
            value={bonus.fireOverwatch}
            onChange={(v) => setBonus((s) => ({ ...s, fireOverwatch: v }))}
            hint="zásah jen na neupravenou 6, ignoruje ostatní hit modifikátory; jen na dálku"
            small
          />
          <div />
        </Row>
      )}
      <Row cols={2}>
        <SelectField label="Přehoz hit rollu" value={bonus.rerollHit} onChange={(v) => setBonus((s) => ({ ...s, rerollHit: v }))} options={REROLL_OPTIONS} small />
        <SelectField label="Přehoz wound rollu" value={bonus.rerollWound} onChange={(v) => setBonus((s) => ({ ...s, rerollWound: v }))} options={REROLL_OPTIONS} small />
      </Row>
      <Row cols={3}>
        <SelectField
          label="Modifikátor hit rollu"
          value={String(bonus.hitMod || 0)}
          onChange={(v) => setBonus((s) => ({ ...s, hitMod: Number(v) }))}
          options={MOD_OPTIONS_3}
          small
        />
        <SelectField
          label="Modifikátor wound rollu"
          value={String(bonus.woundMod || 0)}
          onChange={(v) => setBonus((s) => ({ ...s, woundMod: Number(v) }))}
          options={MOD_OPTIONS_3}
          small
        />
        <SelectField
          label="AP bonus"
          value={String(bonus.apMod || 0)}
          onChange={(v) => setBonus((s) => ({ ...s, apMod: Number(v) }))}
          options={MOD_OPTIONS_3}
          small
        />
      </Row>
      <Row cols={2}>
        <NumberField
          label="Mortal wounds navíc"
          value={bonus.mortalWounds || 0}
          onChange={(v) => setBonus((s) => ({ ...s, mortalWounds: Math.max(0, v) }))}
          min={0}
          hint="jednorázově za celou jednotku, mimo save (např. z charge); FNP se počítá"
          small
        />
        <div />
      </Row>
    </>
  );
}

// Cheat sheet only: the offensive fields above (BonusFieldsGroup) plus the
// defensive ones a "Debuffy obránce" panel used to have on its own — merged
// so either slot panel can hold both, letting values follow an army through
// a "Prohodit útočníky a cíle" swap. `mod` is one type-slice (ranged/melee)
// of a slot's modifiers (see emptyFullModifier).
function FullModifierFields({ mod, setMod, isRanged }) {
  return (
    <>
      <BonusFieldsGroup bonus={mod} setBonus={setMod} isRanged={isRanged} />
      <Row cols={isRanged ? 4 : 3}>
        <NumberField label="FNP (0 = jen vlastní)" value={mod.fnp} onChange={(v) => setMod((s) => ({ ...s, fnp: Math.max(0, v) }))} min={0} small />
        <NumberField
          label="Redukce dmg (0 = jen vlastní)"
          value={mod.damageReduction}
          onChange={(v) => setMod((s) => ({ ...s, damageReduction: Math.max(0, v) }))}
          min={0}
          small
        />
        <ToggleField label="Debuff: -1 WR pokud S > T" value={mod.woundDebuff} onChange={(v) => setMod((s) => ({ ...s, woundDebuff: v }))} small />
        {isRanged && (
          <ToggleField
            label="Benefit of Cover (-1 BS)"
            value={mod.benefitOfCover}
            onChange={(v) => setMod((s) => ({ ...s, benefitOfCover: v }))}
            hint="jen na dálku"
            small
          />
        )}
      </Row>
      <Row cols={2}>
        <SelectField
          label="Přehoz save hodu"
          value={mod.saveReroll || "none"}
          onChange={(v) => setMod((s) => ({ ...s, saveReroll: v }))}
          options={REROLL_OPTIONS}
          small
        />
        <div />
      </Row>
    </>
  );
}

function CheatSlotPanel({ title, hint, accent, slot, setSlot }) {
  const setType = (type) => (updater) => setSlot((s) => ({ ...s, [type]: typeof updater === "function" ? updater(s[type]) : updater }));
  return (
    <div style={{ background: "var(--field-bg)", border: "1px solid var(--field-border)", borderRadius: 10, padding: 12, marginBottom: 14 }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
        {title} <span style={{ fontWeight: 400, textTransform: "none" }}>({hint})</span>
      </div>
      <Row cols={2}>
        <NumberField
          label="Toughness (Nurglovy dary)"
          value={slot.toughnessMod}
          onChange={(v) => setSlot((s) => ({ ...s, toughnessMod: v }))}
          hint="zadej -1 pro zhoršení; pro obě strany"
          small
        />
        <NumberField
          label="Save (Nurglovy dary)"
          value={slot.saveMod}
          onChange={(v) => setSlot((s) => ({ ...s, saveMod: v }))}
          hint="zadej -1 pro zhoršení; pro obě strany"
          small
        />
      </Row>
      <div style={{ background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 8, padding: 8, marginBottom: 8 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#a9c6e5", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6, display: "flex", alignItems: "center", gap: 4 }}>
          <Crosshair size={11} /> Na dálku
        </div>
        <FullModifierFields mod={slot.ranged} setMod={setType("ranged")} isRanged />
      </div>
      <div style={{ background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 8, padding: 8 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: accent, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6, display: "flex", alignItems: "center", gap: 4 }}>
          <Sword size={11} /> Na blízko
        </div>
        <FullModifierFields mod={slot.melee} setMod={setType("melee")} isRanged={false} />
      </div>
    </div>
  );
}

function StepDots({ steps, current }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4, flexWrap: "wrap" }}>
      {steps.map((label, i) => {
        const n = i + 1;
        const active = n === current;
        const done = n < current;
        return (
          <React.Fragment key={label}>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: "50%",
                  fontSize: 9.5,
                  fontWeight: 700,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: active || done ? "var(--accent)" : "var(--field-border)",
                  color: active || done ? "#fff" : "var(--muted)",
                  flexShrink: 0,
                }}
              >
                {n}
              </span>
              <span style={{ fontSize: 9.5, fontWeight: 700, color: active ? "var(--accent-text)" : "var(--muted)", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</span>
            </div>
            {i < steps.length - 1 && <span style={{ width: 10, height: 1, background: "var(--field-border)" }} />}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Manual / help view — built into the app itself (not an external link) so
// anyone visiting the site can open it, logged in or not.
// ---------------------------------------------------------------------------
function ManualPath({ children }) {
  return (
    <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, background: "var(--field-bg)", border: "1px solid var(--field-border)", borderRadius: 4, padding: "1px 6px", whiteSpace: "nowrap" }}>
      {children}
    </span>
  );
}

function ManualSection({ num, title, children }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, borderBottom: "1px solid var(--field-border)", paddingBottom: 8, marginBottom: 12 }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent-text)", border: "1px solid var(--accent)", borderRadius: 4, padding: "1px 6px", flexShrink: 0 }}>{num}</span>
        <div style={{ fontSize: 15.5, fontWeight: 700 }}>{title}</div>
      </div>
      <div style={{ fontSize: 12.5, color: "var(--text)", lineHeight: 1.65 }}>{children}</div>
    </div>
  );
}

function ManualP({ children, muted }) {
  return <div style={{ marginBottom: 10, color: muted ? "var(--muted)" : "var(--text)" }}>{children}</div>;
}

function ManualH({ children }) {
  return <div style={{ fontSize: 12.5, fontWeight: 700, margin: "16px 0 6px" }}>{children}</div>;
}

function ManualSteps({ items }) {
  return (
    <ol style={{ margin: "0 0 12px", padding: 0, listStyle: "none", counterReset: "ms" }}>
      {items.map((it, i) => (
        <li key={i} style={{ counterIncrement: "ms", position: "relative", padding: "3px 0 3px 30px", marginBottom: 2 }}>
          <span
            style={{
              position: "absolute",
              left: 0,
              top: 2,
              width: 19,
              height: 19,
              borderRadius: 5,
              background: "var(--accent-dim)",
              color: "var(--accent-text)",
              fontFamily: "var(--mono)",
              fontWeight: 700,
              fontSize: 10.5,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {i + 1}
          </span>
          {it}
        </li>
      ))}
    </ol>
  );
}

function ManualUl({ items }) {
  return (
    <ul style={{ margin: "0 0 12px", padding: 0, listStyle: "none" }}>
      {items.map((it, i) => (
        <li key={i} style={{ position: "relative", padding: "0 0 8px 14px" }}>
          <span style={{ position: "absolute", left: 0, top: 7, width: 5, height: 5, background: "var(--muted)", opacity: 0.6, borderRadius: 1 }} />
          {it}
        </li>
      ))}
    </ul>
  );
}

function ManualNote({ tone = "accent", label, children }) {
  const color = tone === "warn" ? "#e0857c" : "var(--accent-text)";
  const bg = tone === "warn" ? "rgba(224,133,124,0.1)" : "var(--accent-dim)";
  const border = tone === "warn" ? "rgba(224,133,124,0.4)" : "var(--accent)";
  return (
    <div style={{ background: bg, border: `1px solid ${border}`, borderRadius: 8, padding: "10px 12px", margin: "10px 0" }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color, marginBottom: 4 }}>{label}</div>
      <div style={{ color: "var(--text)" }}>{children}</div>
    </div>
  );
}

function ManualView({ onBack }) {
  return (
    <div className="no-print" style={{ padding: "4px 14px 16px" }}>
      <button
        onClick={onBack}
        style={{ display: "flex", alignItems: "center", gap: 5, background: "transparent", border: "none", color: "var(--muted)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, cursor: "pointer", padding: 0, marginBottom: 14 }}
      >
        <ArrowLeft size={13} /> Zpět
      </button>
      <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 4 }}>Návod k použití</div>
      <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 22 }}>
        Battlecalc počítá očekávané poškození a šance na zabití mezi dvěma jednotkami Warhammeru 40 000 — na základě skutečných statů zbraní, ne jen odhadem.
      </div>

      <ManualSection num="01" title="Přihlášení">
        <ManualP muted>Appka je vázaná na účet — knihovna, armády i historie se ukládají zvlášť pro každého uživatele. Na výběr jsou tři způsoby:</ManualP>
        <ManualH>Odkaz emailem (nejjednodušší)</ManualH>
        <ManualSteps
          items={[
            <>Zadej svůj email a klikni <b>Poslat přihlašovací odkaz</b>.</>,
            <>Otevři si schránku (i spam) a klikni na odkaz v emailu.</>,
            <>Appka tě rovnou přihlásí — heslo nikde nezadáváš.</>,
          ]}
        />
        <ManualH>Email + heslo</ManualH>
        <ManualP>
          Přepni na záložku <ManualPath>Email + heslo</ManualPath>. Poprvé zvol <b>Vytvořit účet</b>, potvrď registraci odkazem v emailu, pak se už přihlašuj heslem.
        </ManualP>
        <ManualH>Google</ManualH>
        <ManualP>
          Tlačítko <b>Pokračovat s Google</b> tě přihlásí přes existující Google účet.
        </ManualP>
        <ManualNote label="Odhlášení">
          Ozubené kolečko vpravo nahoře → dole v menu <b>Odhlásit se</b>.
        </ManualNote>
      </ManualSection>

      <ManualSection num="02" title="Knihovna jednotek">
        <ManualP muted>Knihovna je tvůj sklad jednotek — každou počítanou bitvu appka vybírá útočníka i obránce právě odsud. Naplnit ji jde třemi způsoby.</ManualP>
        <ManualH>Import z New Recruit (JSON export)</ManualH>
        <ManualP>
          <ManualPath>Knihovna → Nahrát novou armádu z New Recruit</ManualPath>
        </ManualP>
        <ManualSteps
          items={[
            <>V New Recruit exportuj svůj list jako <b>JSON</b> (ne obyčejný text).</>,
            <>Nahraj soubor, nebo obsah vlož do textového pole.</>,
            <>Klikni <b>Naimportovat</b>.</>,
          ]}
        />
        <ManualP>
          Tohle je jediný způsob, který appce dá <b>skutečné bojové staty</b> pro každou zbraň — proto se doporučuje jako první krok pro každou novou frakci. Appka sama pozná Lethal Hits, Sustained Hits, Twin-linked, Melta X, Feel No Pain a některé útočné schopnosti (víc v kapitole 05) a rovnou z importu uloží i pojmenovanou armádu.
        </ManualP>
        <ManualNote tone="warn" label="Vůdci jednotek">
          Pokud je v listu postava připojená k jednotce jako vůdce (Leader), appka je při importu spojí do jedné položky knihovny — jejich zbraně se pak počítají dohromady, jméno bude např. „Wolf Guard Terminators (vede Logan Grimnar)“ a body se sečtou.
        </ManualNote>
        <ManualH>Ruční přidání / úprava</ManualH>
        <ManualP>
          <ManualPath>Knihovna → Přidat ručně</ManualPath> — vyplníš obranné staty a přidáš modely se zbraněmi. Stejný formulář se otevře i tužkou u existující jednotky.
        </ManualP>
        <ManualP>Ikonka hvězdy u jednotky ji přidá do Oblíbených.</ManualP>
        <ManualH>Sdílení s kamarádem</ManualH>
        <ManualP>
          <ManualPath>Knihovna → Sdílet s kamarádem → Export</ManualPath> — tlačítko <b>Stáhnout jako soubor</b> uloží celou knihovnu a armády jako <code style={{ fontFamily: "var(--mono)" }}>.json</code> soubor. Kamarád ho na stejném místě přes záložku <b>Import</b> nahraje tlačítkem <b>Nahrát soubor</b>. Duplicity se automaticky přeskočí.
        </ManualP>
        <ManualNote label="Copyright">
          Battlecalc nešíří žádnou oficiální databázi jednotek GW — knihovna obsahuje jen to, co si sám naimportuješ nebo co ti pošle kamarád ze svého vlastního exportu.
        </ManualNote>
      </ManualSection>

      <ManualSection num="03" title="Kalkulačka">
        <ManualP muted>Hlavní obrazovka appky, tři kroky:</ManualP>
        <ManualP>Útočník a obránce jsou naproti sobě ve dvou kartách (na mobilu pod sebou) — vyber jednotku v obou, uprav co potřebuješ, dole klikni Spočítat.</ManualP>
        <ManualH>Karta útočníka</ManualH>
        <ManualUl
          items={[
            <><b>Připojit vůdce</b> — dočasně spojí jednotku s postavou z knihovny (jen pro tenhle výpočet).</>,
            <><b>Bonusy na dálku / na blízko zvlášť</b> — Lethal Hits, Sustained, přehoz zásahu/zranění, modifikátor hit rollu, wound rollu, AP bonus, mortal wounds navíc.</>,
            <><b>Fire Overwatch</b> — jen bonusy na dálku. Zásah jen na neupravenou 6, ignoruje ostatní hit modifikátory (přesně dle strategemu).</>,
            <><b>Profil zbraně</b> — pokud má zbraň víc profilů (např. Sweep/Strike), zvolíš který se použije.</>,
            <><b>Melta</b> — přepínač „v polovičním dosahu“ u zbraní s Meltou X.</>,
            <><b>Rapid Fire</b> — přepínač „v polovičním dosahu“ u zbraní s Rapid Fire X (přidá X útoků).</>,
          ]}
        />
        <ManualH>Karta obránce</ManualH>
        <ManualP>
          Vyber cílovou jednotku. Volitelně rozklikni <b>Modifikátory</b> pro úpravu počtu modelů, FNP, debuffu, Benefit of Cover nebo <b>přehozu save hodu</b> (Jedničky / Vše). Klikni <b>Spočítat</b>.
        </ManualP>
      </ManualSection>

      <ManualSection num="04" title="Čtení výsledku">
        <ManualH>Očekávané zabité modely</ManualH>
        <ManualP>
          Tohle číslo je <b>průměr přes mnoho her</b>, ne jistota — <code style={{ fontFamily: "var(--mono)" }}>1.84</code> znamená „za 100 stejných útoků v průměru zabiješ 184 modelů“. Vedle je proto i <b>„jistě padne N“</b> — spodní odhad zaokrouhlený dolů.
        </ManualP>
        <ManualH>Tři šance dole</ManualH>
        <ManualP muted>Počítané binomickým rozdělením (ne jen průměrem):</ManualP>
        <ManualUl items={["Šance zabít alespoň 1 model", "Šance zničit celou jednotku", "Šance, že jednotka přežije"]} />
        <ManualH>Rozpis podle zbraní</ManualH>
        <ManualP>
          Vedle procent vidíš i skutečné očekávané počty, např. <code style={{ fontFamily: "var(--mono)" }}>3+ → 66.7% (0.67)</code>. Řádek se navíc označí, pokud se u něj uplatnil debuff -1 na wound roll.
        </ManualP>
      </ManualSection>

      <ManualSection num="05" title="Co appka umí rozpoznat">
        <ManualP muted>Z JSON importu appka automaticky vyčte a nastaví: Lethal Hits, Sustained Hits X, Twin-linked, Melta X, Rapid Fire X, Feel No Pain, redukci damage (např. C'tan Shard).</ManualP>
        <ManualP>Tohle je potřeba doplnit/zkontrolovat ručně v editaci jednotky nebo zbraně (tužka v knihovně):</ManualP>
        <ManualUl
          items={[
            <><b>Anti-X Y+</b> — zbraň → „Anti- klíčové slovo“ + práh. Proti MONSTER/VEHICLE/CHARACTER/INFANTRY automaticky zraní na hod Y+.</>,
            <><b>Přehoz vše proti keywordu</b> — zbraň → „vs MONSTER/VEHICLE/CHARACTER“. Přehoz zásahu i zranění jen proti danému keywordu (např. GMNDK).</>,
            <><b>Přehoz 1 hitu / 1 woundu</b> — zbraň → zaškrtávátko. Jednorázový přehoz, jiná matematika než „všechny“/„jedničky“.</>,
            <><b>Přehoz 1 damage rollu</b> — zbraň → vyplň „Kostky Damage“ (např. D6, 2D6, D3+3) a zaškrtni přehoz. Appka spočítá optimální strategii (přehodit jen nízké hody).</>,
            <><b>Critical Hit / Critical Wound na X+</b> — zbraň → obě pole, normálně 6. Snižuje práh, kdy se hit/wound počítá jako kritický (ovlivňuje Lethal Hits, Sustained Hits i Devastating Wounds).</>,
            <><b>Devastating Wounds</b> — zbraň → zaškrtávátko. Critical Wound = mortal wounds rovné Damage, mimo jakýkoli save (ani invulnerable).</>,
            <><b>Přehoz save hodu</b> — obránce → Modifikátory → „Přehoz save hodu“ (Jedničky / Vše), zvlášť na dálku/na blízko.</>,
            <><b>FNP proti Psychic</b> — jednotka → „FNP proti Psychic“. Funguje jen proti zbraním označeným jako „Psychický útok“ (např. Culexus).</>,
            <><b>Klíčová slova jednotky</b> — MONSTER / VEHICLE / CHARACTER / INFANTRY. Nutné pro Anti-X a keyword-rerolly výše.</>,
            <><b>Mortal wounds navíc</b> — karta útočníka, bonusový panel. Jednorázově za celou jednotku, mimo save.</>,
          ]}
        />
      </ManualSection>

      <ManualSection num="06" title="Armády">
        <ManualP>
          <ManualPath>Cheat sheet → Moje armády</ManualPath> — pojmenovaná skupina jednotek z knihovny, hlavně pro cheat sheet (kapitola 07). Dvě cesty, jak ji založit:
        </ManualP>
        <ManualH>Ručně</ManualH>
        <ManualP><b>Uložit novou armádu</b> → pojmenuj a zaškrtni jednotky z knihovny.</ManualP>
        <ManualH>Z textu (New Recruit)</ManualH>
        <ManualP>
          <b>Armáda z textu (New Recruit)</b> — vlož prostý textový export listu (bez statů, jen jména a body). Appka spáruje jednotky podle jména a bodů s knihovnou a armádu uloží nebo aktualizuje.
        </ManualP>
        <ManualNote label="Vůdce v textu zvlášť">
          Pokud text uvádí vůdce a jednotku zvlášť, appka zkusí i jejich <b>součet bodů</b> a najde sloučenou položku v knihovně. Samotný vůdce se pak ukáže jako „nenalezeno“ — to je v pořádku, jeho staty už jsou uvnitř sloučené jednotky.
        </ManualNote>
        <ManualH>Přidání do cheat sheetu</ManualH>
        <ManualP>
          U každé uložené armády jsou dvě tlačítka — <b>Útočník</b> a <b>Obránce</b> — zaškrtnou rovnou všechny její jednotky na příslušné straně.
        </ManualP>
      </ManualSection>

      <ManualSection num="07" title="Cheat sheet k tisku">
        <ManualP>
          <ManualPath>Cheat sheet → Cheat sheet pro tisk</ManualPath> spočítá matici všichni útočníci × všichni cíle najednou.
        </ManualP>
        <ManualSteps
          items={[
            <>Volitelně rozbal <b>Modifikátory</b> a nastav bonusy útočníka / debuffy obránce navíc k vestavěným schopnostem — tabulka ukáže obojí, „Základ“ i „S bonusy“.</>,
            <>Zaškrtni útočníky a cíle — nebo použij <b>Zaškrtnout celou armádu…</b> / tlačítka Útočník/Obránce u uložené armády.</>,
            <>Výsledková matice se počítá průběžně, hned nad zaškrtávacími seznamy. Klikni <b>Vytisknout cheat sheet</b>.</>,
          ]}
        />
        <ManualP>
          Každá buňka má čtyři lebky ve dvou řádcích — <b>S</b> (na dálku) a <b>M</b> (na blízko), v obou řádcích šedou (jen vestavěné schopnosti) a modrou (+ tvoje bonusy) — vyplněné podle procenta zničené jednotky.
        </ManualP>
        <ManualP muted>Tlačítko <b>Prohodit útočníky a cíle</b> prohodí obě zaškrtnutí najednou.</ManualP>
      </ManualSection>

      <ManualSection num="08" title="Deska">
        <ManualP>
          <ManualPath>Deska</ManualPath> — vizuální bojiště na míru. Zaškrtni jednotky z knihovny do <b>Moje jednotky</b> nebo <b>Jednotky protihráče</b> — objeví se jako token, přetáhni ho na místo. Velikost tokenu vychází z pole <b>Base (mm)</b> v editaci jednotky.
        </ManualP>
        <ManualUl
          items={[
            <>Dvojklik na token ho odebere z desky (odškrtne se i v seznamu).</>,
            <>Rozměry desky (šířka/výška v palcích) jdou upravit nahoře — token si přepočítá velikost podle nich.</>,
            <>Jeden token = celá jednotka (počet modelů je v odznáčku v rohu), ne model po modelu.</>,
          ]}
        />
        <ManualNote>
          Zatím bez automatického nahrávání mise/deployment mapy — přijde v další verzi.
        </ManualNote>
      </ManualSection>

      <ManualSection num="09" title="Historie">
        <ManualP>
          Každý spočítaný výsledek se uloží do <ManualPath>Historie</ManualPath>. <b>Kopírovat</b> zkopíruje čitelný textový přehled, <b>Upravit</b> tě vrátí do kalkulačky se stejným nastavením.
        </ManualP>
      </ManualSection>

      <ManualSection num="10" title="Menu a zobrazení">
        <ManualP muted>Ikona ☰ vlevo nahoře otevře rychlé menu:</ManualP>
        <ManualUl
          items={[
            "Nový výpočet, Knihovna jednotek, Moje armády a cheat sheet, Historie výpočtů — přímé skoky do sekcí.",
            <><b>Celá obrazovka</b> — appka zabere celou obrazovku prohlížeče.</>,
            <><b>Automaticky podle displeje / Vždy úzké (mobil)</b> — šířka appky se sama přizpůsobuje displeji; tímhle přepínačem to jde vypnout.</>,
            <><b>Návod k použití</b> — tahle stránka.</>,
          ]}
        />
      </ManualSection>

      <ManualSection num="11" title="Časté dotazy">
        <ManualH>Proč se mi po smazání jednotky nezobrazuje armáda?</ManualH>
        <ManualP muted>Smazání jednotky ji odstraní i ze všech armád, které ji obsahovaly — a armádu, která by zůstala prázdná, appka smaže celou.</ManualP>
        <ManualH>Uvidí moji knihovnu někdo jiný?</ManualH>
        <ManualP muted>Ne. Data jsou vázaná na tvůj přihlášený účet, dokud je sám nepošleš přes „Sdílet s kamarádem“.</ManualP>
        <ManualH>Proč +1 u modifikátoru znamená zlepšení?</ManualH>
        <ManualP muted>+1 u modifikátoru hit/wound rollu vždy znamená zlepšení pro útočníka (např. z 3+ na 2+), -1 zhoršení.</ManualP>
        <ManualH>Proč appka nepočítá přehoz jednoho damage rollu?</ManualH>
        <ManualP muted>Damage appka ukládá jako zprůměrované číslo (D6 → 3.5), takže si nepamatuje, že šlo o kostku.</ManualP>
      </ManualSection>

      <div style={{ marginTop: 20, paddingTop: 14, borderTop: "1px solid var(--field-border)", fontSize: 10.5, color: "var(--muted)" }}>
        Neoficiální fanouškovský nástroj, bez vazby na Games Workshop.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function Wh40kCalculator({ session }) {
  const [library, setLibrary] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [editingUnit, setEditingUnit] = useState(null);

  const [attackerUnitId, setAttackerUnitId] = useState(null);
  const [defenderUnitId, setDefenderUnitId] = useState(null);
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [methodologyOpen, setMethodologyOpen] = useState(false);
  const [cheatOpen, setCheatOpen] = useState(false);
  const [cheatAttackerIds, setCheatAttackerIds] = useState(new Set());
  const [cheatTargetIds, setCheatTargetIds] = useState(new Set());

  const toggleCheatAttacker = (id) =>
    setCheatAttackerIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const toggleCheatTarget = (id) =>
    setCheatTargetIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  // Swaps which checked units are attackers vs targets — e.g. after building
  // "my army vs their army", flip to "their army vs my army" without
  // re-ticking every checkbox by hand.
  const swapCheatAttackersAndTargets = () => {
    setCheatAttackerIds(cheatTargetIds);
    setCheatTargetIds(cheatAttackerIds);
    setCheatSlotA(cheatSlotB);
    setCheatSlotB(cheatSlotA);
  };

  // Two symmetric slots ("Bonusy útočníka" / "Debuffy obránce" panels) — each
  // holds a full offense+defense modifier set, since after "Prohodit
  // útočníky a cíle" the same army can sit in either role and its modifiers
  // should follow it, not stay pinned to whichever panel they were typed
  // into. Swapping swaps these two objects wholesale.
  const [cheatSlotA, setCheatSlotA] = useState(emptySlotModifiers());
  const [cheatSlotB, setCheatSlotB] = useState(emptySlotModifiers());
  const ZERO_BONUS = { ranged: emptyBonus(), melee: emptyBonus() };

  const addArmyToAttackers = (armyId) => {
    const army = armies.find((a) => a.id === armyId);
    if (!army) return;
    setCheatAttackerIds((prev) => new Set([...prev, ...army.unitIds]));
  };
  const addArmyToTargets = (armyId) => {
    const army = armies.find((a) => a.id === armyId);
    if (!army) return;
    setCheatTargetIds((prev) => new Set([...prev, ...army.unitIds]));
  };

  const [attackerBonus, setAttackerBonus] = useState(autoDetectBonus(null));
  const [attachedLeaderId, setAttachedLeaderId] = useState(null);
  const [weaponProfileChoice, setWeaponProfileChoice] = useState({}); // weaponId -> chosen profile index
  const [weaponMeltaActive, setWeaponMeltaActive] = useState({}); // weaponId -> is target within half range?
  const [weaponRapidFireActive, setWeaponRapidFireActive] = useState({}); // weaponId -> is target within half range?
  const [defenderModelCount, setDefenderModelCount] = useState(0);
  const [defenderFnp, setDefenderFnp] = useState({ ranged: 0, melee: 0 });
  const [defenderWoundDebuff, setDefenderWoundDebuff] = useState({ ranged: false, melee: false });
  const [defenderDamageReduction, setDefenderDamageReduction] = useState({ ranged: 0, melee: 0 });
  const [defenderToughnessMod, setDefenderToughnessMod] = useState(0);
  const [defenderSaveMod, setDefenderSaveMod] = useState(0);
  const [defenderBenefitOfCover, setDefenderBenefitOfCover] = useState(false);
  const [defenderSaveReroll, setDefenderSaveReroll] = useState({ ranged: "none", melee: "none" });

  const [armies, setArmies] = useState([]);
  const [armiesLoaded, setArmiesLoaded] = useState(false);
  const [board, setBoard] = useState({ widthIn: 44, heightIn: 60, tokens: [] });
  const [boardLoaded, setBoardLoaded] = useState(false);
  // Mirrors `board` synchronously so drag-end can read the latest tokens
  // without depending on a stale render closure (see commitBoardTokenMove).
  const boardRef = useRef(board);
  useEffect(() => {
    boardRef.current = board;
  }, [board]);
  const [armiesOpen, setArmiesOpen] = useState(false);
  const [editingArmy, setEditingArmy] = useState(null);
  const [textArmyOpen, setTextArmyOpen] = useState(false);

  // Navigation shell state
  const [view, setView] = useState("home"); // home | calculator | library | history | lists
  const [calcStep, setCalcStep] = useState("setup"); // "setup" (attacker + defender side by side), "result"
  const [attackerSearch, setAttackerSearch] = useState("");
  const [defenderSearch, setDefenderSearch] = useState("");
  const [attackerFilter, setAttackerFilter] = useState(null); // { type: 'faction'|'army', key, label } | null
  const [defenderFilter, setDefenderFilter] = useState(null);
  const [librarySearch, setLibrarySearch] = useState("");
  const [libraryTab, setLibraryTab] = useState("units"); // units | weapons
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [defenderModifiersOpen, setDefenderModifiersOpen] = useState(false);
  const [cheatModifiersOpen, setCheatModifiersOpen] = useState(false);
  // Width is responsive by default (see .wh40k-shell media queries below) —
  // forceCompact pins it back to the narrow phone-card width regardless of
  // screen size, for anyone who prefers that even on a big display.
  const [forceCompact, setForceCompact] = useState(() => {
    try {
      return localStorage.getItem("battlecalc:forceCompact") === "1";
    } catch (e) {
      return false;
    }
  });
  const toggleForceCompact = () => {
    setForceCompact((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("battlecalc:forceCompact", next ? "1" : "0");
      } catch (e) {
        // ignore — purely a per-browser display preference
      }
      return next;
    });
  };
  const [isFullscreen, setIsFullscreen] = useState(!!document.fullscreenElement);

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  };

  const [history, setHistory] = useState([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [expandedHistoryId, setExpandedHistoryId] = useState(null);
  const [copiedHistoryId, setCopiedHistoryId] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null); // { message, onConfirm } | null
  const askConfirm = (message, onConfirm) => setConfirmDialog({ message, onConfirm });
  const [alertMessage, setAlertMessage] = useState(null);

  const persistHistory = useCallback(async (next) => {
    setHistory(next);
    try {
      await storage.set("history_v1", JSON.stringify(next), false);
    } catch (e) {
      console.error("Nepodařilo se uložit historii", e);
    }
  }, []);

  const deleteHistoryEntry = (id) => persistHistory(history.filter((h) => h.id !== id));
  const clearHistory = () => persistHistory([]);

  useEffect(() => {
    (async () => {
      try {
        const res = await withTimeout(storage.get("library_v2", false));
        if (res && res.value) setLibrary(JSON.parse(res.value));
      } catch (e) {
        // nothing saved yet, or the request stalled — either way, don't
        // block the UI on it forever
      } finally {
        setLoaded(true);
      }
    })();
    (async () => {
      try {
        const res = await withTimeout(storage.get("armies_v1", false));
        if (res && res.value) setArmies(JSON.parse(res.value));
      } catch (e) {
        // nothing saved yet, or the request stalled
      } finally {
        setArmiesLoaded(true);
      }
    })();
    (async () => {
      try {
        const res = await withTimeout(storage.get("history_v1", false));
        if (res && res.value) setHistory(JSON.parse(res.value));
      } catch (e) {
        // nothing saved yet, or the request stalled
      } finally {
        setHistoryLoaded(true);
      }
    })();
    (async () => {
      try {
        const res = await withTimeout(storage.get("board_v1", false));
        if (res && res.value) setBoard(JSON.parse(res.value));
      } catch (e) {
        // nothing saved yet, or the request stalled
      } finally {
        setBoardLoaded(true);
      }
    })();
  }, []);

  const persistLibrary = useCallback(async (next) => {
    setLibrary(next);
    try {
      await storage.set("library_v2", JSON.stringify(next), false);
    } catch (e) {
      console.error("Nepodařilo se uložit knihovnu", e);
    }
  }, []);

  const persistArmies = useCallback(async (next) => {
    setArmies(next);
    try {
      await storage.set("armies_v1", JSON.stringify(next), false);
    } catch (e) {
      console.error("Nepodařilo se uložit armády", e);
    }
  }, []);

  const persistBoard = useCallback(async (next) => {
    setBoard(next);
    try {
      await storage.set("board_v1", JSON.stringify(next), false);
    } catch (e) {
      console.error("Nepodařilo se uložit desku", e);
    }
  }, []);

  // Toggling a unit on/off the board's roster places/removes a single token
  // for the whole unit (not one per model) — simplest way to get an army onto
  // the table; drag it into position afterward.
  const toggleUnitOnBoard = (unitId, side) => {
    const exists = board.tokens.some((t) => t.unitId === unitId && t.side === side);
    if (exists) {
      persistBoard({ ...board, tokens: board.tokens.filter((t) => !(t.unitId === unitId && t.side === side)) });
      return;
    }
    // Stage new tokens along that side's baseline, spaced out a bit so they
    // don't all land in an identical pile — nudged by how many are already
    // staged on that side.
    const sideCount = board.tokens.filter((t) => t.side === side).length;
    const xPct = 8 + (sideCount % 8) * 11;
    const yPct = side === "mine" ? 90 : 10;
    persistBoard({
      ...board,
      tokens: [...board.tokens, { id: crypto.randomUUID(), unitId, side, xPct, yPct }],
    });
  };

  const removeBoardToken = (tokenId) => persistBoard({ ...board, tokens: board.tokens.filter((t) => t.id !== tokenId) });

  const moveBoardToken = (tokenId, xPct, yPct) => {
    setBoard((s) => ({ ...s, tokens: s.tokens.map((t) => (t.id === tokenId ? { ...t, xPct, yPct } : t)) }));
  };
  // Only write to storage once the drag actually ends — dragging fires
  // moveBoardToken on every pointer move (fast setState, no network), and
  // persisting every intermediate frame would spam the backend. Reads
  // boardRef instead of the `board` closure variable, since setState from
  // moveBoardToken above won't be reflected in this render's `board` yet.
  const commitBoardTokenMove = () => {
    storage.set("board_v1", JSON.stringify(boardRef.current), false).catch((e) => console.error("Nepodařilo se uložit desku", e));
  };

  const clearBoardTokens = () => persistBoard({ ...board, tokens: [] });
  const setBoardSize = (widthIn, heightIn) => persistBoard({ ...board, widthIn, heightIn });

  const saveArmy = (army) => {
    const exists = armies.some((a) => a.id === army.id);
    const next = exists ? armies.map((a) => (a.id === army.id ? army : a)) : [...armies, army];
    persistArmies(next);
    setEditingArmy(null);
  };

  const deleteArmy = (id) => persistArmies(armies.filter((a) => a.id !== id));

  // Matches a pasted New Recruit text-list against units already in the
  // library (by name/points) and saves/updates a named army from the
  // matches — no full JSON re-upload needed once the units themselves are
  // already in the library. Re-running with the same list name replaces
  // that army's unit selection rather than piling up duplicates.
  const importArmyFromText = (text) => {
    const { listName, entries } = parseArmyTextForMatching(text);
    if (entries.length === 0) {
      return { error: true, message: "Nepodařilo se v textu najít žádné jednotky (řádky ve tvaru \"Název (N points)\")." };
    }
    const { matchedIds, unmatched } = matchArmyEntriesToLibrary(entries, library);
    if (matchedIds.length === 0) {
      return { error: true, message: "Ani jedna jednotka z textu se nenašla v knihovně — nejdřív si armádu naimportuj z JSON, ať máš jednotky se staty." };
    }
    const name = listName || `Import ${new Date().toLocaleDateString("cs-CZ")}`;
    const existing = armies.find((a) => a.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      persistArmies(armies.map((a) => (a.id === existing.id ? { ...a, unitIds: matchedIds } : a)));
    } else {
      persistArmies([...armies, { id: crypto.randomUUID(), name, unitIds: matchedIds }]);
    }
    return { error: false, name, matchedCount: matchedIds.length, totalCount: entries.length, unmatched };
  };

  const saveUnit = (unit) => {
    const exists = library.some((u) => u.id === unit.id);
    const next = exists ? library.map((u) => (u.id === unit.id ? unit : u)) : [...library, unit];
    persistLibrary(next);
    setEditingUnit(null);
  };

  const toggleFavorite = (id) => {
    persistLibrary(library.map((u) => (u.id === id ? { ...u, isFavorite: !u.isFavorite } : u)));
  };

  const favoriteUnits = useMemo(() => library.filter((u) => u.isFavorite), [library]);

  const deleteUnit = (id) => {
    persistLibrary(library.filter((u) => u.id !== id));
    if (attackerUnitId === id) setAttackerUnitId(null);
    if (defenderUnitId === id) setDefenderUnitId(null);
    // Drop the unit from any saved armies too, and drop armies that end up
    // empty as a result — otherwise a deleted unit leaves a dangling
    // reference and the army looks selectable but produces nothing.
    const nextArmies = armies.map((a) => ({ ...a, unitIds: a.unitIds.filter((uid) => uid !== id) })).filter((a) => a.unitIds.length > 0);
    persistArmies(nextArmies);
  };

  const clearLibrary = () => {
    persistLibrary([]);
    persistArmies([]);
    setAttackerUnitId(null);
    setDefenderUnitId(null);
    setCheatAttackerIds(new Set());
    setCheatTargetIds(new Set());
  };

  const importUnits = (units) => {
    const existingSigs = new Set(library.map(unitSignature));
    const toAdd = [];
    let skipped = 0;
    units.forEach((u) => {
      const sig = unitSignature(u);
      if (existingSigs.has(sig)) {
        skipped += 1;
      } else {
        existingSigs.add(sig);
        toAdd.push(u);
      }
    });
    if (toAdd.length > 0) persistLibrary([...library, ...toAdd]);
    setLibraryOpen(true);
    return { added: toAdd.length, skipped };
  };

  const importUnitsAndArmies = (units, armiesIn) => {
    const result = importUnits(units);
    const existingArmyNames = new Set(armies.map((a) => a.name));
    const newArmies = (armiesIn || []).filter((a) => a && a.name && !existingArmyNames.has(a.name)).map((a) => ({ ...a, id: crypto.randomUUID() }));
    if (newArmies.length > 0) persistArmies([...armies, ...newArmies]);
    return result;
  };

  // New Recruit JSON import: adds the units to the library (deduped as usual),
  // then automatically saves the whole roster as a named army — using every
  // unit's id whether it was newly added or already existed in the library, so
  // the army correctly reflects the whole roster either way.
  const importFromNewRecruit = (units, rosterName) => {
    const existingSigToId = new Map(library.map((u) => [unitSignature(u), u.id]));
    const toAdd = [];
    const allIds = [];
    let skipped = 0;
    units.forEach((u) => {
      const sig = unitSignature(u);
      if (existingSigToId.has(sig)) {
        skipped += 1;
        allIds.push(existingSigToId.get(sig));
      } else {
        existingSigToId.set(sig, u.id);
        toAdd.push(u);
        allIds.push(u.id);
      }
    });
    if (toAdd.length > 0) persistLibrary([...library, ...toAdd]);
    setLibraryOpen(true);

    if (rosterName && rosterName.trim() && allIds.length > 0) {
      const name = rosterName.trim();
      const existingArmy = armies.find((a) => a.name === name);
      if (existingArmy) {
        const mergedIds = Array.from(new Set([...existingArmy.unitIds, ...allIds]));
        persistArmies(armies.map((a) => (a.id === existingArmy.id ? { ...a, unitIds: mergedIds } : a)));
      } else {
        persistArmies([...armies, { id: crypto.randomUUID(), name, unitIds: allIds }]);
      }
    }

    return { added: toAdd.length, skipped };
  };

  const attackerUnit = useMemo(() => library.find((u) => u.id === attackerUnitId) || null, [library, attackerUnitId]);
  const defenderUnit = useMemo(() => library.find((u) => u.id === defenderUnitId) || null, [library, defenderUnitId]);
  const attachedLeader = useMemo(() => library.find((u) => u.id === attachedLeaderId) || null, [library, attachedLeaderId]);

  // Combines the picked attacker unit with an optionally attached leader (e.g. a
  // Captain) for this calculation only — the library entries themselves stay
  // untouched, so the same character can be attached to different squads across
  // different calculations. Also applies any manual weapon-profile choice (e.g.
  // Axe Morkai's Sweep vs Strike) and any "within half range" Melta toggle on top.
  const effectiveAttackerUnit = useMemo(() => {
    if (!attackerUnit) return null;
    let merged = attackerUnit;
    if (attachedLeader) {
      merged = {
        ...attackerUnit,
        name: `${attackerUnit.name} + ${attachedLeader.name}`,
        members: [...attackerUnit.members, ...attachedLeader.members],
      };
    }
    if (
      Object.keys(weaponProfileChoice).length === 0 &&
      Object.keys(weaponMeltaActive).length === 0 &&
      Object.keys(weaponRapidFireActive).length === 0
    )
      return merged;
    return {
      ...merged,
      members: merged.members.map((m) => ({
        ...m,
        weapons: m.weapons.map((w) => {
          let next = w;
          if (w.profiles && weaponProfileChoice[w.id] !== undefined) {
            const idx = weaponProfileChoice[w.id];
            const p = w.profiles[idx];
            if (p) next = { ...next, ...p, activeProfileIndex: idx };
          }
          if (next.melta > 0 && weaponMeltaActive[w.id]) {
            next = { ...next, damage: next.damage + next.melta };
          }
          if (next.rapidFire > 0 && weaponRapidFireActive[w.id]) {
            next = { ...next, attacks: next.attacks + next.rapidFire };
          }
          return next;
        }),
      })),
    };
  }, [attackerUnit, attachedLeader, weaponProfileChoice, weaponMeltaActive, weaponRapidFireActive]);

  const chooseWeaponProfile = (weaponId, index) => {
    setWeaponProfileChoice((s) => ({ ...s, [weaponId]: index }));
  };
  const toggleWeaponMelta = (weaponId) => {
    setWeaponMeltaActive((s) => ({ ...s, [weaponId]: !s[weaponId] }));
  };
  const toggleWeaponRapidFire = (weaponId) => {
    setWeaponRapidFireActive((s) => ({ ...s, [weaponId]: !s[weaponId] }));
  };

  // When a new attacker unit (or attached leader) is picked, reset the quick
  // attack-bonus panel to reflect whatever the combined unit already has built
  // in (so it's pre-checked to match reality) — still tweakable manually after.
  // Skipped while restoring a saved history entry, so it doesn't clobber the
  // bonuses/modifiers that entry actually used.
  const restoringFromHistoryRef = useRef(false);
  // The "Deska" board's DOM node, so token drag can turn pointer coordinates
  // into a percentage position via getBoundingClientRect.
  const boardContainerRef = useRef(null);

  useEffect(() => {
    if (restoringFromHistoryRef.current) return;
    setAttackerBonus(autoDetectBonus(effectiveAttackerUnit));
  }, [attackerUnitId, attachedLeaderId]);

  useEffect(() => {
    if (restoringFromHistoryRef.current) return;
    setAttachedLeaderId(null);
    setWeaponProfileChoice({});
    setWeaponMeltaActive({});
    setWeaponRapidFireActive({});
  }, [attackerUnitId]);

  useEffect(() => {
    if (restoringFromHistoryRef.current) return;
    setDefenderModelCount(defenderUnit ? totalModels(defenderUnit) : 0);
    const fnp = defenderUnit ? clampNum(defenderUnit.fnp, 0) : 0;
    const debuff = defenderUnit ? !!defenderUnit.woundDebuff : false;
    const dmgReduction = defenderUnit ? clampNum(defenderUnit.damageReduction, 0) : 0;
    setDefenderFnp({ ranged: fnp, melee: fnp });
    setDefenderWoundDebuff({ ranged: debuff, melee: debuff });
    setDefenderDamageReduction({ ranged: dmgReduction, melee: dmgReduction });
    setDefenderSaveReroll({ ranged: "none", melee: "none" });
  }, [defenderUnitId]);

  const result = useMemo(() => {
    if (!effectiveAttackerUnit || !defenderUnit) return null;
    const defByType = {
      ranged: defenderProfile(defenderUnit, {
        models: defenderModelCount,
        fnp: defenderFnp.ranged,
        woundDebuff: defenderWoundDebuff.ranged,
        damageReduction: defenderDamageReduction.ranged,
        toughnessMod: defenderToughnessMod,
        saveMod: defenderSaveMod,
        benefitOfCover: defenderBenefitOfCover,
        saveReroll: defenderSaveReroll.ranged,
      }),
      melee: defenderProfile(defenderUnit, {
        models: defenderModelCount,
        fnp: defenderFnp.melee,
        woundDebuff: defenderWoundDebuff.melee,
        damageReduction: defenderDamageReduction.melee,
        toughnessMod: defenderToughnessMod,
        saveMod: defenderSaveMod,
        saveReroll: defenderSaveReroll.melee,
      }),
    };
    return computeUnitVsUnit(effectiveAttackerUnit, defByType, attackerBonus);
  }, [
    effectiveAttackerUnit,
    defenderUnit,
    attackerBonus,
    defenderModelCount,
    defenderFnp,
    defenderWoundDebuff,
    defenderDamageReduction,
    defenderToughnessMod,
    defenderSaveMod,
    defenderBenefitOfCover,
    defenderSaveReroll,
  ]);

  const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "0");
  // Never display a flat "0.0%" — with dice there is always some (tiny) chance,
  // so round-to-zero values are shown as "<0.1%" instead of implying impossibility.
  const pct = (n) => {
    if (!Number.isFinite(n) || n <= 0) return "<0.1%";
    const v = n * 100;
    return v < 0.1 ? "<0.1%" : `${v.toFixed(1)}%`;
  };

  const cheatMatrix = useMemo(() => {
    const attackers = library.filter((u) => cheatAttackerIds.has(u.id));
    const targets = library.filter((u) => cheatTargetIds.has(u.id));
    return attackers.map((att) => ({
      attacker: att,
      cells: targets.map((tgt) => {
        const tgtModels = totalModels(tgt);

        // Baseline: only whatever the units already have built in (weapon abilities,
        // the defender's own stored FNP / debuff) — no cheat-sheet panel involved.
        const baseRes = computeUnitVsUnit(att, defenderProfile(tgt), ZERO_BONUS);

        // Boosted: same units, plus whatever the cheat-sheet panel adds on top
        // (attacker bonuses merge with each weapon's own abilities; defender FNP/
        // debuff are taken as the better/larger of the unit's own value and the panel's).
        const boostedProfile = {
          ranged: defenderProfile(tgt, {
            fnp: Math.max(clampNum(tgt.fnp, 0), cheatSlotB.ranged.fnp),
            woundDebuff: !!tgt.woundDebuff || cheatSlotB.ranged.woundDebuff,
            damageReduction: Math.max(clampNum(tgt.damageReduction, 0), cheatSlotB.ranged.damageReduction),
            toughnessMod: cheatSlotB.toughnessMod,
            saveMod: cheatSlotB.saveMod,
            benefitOfCover: cheatSlotB.ranged.benefitOfCover,
            saveReroll: cheatSlotB.ranged.saveReroll,
          }),
          melee: defenderProfile(tgt, {
            fnp: Math.max(clampNum(tgt.fnp, 0), cheatSlotB.melee.fnp),
            woundDebuff: !!tgt.woundDebuff || cheatSlotB.melee.woundDebuff,
            damageReduction: Math.max(clampNum(tgt.damageReduction, 0), cheatSlotB.melee.damageReduction),
            toughnessMod: cheatSlotB.toughnessMod,
            saveMod: cheatSlotB.saveMod,
            saveReroll: cheatSlotB.melee.saveReroll,
          }),
        };
        const boostedRes = computeUnitVsUnit(att, boostedProfile, { ranged: cheatSlotA.ranged, melee: cheatSlotA.melee });

        const baseStats = computeSurvivalStats(baseRes, tgt, tgtModels);
        const boostedStats = computeSurvivalStats(boostedRes, tgt, tgtModels);

        return {
          target: tgt,
          base: { res: baseRes, ...baseStats },
          boosted: { res: boostedRes, ...boostedStats },
        };
      }),
    }));
  }, [library, cheatAttackerIds, cheatTargetIds, cheatSlotA, cheatSlotB]);

  const groupedLibrary = useMemo(() => {
    const g = {};
    library.forEach((u) => {
      const f = u.faction || "Bez frakce";
      if (!g[f]) g[f] = [];
      g[f].push(u);
    });
    return g;
  }, [library]);

  // Aggregate the per-weapon breakdown into totals for the Result screen.
  const resultAgg = useMemo(() => {
    if (!result) return null;
    const empty = () => ({ attacks: 0, hits: 0, wounds: 0, through: 0, damage: 0, reductionSaved: 0, fnpSaved: 0 });
    const ranged = empty();
    const melee = empty();
    const total = empty();
    result.breakdown.forEach((b) => {
      const t = b.type === "melee" ? melee : ranged;
      t.attacks += b.detail.attacks;
      t.hits += b.detail.hitsTotal;
      t.wounds += b.detail.woundsTotal;
      t.through += b.detail.through;
      t.damage += b.damage;
      t.reductionSaved += b.detail.reductionSaved || 0;
      t.fnpSaved += b.detail.fnpSaved || 0;
      total.attacks += b.detail.attacks;
      total.hits += b.detail.hitsTotal;
      total.wounds += b.detail.woundsTotal;
      total.through += b.detail.through;
      total.damage += b.damage;
      total.reductionSaved += b.detail.reductionSaved || 0;
      total.fnpSaved += b.detail.fnpSaved || 0;
    });
    return { ranged, melee, total };
  }, [result]);

  const survivalStats = useMemo(
    () => computeSurvivalStats(result, defenderUnit, defenderModelCount),
    [result, defenderUnit, defenderModelCount]
  );
  const chanceAtLeast1 = survivalStats.chanceAtLeast1;
  const chanceDestroyUnit = survivalStats.chanceDestroyUnit;

  const logCalculation = () => {
    if (!result || !effectiveAttackerUnit || !defenderUnit) return;
    const entry = {
      id: crypto.randomUUID(),
      date: new Date().toISOString(),
      attackerName: effectiveAttackerUnit.name,
      defenderName: defenderUnit.name,
      killedModels: result.killedModels,
      totalDamage: result.totalDamage,
      rangedDamage: result.rangedDamage,
      meleeDamage: result.meleeDamage,
      remainingPct: result.remainingPct,
      defenderModelCount,
      agg: resultAgg,
      chanceAtLeast1,
      chanceDestroyUnit,
      // Full state snapshot so this calculation can be reopened and edited later.
      attackerUnitId,
      defenderUnitId,
      attachedLeaderId,
      weaponProfileChoice,
      weaponMeltaActive,
      weaponRapidFireActive,
      attackerBonus,
      defenderFnp,
      defenderWoundDebuff,
      defenderDamageReduction,
      defenderSaveReroll,
    };
    persistHistory([entry, ...history].slice(0, 60));
  };

  // Reopens a saved history entry back into the calculator (Result step) so it
  // can be tweaked further — only works if both units are still in the library.
  const reopenHistoryEntry = (h) => {
    const attExists = library.some((u) => u.id === h.attackerUnitId);
    const defExists = library.some((u) => u.id === h.defenderUnitId);
    if (!attExists || !defExists) return false;
    restoringFromHistoryRef.current = true;
    setAttackerUnitId(h.attackerUnitId);
    setDefenderUnitId(h.defenderUnitId);
    setAttachedLeaderId(h.attachedLeaderId || null);
    setWeaponProfileChoice(h.weaponProfileChoice || {});
    setWeaponMeltaActive(h.weaponMeltaActive || {});
    setWeaponRapidFireActive(h.weaponRapidFireActive || {});
    if (h.attackerBonus) setAttackerBonus(h.attackerBonus);
    if (h.defenderModelCount !== undefined) setDefenderModelCount(h.defenderModelCount);
    if (h.defenderFnp) setDefenderFnp(h.defenderFnp);
    if (h.defenderWoundDebuff) setDefenderWoundDebuff(h.defenderWoundDebuff);
    if (h.defenderDamageReduction) setDefenderDamageReduction(h.defenderDamageReduction);
    if (h.defenderSaveReroll) setDefenderSaveReroll(h.defenderSaveReroll);
    setCalcStep("result");
    setView("calculator");
    // Clear the guard on the next tick, once React has finished processing all
    // the effects triggered by the state changes above.
    setTimeout(() => {
      restoringFromHistoryRef.current = false;
    }, 0);
    return true;
  };

  // Full, uncut plain-text summary of a history entry — for the "Kopírovat" button.
  const historyEntryText = (h) => {
    const lines = [
      `${h.attackerName} → ${h.defenderName}`,
      fmtDate(h.date),
      "",
      `Očekávané zabité modely: ${fmt(h.killedModels)} z ${h.defenderModelCount}`,
      `Celkový damage: ${fmt(h.totalDamage)} (na dálku ${fmt(h.rangedDamage)} · na blízko ${fmt(h.meleeDamage)})`,
      `Zbývá z jednotky: ${pct(h.remainingPct)}`,
      `Šance zabít alespoň 1 model (odhad): ${pct(h.chanceAtLeast1)}`,
      `Šance zničit celou jednotku (odhad): ${pct(h.chanceDestroyUnit)}`,
      `Šance, že jednotka přežije (odhad): ${pct(1 - h.chanceDestroyUnit)}`,
    ];
    if (h.agg) {
      lines.push(
        "",
        "Na dálku:",
        `  Útoky: ${fmt(h.agg.ranged.attacks, 1)}`,
        `  Zásahy: ${fmt(h.agg.ranged.hits, 2)}`,
        `  Zranění: ${fmt(h.agg.ranged.wounds, 2)}`,
        `  Neúspěšné save: ${fmt(h.agg.ranged.through, 2)}`,
        `  Damage: ${fmt(h.agg.ranged.damage, 2)}`,
        "",
        "Na blízko:",
        `  Útoky: ${fmt(h.agg.melee.attacks, 1)}`,
        `  Zásahy: ${fmt(h.agg.melee.hits, 2)}`,
        `  Zranění: ${fmt(h.agg.melee.wounds, 2)}`,
        `  Neúspěšné save: ${fmt(h.agg.melee.through, 2)}`,
        `  Damage: ${fmt(h.agg.melee.damage, 2)}`
      );
    }
    return lines.join("\n");
  };

  const startNewCalculation = () => {
    setAttackerUnitId(null);
    setDefenderUnitId(null);
    setAttackerSearch("");
    setDefenderSearch("");
    setAttackerFilter(null);
    setDefenderFilter(null);
    setDefenderModifiersOpen(false);
    setCalcStep("setup");
    setView("calculator");
  };

  const allWeapons = useMemo(() => {
    const map = new Map();
    library.forEach((u) => {
      u.members.forEach((m) => {
        m.weapons.forEach((w) => {
          const key = `${w.name}|${w.type}|${w.attacks}|${w.hitX}|${w.strength}|${w.ap}|${w.damage}`;
          if (!map.has(key)) map.set(key, { ...w, unitName: u.name });
        });
      });
    });
    return Array.from(map.values());
  }, [library]);

  // Factions + saved armies combined into one pick list for the "vyber frakci/armádu"
  // step. Selecting one narrows the unit list shown afterwards.
  const pickerOptions = useMemo(() => {
    const factions = Object.entries(groupedLibrary).map(([faction, units]) => ({ type: "faction", key: faction, label: faction, count: units.length }));
    const armyOpts = armies.map((a) => ({ type: "army", key: a.id, label: a.name, count: a.unitIds.length }));
    return { factions, armyOpts };
  }, [groupedLibrary, armies]);

  const unitMatchesFilter = (u, filter) => {
    if (!filter) return true;
    if (filter.type === "faction") return (u.faction || "Bez frakce") === filter.key;
    const army = armies.find((a) => a.id === filter.key);
    return army ? army.unitIds.includes(u.id) : true;
  };

  const filteredAttackerList = useMemo(
    () => library.filter((u) => u.name.toLowerCase().includes(attackerSearch.toLowerCase()) && unitMatchesFilter(u, attackerFilter)),
    [library, attackerSearch, attackerFilter, armies]
  );
  const filteredDefenderList = useMemo(
    () => library.filter((u) => u.name.toLowerCase().includes(defenderSearch.toLowerCase()) && unitMatchesFilter(u, defenderFilter)),
    [library, defenderSearch, defenderFilter, armies]
  );
  const filteredLibraryUnits = useMemo(
    () => library.filter((u) => u.name.toLowerCase().includes(librarySearch.toLowerCase())),
    [library, librarySearch]
  );
  const filteredWeapons = useMemo(
    () => allWeapons.filter((w) => w.name.toLowerCase().includes(librarySearch.toLowerCase())),
    [allWeapons, librarySearch]
  );

  const fmtDate = (iso) => {
    const d = new Date(iso);
    const today = new Date();
    const isToday = d.toDateString() === today.toDateString();
    const time = d.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" });
    return isToday ? `Dnes, ${time}` : `${d.toLocaleDateString("cs-CZ")}, ${time}`;
  };

  const tabBtnStyle = (active) => ({
    flex: 1,
    border: "1px solid " + (active ? "var(--accent)" : "var(--field-border)"),
    background: active ? "var(--accent-dim)" : "transparent",
    color: active ? "var(--accent-text)" : "var(--text)",
    borderRadius: 8,
    padding: "8px 0",
    fontSize: 12.5,
    fontWeight: 700,
    cursor: "pointer",
  });
  const dashedBtnStyle = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    border: "1px dashed var(--field-border)",
    background: "transparent",
    color: "var(--text)",
    borderRadius: 8,
    padding: "9px 13px",
    fontSize: 12.5,
    cursor: "pointer",
  };

  return (
    <div
      className={`wh40k-shell${forceCompact ? " wh40k-compact" : ""}`}
      style={{
        "--bg": "#070c14",
        "--panel": "#0f1826",
        "--field-bg": "#0a121e",
        "--field-border": "#1f3149",
        "--text": "#eaf1fb",
        "--muted": "#7e93ad",
        "--label": "#9cb2c9",
        "--accent": "#2f8fe8",
        "--accent-dim": "#0f2842",
        "--accent-text": "#7cc0ff",
        "--accent-on": "#ffffff",
        "--blue": "#2f8fe8",
        "--blue-dim": "#0f2842",
        "--amber": "#e8a72f",
        "--mono": "'JetBrains Mono', 'Courier New', monospace",
        fontFamily: "'Inter', -apple-system, sans-serif",
        background: "radial-gradient(ellipse 120% 60% at 50% -10%, #102338 0%, #070c14 55%)",
        color: "var(--text)",
        borderRadius: 18,
        width: 460,
        maxWidth: "100%",
        flexShrink: 0,
        margin: "0 auto",
        transition: "width 0.15s ease",
        border: "1px solid #16233a",
        overflow: "hidden",
        paddingBottom: 68,
        position: "relative",
      }}
    >
      <style>{`
        @media print {
          @page { size: landscape; margin: 10mm; }
          .no-print { display: none !important; }
          .print-area { display: block !important; }
          .wh40k-shell {
            max-width: none !important;
            width: 100% !important;
            margin: 0 !important;
            padding: 0 !important;
            border: none !important;
            border-radius: 0 !important;
            background: #fff !important;
            overflow: visible !important;
          }
          .print-area {
            margin: 0 !important;
            padding: 0 !important;
            border-radius: 0 !important;
            overflow: visible !important;
          }
          .print-area table { table-layout: fixed; width: 100%; font-size: 8px; }
          .print-area tr { break-inside: avoid; }
          .print-area th, .print-area td { overflow-wrap: break-word; word-break: normal; padding: 2px 3px !important; }
          .print-area th:first-child, .print-area td:first-child { width: 110px; }
        }
        @keyframes wh40k-pulse {
          0%, 100% { box-shadow: 0 0 14px rgba(47,143,232,0.5), 0 0 0 rgba(47,143,232,0); }
          50% { box-shadow: 0 0 20px rgba(47,143,232,0.8), 0 0 8px rgba(47,143,232,0.3); }
        }
        .wh40k-glow-icon { animation: wh40k-pulse 3s ease-in-out infinite; }
        .wh40k-card { transition: border-color 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease; }
        .wh40k-card:hover { transform: translateY(-1px); }
        .wh40k-hero-card { position: relative; overflow: hidden; }
        .wh40k-hero-card::before {
          content: "";
          position: absolute;
          inset: -40% -10% auto -10%;
          height: 160%;
          background: radial-gradient(closest-side, rgba(47,143,232,0.18), transparent 70%);
          pointer-events: none;
        }
        .wh40k-btn { transition: filter 0.15s ease, transform 0.1s ease; }
        .wh40k-btn:hover { filter: brightness(1.15); }
        .wh40k-btn:active { transform: scale(0.98); }
        .wh40k-select, .wh40k-input { transition: border-color 0.15s ease, box-shadow 0.15s ease; }
        .wh40k-select:focus, .wh40k-input:focus { outline: none; border-color: var(--accent) !important; box-shadow: 0 0 0 3px rgba(47,143,232,0.25); }

        .wh40k-row { display: grid; gap: 8px; margin-bottom: 8px; min-width: 0; }
        .wh40k-row-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .wh40k-row-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        .wh40k-row-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
        .wh40k-grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; min-width: 0; }
        .wh40k-grid-2, .wh40k-row, .wh40k-row * { min-width: 0; }
        @media (max-width: 380px) {
          .wh40k-row-2, .wh40k-row-3, .wh40k-row-4 { grid-template-columns: 1fr; }
        }
        /* Responsive by default — wider viewports (tablet/monitor) get a
           wider shell so grids/tables have room to breathe, instead of
           staying pinned at phone-card width. .wh40k-compact opts back out. */
        @media (min-width: 640px) {
          .wh40k-shell:not(.wh40k-compact) { width: 700px !important; }
        }
        @media (min-width: 900px) {
          .wh40k-shell:not(.wh40k-compact) { width: 940px !important; }
        }
        @media (min-width: 1200px) {
          .wh40k-shell:not(.wh40k-compact) { width: 1200px !important; }
        }
        /* Calculator: attacker and defender "naproti sobě" (facing each
           other) — one column on a phone-width shell, two side by side once
           there's room (matches the 900px breakpoint that also widens the
           shell itself, so both cards get real space to breathe). */
        .wh40k-vs-columns { display: grid; grid-template-columns: 1fr; gap: 12px; min-width: 0; margin-bottom: 12px; }
        @media (min-width: 900px) {
          .wh40k-shell:not(.wh40k-compact) .wh40k-vs-columns { grid-template-columns: 1fr 1fr; gap: 16px; }
        }
        * { box-sizing: border-box; }
      `}</style>

      {/* TOP BAR */}
      <div className="no-print" style={{ padding: "16px 14px 10px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "relative" }}>
        <button onClick={() => setMenuOpen((o) => !o)} aria-label="Menu" style={{ background: "transparent", border: "none", color: "var(--text)", cursor: "pointer", padding: 6, display: "flex" }}>
          <Menu size={20} />
        </button>
        <button
          onClick={() => {
            setView("home");
            setMenuOpen(false);
            setSettingsOpen(false);
          }}
          style={{ display: "flex", alignItems: "center", gap: 8, background: "transparent", border: "none", cursor: "pointer" }}
        >
          <SkullLogo size={30} />
          <div style={{ textAlign: "left" }}>
            <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: 0.5, color: "var(--text)" }}>BATTLECALC</div>
            <div style={{ fontSize: 8, fontWeight: 700, color: "var(--accent-text)", letterSpacing: 1.2 }}>DAMAGE CALCULATOR</div>
          </div>
        </button>
        <button onClick={() => setSettingsOpen((o) => !o)} aria-label="Nastavení" style={{ background: "transparent", border: "none", color: "var(--text)", cursor: "pointer", padding: 6, display: "flex" }}>
          <Settings size={19} />
        </button>

        {(menuOpen || settingsOpen) && (
          <div
            onClick={() => {
              setMenuOpen(false);
              setSettingsOpen(false);
            }}
            style={{ position: "fixed", inset: 0, zIndex: 25 }}
          />
        )}
        {menuOpen && (
          <div style={{ position: "absolute", top: "100%", left: 10, background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 10, padding: 6, zIndex: 30, minWidth: 200, boxShadow: "0 10px 28px rgba(0,0,0,0.5)" }}>
            {[
              ["Nový výpočet", () => startNewCalculation()],
              ["Knihovna jednotek", () => setView("library")],
              ["Moje armády a cheat sheet", () => setView("lists")],
              ["Historie výpočtů", () => setView("history")],
              [isFullscreen ? "Ukončit celou obrazovku" : "Celá obrazovka", () => toggleFullscreen()],
              [forceCompact ? "Automaticky podle displeje" : "Vždy úzké (mobil)", () => toggleForceCompact()],
              ["Návod k použití", () => setView("manual")],
            ].map(([label, fn]) => (
              <button
                key={label}
                onClick={() => {
                  fn();
                  setMenuOpen(false);
                }}
                style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left", background: "transparent", border: "none", color: "var(--text)", fontSize: 12.5, padding: "8px 10px", borderRadius: 6, cursor: "pointer" }}
              >
                {label === "Celá obrazovka" || label === "Ukončit celou obrazovku" ? (
                  isFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />
                ) : null}
                {label === "Automaticky podle displeje" || label === "Vždy úzké (mobil)" ? <LayoutGrid size={13} /> : null}
                {label === "Návod k použití" ? <HelpCircle size={13} /> : null}
                {label}
              </button>
            ))}
          </div>
        )}
        {settingsOpen && (
          <div style={{ position: "absolute", top: "100%", right: 10, background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 10, padding: 6, zIndex: 30, minWidth: 200, boxShadow: "0 10px 28px rgba(0,0,0,0.5)" }}>
            {session?.user?.email && (
              <div style={{ fontSize: 10.5, color: "var(--muted)", padding: "6px 10px 8px", borderBottom: "1px solid var(--field-border)", marginBottom: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {session.user.email}
              </div>
            )}
            <button
              onClick={() => {
                setSettingsOpen(false);
                askConfirm("Opravdu smazat celou knihovnu jednotek? Nelze vrátit zpět.", clearLibrary);
              }}
              style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left", background: "transparent", border: "none", color: "#e0857c", fontSize: 12.5, padding: "8px 10px", borderRadius: 6, cursor: "pointer" }}
            >
              <Trash2 size={13} /> Vymazat knihovnu
            </button>
            <button
              onClick={() => {
                setSettingsOpen(false);
                askConfirm("Smazat historii výpočtů?", clearHistory);
              }}
              style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left", background: "transparent", border: "none", color: "#e0857c", fontSize: 12.5, padding: "8px 10px", borderRadius: 6, cursor: "pointer" }}
            >
              <Trash2 size={13} /> Vymazat historii
            </button>
            <button
              onClick={() => {
                setSettingsOpen(false);
                askConfirm("Odhlásit se?", () => supabase && supabase.auth.signOut());
              }}
              style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left", background: "transparent", border: "none", color: "var(--muted)", fontSize: 12.5, padding: "8px 10px", borderRadius: 6, cursor: "pointer" }}
            >
              <ArrowLeft size={13} /> Odhlásit se
            </button>
          </div>
        )}
      </div>

      {/* HOME */}
      {view === "home" && (
        <div className="no-print" style={{ padding: "4px 14px 16px" }}>
          <button onClick={startNewCalculation} className="wh40k-card wh40k-hero-card wh40k-btn" style={{ width: "100%", textAlign: "left", background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 14, padding: 16, cursor: "pointer", marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", position: "relative" }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.7, textTransform: "uppercase", color: "var(--text)" }}>Nový výpočet</div>
                <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>Vyber útočníka a obránce</div>
              </div>
              <ChevronRight size={18} color="var(--accent-text)" />
            </div>
            <div
              style={{
                marginTop: 14,
                height: 88,
                borderRadius: 10,
                background: "radial-gradient(circle at 50% 50%, rgba(47,143,232,0.3), transparent 70%), linear-gradient(180deg, #0d1c2e, #0a141f)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-around",
                position: "relative",
                overflow: "hidden",
              }}
            >
              <Sword size={32} color="var(--accent-text)" style={{ opacity: 0.5 }} />
              <Crosshair size={38} color="var(--accent-text)" style={{ filter: "drop-shadow(0 0 8px rgba(47,143,232,0.7))" }} />
              <Shield size={32} color="var(--accent-text)" style={{ opacity: 0.5 }} />
            </div>
          </button>

          <div className="wh40k-grid-2" style={{ marginBottom: 16 }}>
            <TileButton icon={Folder} label="Moje výpočty" value={history.length + " uloženo"} onClick={() => setView("history")} />
            <TileButton
              icon={Star}
              label="Oblíbené"
              value={favoriteUnits.length + " položek"}
              onClick={() => {
                setView("library");
                setLibraryTab("units");
              }}
            />
            <TileButton
              icon={SkullIcon}
              label="Knihovna jednotek"
              value="Procházet jednotky"
              onClick={() => {
                setView("library");
                setLibraryTab("units");
              }}
            />
            <TileButton
              icon={Crosshair}
              label="Knihovna zbraní"
              value="Procházet zbraně"
              onClick={() => {
                setView("library");
                setLibraryTab("weapons");
              }}
            />
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6 }}>Poslední výpočty</div>
            {history.length > 0 && (
              <button onClick={() => setView("history")} style={{ background: "transparent", border: "none", color: "var(--accent-text)", fontSize: 11, cursor: "pointer" }}>
                Zobrazit vše
              </button>
            )}
          </div>
          {!historyLoaded && <div style={{ fontSize: 12, color: "var(--muted)" }}>Načítám…</div>}
          {historyLoaded && history.length === 0 && (
            <div style={{ fontSize: 12, color: "var(--muted)", background: "var(--field-bg)", border: "1px dashed var(--field-border)", borderRadius: 8, padding: "10px 12px" }}>
              Zatím žádné výpočty. Klikni na "Nový výpočet" a vyzkoušej to.
            </div>
          )}
          {history.slice(0, 3).map((h) => (
            <div
              key={h.id}
              onClick={() => {
                setExpandedHistoryId(h.id);
                setView("history");
              }}
              role="button"
              tabIndex={0}
              className="wh40k-btn"
              style={{ display: "flex", alignItems: "center", gap: 10, background: "var(--field-bg)", border: "1px solid var(--field-border)", borderRadius: 8, padding: "9px 10px", marginBottom: 6, cursor: "pointer" }}
            >
              <Swords size={15} color="var(--accent-text)" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {h.attackerName} vs {h.defenderName}
                </div>
                <div style={{ fontSize: 10.5, color: "var(--muted)" }}>{fmtDate(h.date)}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "var(--accent-text)", fontFamily: "var(--mono)" }}>{fmt(h.killedModels)}</div>
                <div style={{ fontSize: 9, color: "var(--muted)" }}>modelů</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* CALCULATOR */}
      {view === "calculator" && (
        <div className="no-print" style={{ padding: "4px 14px 16px" }}>
          {calcStep === "setup" && (
            <div style={{ marginTop: 6 }}>
              <button
                onClick={() => setView("home")}
                style={{ display: "flex", alignItems: "center", gap: 5, background: "transparent", border: "none", color: "var(--muted)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, cursor: "pointer", padding: 0, marginBottom: 12 }}
              >
                <ArrowLeft size={13} /> Kalkulačka
              </button>

              <button
                onClick={() => {
                  logCalculation();
                  setCalcStep("result");
                }}
                disabled={!attackerUnit || !defenderUnit}
                className="wh40k-btn"
                style={{
                  width: "100%",
                  marginBottom: 14,
                  border: "none",
                  background: attackerUnit && defenderUnit ? "var(--accent)" : "var(--field-border)",
                  color: attackerUnit && defenderUnit ? "#fff" : "var(--muted)",
                  borderRadius: 8,
                  padding: 13,
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: attackerUnit && defenderUnit ? "pointer" : "not-allowed",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                }}
              >
                <Crosshair size={16} /> Spočítat
              </button>

              {/* ÚTOČNÍK a OBRÁNCE naproti sobě — jeden sloupec na mobilu, dva na širším displeji. */}
              <div className="wh40k-vs-columns">
                {/* ÚTOČNÍK */}
                <div style={{ background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 12, padding: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                    <Crosshair size={13} color="#a9c6e5" />
                    <div style={{ fontSize: 11, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6 }}>Útočník</div>
                  </div>

                  {!attackerUnit ? (
                    !attackerFilter ? (
                      <>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>Vyber frakci nebo armádu</div>
                        {library.length === 0 && (
                          <div style={{ fontSize: 12.5, color: "var(--muted)", background: "var(--field-bg)", border: "1px dashed var(--field-border)", borderRadius: 8, padding: 12 }}>
                            Knihovna je prázdná. Přidej jednotky v sekci Knihovna v menu.
                          </div>
                        )}
                        {pickerOptions.armyOpts.length > 0 && (
                          <>
                            <div style={{ fontSize: 10, fontWeight: 700, color: "var(--amber)", textTransform: "uppercase", marginBottom: 4 }}>Moje armády</div>
                            {pickerOptions.armyOpts.map((o) => (
                              <PickerRow key={o.type + o.key} icon={Folder} label={o.label} count={o.count} onClick={() => setAttackerFilter(o)} />
                            ))}
                            <div style={{ fontSize: 10, fontWeight: 700, color: "var(--amber)", textTransform: "uppercase", margin: "10px 0 4px" }}>Frakce</div>
                          </>
                        )}
                        {pickerOptions.factions.map((o) => (
                          <PickerRow key={o.type + o.key} icon={SkullIcon} label={o.label} count={o.count} onClick={() => setAttackerFilter(o)} />
                        ))}
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => {
                            setAttackerFilter(null);
                            setAttackerSearch("");
                          }}
                          style={{ display: "flex", alignItems: "center", gap: 5, background: "transparent", border: "none", color: "var(--accent-text)", fontSize: 11.5, fontWeight: 700, cursor: "pointer", padding: 0, marginBottom: 10 }}
                        >
                          <ArrowLeft size={12} /> {attackerFilter.label}
                        </button>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>Vyber jednotku útočníka</div>
                        <SearchBox value={attackerSearch} onChange={setAttackerSearch} placeholder="Hledat jednotky…" />
                        {filteredAttackerList.length === 0 && (
                          <div style={{ fontSize: 12.5, color: "var(--muted)", background: "var(--field-bg)", border: "1px dashed var(--field-border)", borderRadius: 8, padding: 12 }}>
                            Nic tu neodpovídá hledání.
                          </div>
                        )}
                        <div style={{ maxHeight: 360, overflowY: "auto" }}>
                          {filteredAttackerList.map((u) => (
                            <UnitListRow key={u.id} u={u} selected={u.id === attackerUnitId} onClick={() => setAttackerUnitId(u.id)} />
                          ))}
                        </div>
                      </>
                    )
                  ) : (
                    <>
                      <button
                        onClick={() => setAttackerUnitId(null)}
                        style={{ display: "flex", alignItems: "center", gap: 5, background: "transparent", border: "none", color: "var(--accent-text)", fontSize: 11.5, fontWeight: 700, cursor: "pointer", padding: 0, marginBottom: 10 }}
                      >
                        <ArrowLeft size={12} /> Změnit jednotku
                      </button>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <SkullLogo size={26} />
                        <div style={{ fontWeight: 700, fontSize: 13.5 }}>{attackerUnit.name}</div>
                      </div>
                      <label style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 12 }}>
                        <span style={{ fontSize: 11.5, color: "var(--label)", fontWeight: 600 }}>Připojit vůdce (volitelné)</span>
                        <select
                          value={attachedLeaderId || ""}
                          onChange={(e) => setAttachedLeaderId(e.target.value || null)}
                          className="wh40k-select"
                          style={{ background: "var(--field-bg)", border: "1px solid var(--field-border)", borderRadius: 6, color: "var(--text)", padding: "7px 9px", fontSize: 13 }}
                        >
                          <option value="">— žádný —</option>
                          {library
                            .filter((u) => u.id !== attackerUnitId && u.isLeader && (u.faction || "Bez frakce") === (attackerUnit.faction || "Bez frakce"))
                            .filter((u, idx, arr) => arr.findIndex((x) => unitSignature(x) === unitSignature(u)) === idx)
                            .map((u) => (
                              <option key={u.id} value={u.id}>
                                {u.name}
                              </option>
                            ))}
                        </select>
                      </label>
                      <div style={{ marginTop: 8, background: "var(--field-bg)", border: "1px solid var(--field-border)", borderRadius: 8, padding: 10 }}>
                        <div style={{ fontSize: 10.5, fontWeight: 700, color: "#a9c6e5", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8, display: "flex", alignItems: "center", gap: 5 }}>
                          <Crosshair size={12} /> Bonusy na dálku
                        </div>
                        <BonusFieldsGroup
                          bonus={attackerBonus.ranged}
                          setBonus={(updater) => setAttackerBonus((s) => ({ ...s, ranged: typeof updater === "function" ? updater(s.ranged) : updater }))}
                          isRanged
                        />
                      </div>
                      <div style={{ marginTop: 8, background: "var(--field-bg)", border: "1px solid var(--field-border)", borderRadius: 8, padding: 10 }}>
                        <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--accent-text)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8, display: "flex", alignItems: "center", gap: 5 }}>
                          <Sword size={12} /> Bonusy na blízko
                        </div>
                        <BonusFieldsGroup
                          bonus={attackerBonus.melee}
                          setBonus={(updater) => setAttackerBonus((s) => ({ ...s, melee: typeof updater === "function" ? updater(s.melee) : updater }))}
                        />
                      </div>
                      <UnitComposition
                        unit={effectiveAttackerUnit}
                        profileChoices={weaponProfileChoice}
                        onChooseProfile={chooseWeaponProfile}
                        meltaActive={weaponMeltaActive}
                        onToggleMelta={toggleWeaponMelta}
                        rapidFireActive={weaponRapidFireActive}
                        onToggleRapidFire={toggleWeaponRapidFire}
                      />
                    </>
                  )}
                </div>

                {/* OBRÁNCE */}
                <div style={{ background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 12, padding: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                    <SkullIcon size={13} color="var(--amber)" />
                    <div style={{ fontSize: 11, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6 }}>Obránce</div>
                  </div>

                  {!defenderUnit ? (
                    !defenderFilter ? (
                      <>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>Vyber frakci nebo armádu</div>
                        {pickerOptions.armyOpts.length > 0 && (
                          <>
                            <div style={{ fontSize: 10, fontWeight: 700, color: "var(--amber)", textTransform: "uppercase", marginBottom: 4 }}>Moje armády</div>
                            {pickerOptions.armyOpts.map((o) => (
                              <PickerRow key={o.type + o.key} icon={Folder} label={o.label} count={o.count} onClick={() => setDefenderFilter(o)} />
                            ))}
                            <div style={{ fontSize: 10, fontWeight: 700, color: "var(--amber)", textTransform: "uppercase", margin: "10px 0 4px" }}>Frakce</div>
                          </>
                        )}
                        {pickerOptions.factions.map((o) => (
                          <PickerRow key={o.type + o.key} icon={SkullIcon} label={o.label} count={o.count} onClick={() => setDefenderFilter(o)} />
                        ))}
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => {
                            setDefenderFilter(null);
                            setDefenderSearch("");
                          }}
                          style={{ display: "flex", alignItems: "center", gap: 5, background: "transparent", border: "none", color: "var(--accent-text)", fontSize: 11.5, fontWeight: 700, cursor: "pointer", padding: 0, marginBottom: 10 }}
                        >
                          <ArrowLeft size={12} /> {defenderFilter.label}
                        </button>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>Vyber jednotku obránce</div>
                        <SearchBox value={defenderSearch} onChange={setDefenderSearch} placeholder="Hledat jednotky…" />
                        {filteredDefenderList.length === 0 && (
                          <div style={{ fontSize: 12.5, color: "var(--muted)", background: "var(--field-bg)", border: "1px dashed var(--field-border)", borderRadius: 8, padding: 12 }}>
                            Nic tu neodpovídá hledání.
                          </div>
                        )}
                        <div style={{ maxHeight: 360, overflowY: "auto" }}>
                          {filteredDefenderList.map((u) => (
                            <UnitListRow key={u.id} u={u} selected={u.id === defenderUnitId} onClick={() => setDefenderUnitId(u.id)} />
                          ))}
                        </div>
                      </>
                    )
                  ) : (
                    <>
                      <button
                        onClick={() => setDefenderUnitId(null)}
                        style={{ display: "flex", alignItems: "center", gap: 5, background: "transparent", border: "none", color: "var(--accent-text)", fontSize: 11.5, fontWeight: 700, cursor: "pointer", padding: 0, marginBottom: 10 }}
                      >
                        <ArrowLeft size={12} /> Změnit jednotku
                      </button>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                        <SkullLogo size={26} />
                        <div style={{ fontWeight: 700, fontSize: 13.5 }}>{defenderUnit.name}</div>
                      </div>
                      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 10 }}>
                        <StatChip label="Toughness" value={defenderUnit.toughness} />
                        <StatChip label="Save" value={defenderUnit.save + "+"} />
                        <StatChip label="Invuln." value={defenderUnit.invul > 0 ? defenderUnit.invul + "+" : "—"} />
                        <StatChip label="Wounds" value={defenderUnit.wounds} />
                      </div>
                      <button
                        onClick={() => setDefenderModifiersOpen((o) => !o)}
                        style={{ display: "flex", alignItems: "center", gap: 4, background: "transparent", border: "none", color: "var(--accent-text)", fontSize: 11.5, fontWeight: 700, cursor: "pointer", padding: 0, textTransform: "uppercase", letterSpacing: 0.4 }}
                      >
                        <Plus size={12} /> Modifikátory (volitelné)
                        <ChevronDown size={12} style={{ transform: defenderModifiersOpen ? "rotate(180deg)" : "none" }} />
                      </button>
                      {defenderModifiersOpen && (
                        <div style={{ marginTop: 10 }}>
                          <NumberField label="Počet modelů v jednotce" value={defenderModelCount} onChange={(v) => setDefenderModelCount(Math.max(0, v))} min={0} small />
                          <Row cols={2}>
                            <NumberField
                              label="Toughness (Nurglovy dary)"
                              value={defenderToughnessMod}
                              onChange={(v) => setDefenderToughnessMod(v)}
                              hint="zadej -1 pro zhoršení; pro obě strany"
                              small
                            />
                            <NumberField
                              label="Save (Nurglovy dary)"
                              value={defenderSaveMod}
                              onChange={(v) => setDefenderSaveMod(v)}
                              hint="zadej -1 pro zhoršení; pro obě strany"
                              small
                            />
                          </Row>
                          <div style={{ marginTop: 8, background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 8, padding: 8 }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: "#a9c6e5", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6, display: "flex", alignItems: "center", gap: 4 }}>
                              <Crosshair size={11} /> Proti útokům na dálku
                            </div>
                            <Row cols={4}>
                              <NumberField
                                label="FNP (0 = žádný)"
                                value={defenderFnp.ranged}
                                onChange={(v) => setDefenderFnp((s) => ({ ...s, ranged: Math.max(0, v) }))}
                                min={0}
                                small
                              />
                              <NumberField
                                label="Redukce dmg (0 = žádná)"
                                value={defenderDamageReduction.ranged}
                                onChange={(v) => setDefenderDamageReduction((s) => ({ ...s, ranged: Math.max(0, v) }))}
                                min={0}
                                small
                              />
                              <ToggleField
                                label="Debuff: -1 WR pokud S > T"
                                value={defenderWoundDebuff.ranged}
                                onChange={(v) => setDefenderWoundDebuff((s) => ({ ...s, ranged: v }))}
                                small
                              />
                              <ToggleField
                                label="Benefit of Cover (-1 BS)"
                                value={defenderBenefitOfCover}
                                onChange={setDefenderBenefitOfCover}
                                hint="jen proti útokům na dálku"
                                small
                              />
                              <SelectField
                                label="Přehoz save hodu"
                                value={defenderSaveReroll.ranged}
                                onChange={(v) => setDefenderSaveReroll((s) => ({ ...s, ranged: v }))}
                                options={REROLL_OPTIONS}
                                small
                              />
                            </Row>
                          </div>
                          <div style={{ marginTop: 8, background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 8, padding: 8 }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: "var(--accent-text)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6, display: "flex", alignItems: "center", gap: 4 }}>
                              <Sword size={11} /> Proti útokům na blízko
                            </div>
                            <Row cols={4}>
                              <NumberField
                                label="FNP (0 = žádný)"
                                value={defenderFnp.melee}
                                onChange={(v) => setDefenderFnp((s) => ({ ...s, melee: Math.max(0, v) }))}
                                min={0}
                                small
                              />
                              <NumberField
                                label="Redukce dmg (0 = žádná)"
                                value={defenderDamageReduction.melee}
                                onChange={(v) => setDefenderDamageReduction((s) => ({ ...s, melee: Math.max(0, v) }))}
                                min={0}
                                small
                              />
                              <ToggleField
                                label="Debuff: -1 WR pokud S > T"
                                value={defenderWoundDebuff.melee}
                                onChange={(v) => setDefenderWoundDebuff((s) => ({ ...s, melee: v }))}
                                small
                              />
                              <SelectField
                                label="Přehoz save hodu"
                                value={defenderSaveReroll.melee}
                                onChange={(v) => setDefenderSaveReroll((s) => ({ ...s, melee: v }))}
                                options={REROLL_OPTIONS}
                                small
                              />
                            </Row>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {calcStep === "result" && result && (
            <div style={{ marginTop: 2 }}>
              <button
                onClick={() => setCalcStep("setup")}
                style={{ display: "flex", alignItems: "center", gap: 5, background: "transparent", border: "none", color: "var(--muted)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, cursor: "pointer", padding: 0, marginBottom: 12 }}
              >
                <ArrowLeft size={13} /> Kalkulačka
              </button>

              <div
                className="wh40k-hero-card"
                style={{ background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 14, padding: "18px 18px", boxShadow: "0 0 0 1px rgba(47,143,232,0.12), 0 8px 24px rgba(0,0,0,0.25)" }}
              >
                <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--accent-text)", textTransform: "uppercase", letterSpacing: 0.9, marginBottom: 4, position: "relative" }}>Výsledek</div>
                <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 12, position: "relative" }}>
                  {effectiveAttackerUnit.name} → {defenderUnit.name}
                </div>

                <div style={{ fontSize: 11, color: "var(--muted)", position: "relative" }}>Očekávané zabité modely</div>
                <div
                  style={{
                    fontSize: 40,
                    fontWeight: 800,
                    fontFamily: "var(--mono)",
                    lineHeight: 1.15,
                    position: "relative",
                    backgroundImage: "linear-gradient(135deg, #bfe3ff, #2f8fe8 60%, #1b5faa)",
                    WebkitBackgroundClip: "text",
                    backgroundClip: "text",
                    color: "transparent",
                    filter: "drop-shadow(0 0 16px rgba(47,143,232,0.4))",
                  }}
                >
                  {fmt(result.killedModels)}
                </div>
                <div style={{ fontSize: 12, color: "var(--muted)", marginTop: -2, position: "relative" }}>
                  z {defenderModelCount} modelů{" "}
                  <span style={{ opacity: 0.75 }}>
                    (průměr přes více her; jistě padne {Math.floor(result.killedModels)})
                  </span>
                </div>
                <SkullRow killed={result.killedModels} total={defenderModelCount} />
                {defenderModelCount <= 1 && (
                  <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 4 }}>podíl zdraví tohoto modelu spotřebovaný útokem</div>
                )}

                <div className="wh40k-row wh40k-row-2" style={{ marginTop: 16, marginBottom: 0 }}>
                  <div style={{ background: "var(--field-bg)", borderRadius: 10, padding: "10px 12px" }}>
                    <div style={{ fontSize: 9.5, color: "var(--muted)", marginBottom: 3, textTransform: "uppercase" }}>Průměrné poškození</div>
                    <div style={{ fontSize: 17, fontWeight: 700, fontFamily: "var(--mono)" }}>{fmt(result.totalDamage)}</div>
                  </div>
                  <div style={{ background: "var(--field-bg)", borderRadius: 10, padding: "10px 12px" }}>
                    <div style={{ fontSize: 9.5, color: "var(--muted)", marginBottom: 3, textTransform: "uppercase" }}>Zbývá z jednotky</div>
                    <div style={{ fontSize: 17, fontWeight: 700, fontFamily: "var(--mono)" }}>{pct(result.remainingPct)}</div>
                  </div>
                </div>

                <div style={{ marginTop: 12, fontSize: 11.5, position: "relative" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderTop: "1px solid var(--field-border)" }}>
                    <span style={{ color: "var(--muted)" }}>
                      Šance zabít alespoň 1 model <i style={{ opacity: 0.65 }}>(odhad)</i>
                    </span>
                    <b>{pct(chanceAtLeast1)}</b>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderTop: "1px solid var(--field-border)" }}>
                    <span style={{ color: "var(--muted)" }}>
                      Šance zničit celou jednotku <i style={{ opacity: 0.65 }}>(odhad)</i>
                    </span>
                    <b>{pct(chanceDestroyUnit)}</b>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderTop: "1px solid var(--field-border)" }}>
                    <span style={{ color: "var(--muted)" }}>
                      Šance, že jednotka přežije (aspoň 1 model) <i style={{ opacity: 0.65 }}>(odhad)</i>
                    </span>
                    <b style={{ color: "var(--accent-text)" }}>{pct(1 - chanceDestroyUnit)}</b>
                  </div>
                </div>
              </div>

              {resultAgg &&
                (defenderFnp.ranged > 0 ||
                  defenderFnp.melee > 0 ||
                  defenderDamageReduction.ranged > 0 ||
                  defenderDamageReduction.melee > 0 ||
                  resultAgg.ranged.fnpSaved > 0 ||
                  resultAgg.melee.fnpSaved > 0) && (
                <div style={{ background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 12, padding: 14, marginTop: 12 }}>
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>
                    Odečteno obranou obránce
                  </div>
                  {(defenderFnp.ranged > 0 || defenderDamageReduction.ranged > 0 || resultAgg.ranged.fnpSaved > 0) && (
                    <div style={{ marginBottom: 6 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "#a9c6e5", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2, display: "flex", alignItems: "center", gap: 4 }}>
                        <Crosshair size={11} /> Na dálku
                      </div>
                      {resultAgg.ranged.fnpSaved > 0 && (
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "2px 0" }}>
                          <span style={{ color: "var(--muted)" }}>
                            FNP zachránilo{defenderUnit.psychicFnp > 0 ? " (vč. FNP proti Psychic)" : ""}
                          </span>
                          <span style={{ fontFamily: "var(--mono)", fontWeight: 700 }}>{fmt(resultAgg.ranged.fnpSaved, 2)} dmg</span>
                        </div>
                      )}
                      {defenderDamageReduction.ranged > 0 && (
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "2px 0" }}>
                          <span style={{ color: "var(--muted)" }}>Redukce -{defenderDamageReduction.ranged} Dmg ubrala</span>
                          <span style={{ fontFamily: "var(--mono)", fontWeight: 700 }}>{fmt(resultAgg.ranged.reductionSaved, 2)} dmg</span>
                        </div>
                      )}
                    </div>
                  )}
                  {(defenderFnp.melee > 0 || defenderDamageReduction.melee > 0 || resultAgg.melee.fnpSaved > 0) && (
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "var(--accent-text)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2, display: "flex", alignItems: "center", gap: 4 }}>
                        <Sword size={11} /> Na blízko
                      </div>
                      {resultAgg.melee.fnpSaved > 0 && (
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "2px 0" }}>
                          <span style={{ color: "var(--muted)" }}>
                            FNP zachránilo{defenderUnit.psychicFnp > 0 ? " (vč. FNP proti Psychic)" : ""}
                          </span>
                          <span style={{ fontFamily: "var(--mono)", fontWeight: 700 }}>{fmt(resultAgg.melee.fnpSaved, 2)} dmg</span>
                        </div>
                      )}
                      {defenderDamageReduction.melee > 0 && (
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "2px 0" }}>
                          <span style={{ color: "var(--muted)" }}>Redukce -{defenderDamageReduction.melee} Dmg ubrala</span>
                          <span style={{ fontFamily: "var(--mono)", fontWeight: 700 }}>{fmt(resultAgg.melee.reductionSaved, 2)} dmg</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div style={{ background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 12, padding: 14, marginTop: 12 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4 }}>Rozpis poškození</div>
                {resultAgg && (
                  <>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "#a9c6e5", textTransform: "uppercase", letterSpacing: 0.5, margin: "8px 0 2px", display: "flex", alignItems: "center", gap: 4 }}>
                      <Crosshair size={11} /> Na dálku
                    </div>
                    {[
                      ["Útoky", fmt(resultAgg.ranged.attacks, 1)],
                      ["Zásahy", fmt(resultAgg.ranged.hits, 2)],
                      ["Zranění", fmt(resultAgg.ranged.wounds, 2)],
                      ["Neúspěšné save", fmt(resultAgg.ranged.through, 2)],
                      ["Damage", fmt(resultAgg.ranged.damage, 2)],
                    ].map(([label, val]) => (
                      <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderTop: "1px solid var(--field-border)", fontSize: 12.5 }}>
                        <span style={{ color: "var(--muted)" }}>{label}</span>
                        <span style={{ fontFamily: "var(--mono)", fontWeight: 700 }}>{val}</span>
                      </div>
                    ))}

                    <div style={{ fontSize: 10, fontWeight: 700, color: "var(--accent-text)", textTransform: "uppercase", letterSpacing: 0.5, margin: "12px 0 2px", display: "flex", alignItems: "center", gap: 4 }}>
                      <Sword size={11} /> Na blízko
                    </div>
                    {[
                      ["Útoky", fmt(resultAgg.melee.attacks, 1)],
                      ["Zásahy", fmt(resultAgg.melee.hits, 2)],
                      ["Zranění", fmt(resultAgg.melee.wounds, 2)],
                      ["Neúspěšné save", fmt(resultAgg.melee.through, 2)],
                      ["Damage", fmt(resultAgg.melee.damage, 2)],
                    ].map(([label, val]) => (
                      <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderTop: "1px solid var(--field-border)", fontSize: 12.5 }}>
                        <span style={{ color: "var(--muted)" }}>{label}</span>
                        <span style={{ fontFamily: "var(--mono)", fontWeight: 700 }}>{val}</span>
                      </div>
                    ))}
                  </>
                )}
              </div>

              <div style={{ display: "flex", gap: 16, marginTop: 12, flexWrap: "wrap" }}>
                <button onClick={() => setBreakdownOpen((o) => !o)} style={{ background: "transparent", border: "none", color: "var(--muted)", fontSize: 11.5, cursor: "pointer", padding: 0 }}>
                  {breakdownOpen ? "Skrýt" : "Zobrazit"} rozpis podle zbraní
                </button>
                <button onClick={() => setMethodologyOpen((o) => !o)} style={{ background: "transparent", border: "none", color: "var(--muted)", fontSize: 11.5, cursor: "pointer", padding: 0 }}>
                  {methodologyOpen ? "Skrýt" : "Jak se to počítá"}
                </button>
              </div>

              {breakdownOpen && (
                <div style={{ marginTop: 10, overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--mono)", fontSize: 10.5 }}>
                    <thead>
                      <tr style={{ color: "var(--muted)", textAlign: "left" }}>
                        <th style={{ padding: "4px 6px 4px 0", fontWeight: 600 }}>Model — zbraň</th>
                        <th style={{ padding: "4px 6px", fontWeight: 600 }}>Útoky</th>
                        <th style={{ padding: "4px 6px", fontWeight: 600 }}>Zásah</th>
                        <th style={{ padding: "4px 6px", fontWeight: 600 }}>Zranění</th>
                        <th style={{ padding: "4px 6px", fontWeight: 600 }}>Save</th>
                        <th style={{ padding: "4px 6px", fontWeight: 600 }}>Dmg</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.breakdown.map((b, i) =>
                        b.isMortalWounds ? (
                          <tr key={i} style={{ borderTop: "1px solid var(--field-border)", color: "var(--text)" }}>
                            <td style={{ padding: "4px 6px 4px 0" }}>
                              {b.type === "melee" ? "⚔" : "🎯"} {b.member} — {b.weapon}
                            </td>
                            <td style={{ padding: "4px 6px" }}>—</td>
                            <td style={{ padding: "4px 6px" }}>—</td>
                            <td style={{ padding: "4px 6px" }}>—</td>
                            <td style={{ padding: "4px 6px" }}>ignoruje save</td>
                            <td style={{ padding: "4px 6px", fontWeight: 700 }}>{fmt(b.damage)}</td>
                          </tr>
                        ) : (
                          <tr key={i} style={{ borderTop: "1px solid var(--field-border)", color: "var(--text)" }}>
                            <td style={{ padding: "4px 6px 4px 0" }}>
                              {b.type === "melee" ? "⚔" : "🎯"} {b.member} — {b.weapon}
                            </td>
                            <td style={{ padding: "4px 6px" }}>{fmt(b.detail.attacks, 1)}</td>
                            <td style={{ padding: "4px 6px" }}>
                              {b.detail.hitX <= 1 ? "auto" : b.detail.hitX + "+"} → {pct(b.detail.pHit)} ({fmt(b.detail.hitsTotal, 2)})
                              {b.detail.hitsFromRerollHit > 0.005 && (
                                <div style={{ fontSize: 9, color: "var(--accent-text)" }}>z toho přehoz: +{fmt(b.detail.hitsFromRerollHit, 2)}</div>
                              )}
                            </td>
                            <td style={{ padding: "4px 6px" }}>
                              {b.detail.woundNeed}+ → {pct(b.detail.pWound)} ({fmt(b.detail.woundsTotal, 2)})
                              {b.detail.woundDebuffApplied && <div style={{ fontSize: 9, color: "var(--amber)" }}>debuff -1 WR (S&gt;T)</div>}
                              {b.detail.woundsFromLethalHits > 0.005 && (
                                <div style={{ fontSize: 9, color: "var(--accent-text)" }}>z toho Lethal Hits: +{fmt(b.detail.woundsFromLethalHits, 2)}</div>
                              )}
                            </td>
                            <td style={{ padding: "4px 6px" }}>{b.detail.effSave >= 7 ? "neprojde" : b.detail.effSave + "+"}</td>
                            <td style={{ padding: "4px 6px", fontWeight: 700 }}>
                              {fmt(b.damage)}
                              {(b.detail.damageFromRerollHit > 0.005 || b.detail.damageFromLethalHits > 0.005) && (
                                <div style={{ fontSize: 9, fontWeight: 400, color: "var(--accent-text)" }}>
                                  {b.detail.damageFromRerollHit > 0.005 && <>přehoz: +{fmt(b.detail.damageFromRerollHit, 2)} </>}
                                  {b.detail.damageFromLethalHits > 0.005 && <>Lethal: +{fmt(b.detail.damageFromLethalHits, 2)}</>}
                                </div>
                              )}
                            </td>
                          </tr>
                        )
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {methodologyOpen && (
                <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--muted)", lineHeight: 1.75 }}>
                  <div>
                    <b style={{ color: "var(--text)" }}>1. Zásahy:</b> Útoky × pravděpodobnost zásahu, upravená přehozem. Kritický zásah = nehozená 6 (Sustained Hits přidá extra zásahy, Lethal Hits obchází hod na zranění).
                  </div>
                  <div>
                    <b style={{ color: "var(--text)" }}>2. Zranění:</b> Cíl na zranění dle S vs T tabulky, případný debuff -1 WR a modifikátory/přehoz.
                  </div>
                  <div>
                    <b style={{ color: "var(--text)" }}>3. Save:</b> Efektivní save = Save + |AP|, nebo lepší invulnerable.
                  </div>
                  <div>
                    <b style={{ color: "var(--text)" }}>4. FNP:</b> Hází se za každý bod damage po save.
                  </div>
                  <div>
                    <b style={{ color: "var(--text)" }}>5. Kills:</b> Damage / efektivní wounds na zabití (overkill se nepřelévá).
                  </div>
                  <div>
                    <b style={{ color: "var(--text)" }}>6. Šance (odhad):</b> Spočítá se, kolik hodů na zranění se celkem dostane až k save (M) a jaká je reálná šance neúspěchu jednoho z nich (q). Z toho se binomickým rozdělením spočítá šance, že padne dost neúspěšných save na zabití aspoň 1 modelu / celé jednotky.
                  </div>
                  <div style={{ fontStyle: "italic", marginTop: 4 }}>
                    Damage a kills jsou očekávaná (průměrná) hodnota. Šance "odhad" už počítají s rozptylem hodů kostkou (binomické rozdělení), ne jen s průměrem.
                  </div>
                </div>
              )}

              <button
                onClick={startNewCalculation}
                className="wh40k-btn"
                style={{ width: "100%", marginTop: 16, border: "none", background: "var(--accent)", color: "#fff", borderRadius: 8, padding: 12, fontSize: 13.5, fontWeight: 700, cursor: "pointer" }}
              >
                Nový výpočet
              </button>
            </div>
          )}
        </div>
      )}

      {/* LIBRARY */}
      {view === "library" && (
        <div className="no-print" style={{ padding: "4px 14px 16px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 10 }}>Knihovna</div>
          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            <button onClick={() => setLibraryTab("units")} style={tabBtnStyle(libraryTab === "units")}>
              Jednotky
            </button>
            <button onClick={() => setLibraryTab("weapons")} style={tabBtnStyle(libraryTab === "weapons")}>
              Zbraně
            </button>
          </div>

          {libraryTab === "units" && (
            <>
              <button
                onClick={() => setImportOpen((o) => !o)}
                className="wh40k-btn"
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  border: "1px solid var(--accent)",
                  background: "var(--accent-dim)",
                  color: "var(--accent-text)",
                  borderRadius: 8,
                  padding: "10px 12px",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: "pointer",
                  marginBottom: 10,
                }}
              >
                <Upload size={15} /> Nahrát novou armádu z New Recruit
              </button>
              {importOpen && <ImportBox onImport={importFromNewRecruit} />}

              <button onClick={() => setShareOpen((o) => !o)} style={{ ...dashedBtnStyle, width: "100%", justifyContent: "center", marginBottom: 10 }}>
                <Save size={14} /> Sdílet s kamarádem
              </button>
              {shareOpen && <ExportImportBox library={library} armies={armies} onImport={importUnitsAndArmies} />}

              <SearchBox value={librarySearch} onChange={setLibrarySearch} placeholder="Hledat jednotky…" />
              {library.length > 0 && (
                <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
                  <button
                    onClick={() => askConfirm("Opravdu smazat celou knihovnu jednotek? Nelze vrátit zpět.", clearLibrary)}
                    style={{ display: "flex", alignItems: "center", gap: 5, border: "1px solid var(--field-border)", background: "transparent", color: "var(--muted)", borderRadius: 6, padding: "4px 10px", fontSize: 11, cursor: "pointer" }}
                  >
                    <Trash2 size={11} /> Vymazat vše
                  </button>
                </div>
              )}
              {!loaded && <div style={{ fontSize: 12.5, color: "var(--muted)" }}>Načítám knihovnu…</div>}
              {loaded && library.length > 0 && filteredLibraryUnits.length === 0 && <div style={{ fontSize: 12.5, color: "var(--muted)" }}>Nic nenalezeno.</div>}
              {loaded &&
                filteredLibraryUnits.map((u) => (
                  <LibraryRow key={u.id} u={u} onEdit={() => setEditingUnit(u)} onDelete={() => deleteUnit(u.id)} onToggleFavorite={() => toggleFavorite(u.id)} />
                ))}

              {editingUnit ? (
                <UnitForm initial={editingUnit} onSave={saveUnit} onCancel={() => setEditingUnit(null)} />
              ) : (
                <button onClick={() => setEditingUnit(emptyUnit())} style={{ ...dashedBtnStyle, marginTop: 10 }}>
                  <Plus size={14} /> Přidat ručně
                </button>
              )}
            </>
          )}

          {libraryTab === "weapons" && (
            <>
              <SearchBox value={librarySearch} onChange={setLibrarySearch} placeholder="Hledat zbraně…" />
              {filteredWeapons.length === 0 && <div style={{ fontSize: 12.5, color: "var(--muted)" }}>Žádné zbraně v knihovně.</div>}
              {filteredWeapons.map((w, i) => (
                <div key={i} style={{ background: "var(--field-bg)", border: "1px solid var(--field-border)", borderRadius: 8, padding: "8px 10px", marginBottom: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600, marginBottom: 5 }}>
                    {w.type === "melee" ? <Sword size={12} color="var(--accent-text)" /> : <Crosshair size={12} color="#a9c6e5" />} {w.name}
                    <span style={{ fontSize: 10, color: "var(--muted)", fontWeight: 400 }}>· {w.unitName}</span>
                  </div>
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                    <StatChip label="Atk" value={fmtNum(w.attacks)} />
                    <StatChip label="Hit" value={w.hitX <= 1 ? "auto" : w.hitX + "+"} />
                    <StatChip label="Str" value={w.strength} />
                    <StatChip label="AP" value={w.ap} />
                    <StatChip label="Dmg" value={fmtNum(w.damage)} />
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* HISTORY */}
      {view === "history" && (
        <div className="no-print" style={{ padding: "4px 14px 16px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6 }}>Historie výpočtů</div>
            {history.length > 0 && (
              <button
                onClick={() => askConfirm("Smazat celou historii výpočtů?", clearHistory)}
                style={{ background: "transparent", border: "none", color: "var(--muted)", fontSize: 11, cursor: "pointer" }}
              >
                Vymazat vše
              </button>
            )}
          </div>
          {!historyLoaded && <div style={{ fontSize: 12.5, color: "var(--muted)" }}>Načítám…</div>}
          {historyLoaded && history.length === 0 && (
            <div style={{ fontSize: 12.5, color: "var(--muted)", background: "var(--field-bg)", border: "1px dashed var(--field-border)", borderRadius: 8, padding: 14 }}>
              Zatím žádné uložené výpočty.
            </div>
          )}
          {history.map((h) => {
            const isOpen = expandedHistoryId === h.id;
            return (
              <div key={h.id} style={{ background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 10, padding: "10px 12px", marginBottom: 8 }}>
                <div
                  onClick={() => setExpandedHistoryId(isOpen ? null : h.id)}
                  role="button"
                  tabIndex={0}
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, cursor: "pointer" }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {h.attackerName} → {h.defenderName}
                    </div>
                    <div style={{ fontSize: 10.5, color: "var(--muted)" }}>{fmtDate(h.date)}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 15, fontWeight: 700, color: "var(--accent-text)", fontFamily: "var(--mono)" }}>{fmt(h.killedModels)}</div>
                      <div style={{ fontSize: 9, color: "var(--muted)" }}>modelů</div>
                    </div>
                    <ChevronDown size={14} color="var(--muted)" style={{ transform: isOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteHistoryEntry(h.id);
                      }}
                      style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer", padding: 4 }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>

                {isOpen && (
                  <div style={{ marginTop: 10, borderTop: "1px solid var(--field-border)", paddingTop: 10 }}>
                    <pre
                      style={{
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        fontFamily: "var(--mono)",
                        fontSize: 11.5,
                        color: "var(--text)",
                        background: "var(--field-bg)",
                        border: "1px solid var(--field-border)",
                        borderRadius: 8,
                        padding: 10,
                        margin: 0,
                      }}
                    >
                      {historyEntryText(h)}
                    </pre>
                    <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                      <button
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(historyEntryText(h));
                            setCopiedHistoryId(h.id);
                            setTimeout(() => setCopiedHistoryId((id) => (id === h.id ? null : id)), 2000);
                          } catch (e) {
                            // clipboard unavailable — text is still visible above to select manually
                          }
                        }}
                        className="wh40k-btn"
                        style={{ border: "1px solid var(--field-border)", background: "transparent", color: "var(--text)", borderRadius: 6, padding: "6px 12px", fontSize: 12, cursor: "pointer" }}
                      >
                        {copiedHistoryId === h.id ? "Zkopírováno ✓" : "Kopírovat"}
                      </button>
                      <button
                        onClick={() => {
                          if (!reopenHistoryEntry(h)) {
                            setAlertMessage("Jedna z jednotek už není v knihovně, takže tenhle výpočet nejde znovu otevřít k úpravě.");
                          }
                        }}
                        className="wh40k-btn"
                        style={{ border: "none", background: "var(--accent)", color: "#fff", borderRadius: 6, padding: "6px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
                      >
                        Upravit
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* MANUAL */}
      {view === "manual" && <ManualView onBack={() => setView("home")} />}

      {/* LISTS (armies + cheat sheet) */}
      {view === "lists" && (
        <div className="no-print" style={{ padding: "4px 14px 16px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 10 }}>Moje armády</div>
          {!armiesLoaded && <div style={{ fontSize: 12.5, color: "var(--muted)" }}>Načítám armády…</div>}
          {armiesLoaded && armies.length === 0 && <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 10 }}>Zatím žádné uložené armády.</div>}
          {armiesLoaded &&
            armies.map((a) => (
              <div key={a.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 8px", borderRadius: 6, fontSize: 13 }}>
                <span>
                  {a.name} <span style={{ fontSize: 11, color: "var(--muted)" }}>({a.unitIds.length} jednotek)</span>
                </span>
                <span style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
                  <button
                    onClick={() => setCheatAttackerIds(new Set(a.unitIds))}
                    title="Do cheat sheetu jako útočník"
                    style={{ display: "flex", alignItems: "center", gap: 4, border: "1px solid var(--accent)", background: "transparent", color: "var(--accent-text)", borderRadius: 6, padding: "3px 8px", fontSize: 11, cursor: "pointer" }}
                  >
                    <Sword size={11} /> Útočník
                  </button>
                  <button
                    onClick={() => setCheatTargetIds(new Set(a.unitIds))}
                    title="Do cheat sheetu jako obránce"
                    style={{ display: "flex", alignItems: "center", gap: 4, border: "1px solid var(--blue)", background: "transparent", color: "#a9c6e5", borderRadius: 6, padding: "3px 8px", fontSize: 11, cursor: "pointer" }}
                  >
                    <Shield size={11} /> Obránce
                  </button>
                  <button onClick={() => setEditingArmy(a)} aria-label="Upravit" style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer", padding: 4 }}>
                    <Pencil size={14} />
                  </button>
                  <button onClick={() => deleteArmy(a.id)} aria-label="Smazat" style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer", padding: 4 }}>
                    <Trash2 size={14} />
                  </button>
                </span>
              </div>
            ))}

          {editingArmy ? (
            <ArmyForm initial={editingArmy} groupedLibrary={groupedLibrary} onSave={saveArmy} onCancel={() => setEditingArmy(null)} />
          ) : (
            <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
              <button onClick={() => setEditingArmy({ id: crypto.randomUUID(), name: "", unitIds: [] })} style={dashedBtnStyle} disabled={library.length === 0}>
                <FolderPlus size={14} /> Uložit novou armádu
              </button>
              <button onClick={() => setTextArmyOpen((o) => !o)} style={dashedBtnStyle} disabled={library.length === 0}>
                <Upload size={14} /> Armáda z textu (New Recruit)
              </button>
            </div>
          )}
          {library.length === 0 && <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 6 }}>Nejdřív přidej jednotky do knihovny.</div>}
          {!editingArmy && textArmyOpen && <ArmyTextMatchBox onMatch={importArmyFromText} />}

          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6, margin: "22px 0 10px" }}>Cheat sheet pro tisk</div>
          <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 10 }}>
            Zaškrtni útočníky a očekávané protivníky. Damage se počítá s plným počtem modelů a vestavěnými schopnostmi zbraní.
          </div>

          <button
            onClick={() => setCheatModifiersOpen((o) => !o)}
            style={{ display: "flex", alignItems: "center", gap: 4, background: "transparent", border: "none", color: "var(--accent-text)", fontSize: 11.5, fontWeight: 700, cursor: "pointer", padding: 0, marginBottom: 10, textTransform: "uppercase", letterSpacing: 0.4 }}
          >
            <Plus size={12} /> Modifikátory (volitelné)
            <ChevronDown size={12} style={{ transform: cheatModifiersOpen ? "rotate(180deg)" : "none" }} />
          </button>
          {cheatModifiersOpen && (
          <>
            <CheatSlotPanel title="Bonusy útočníka" hint="navíc k vlastním schopnostem, drží se armády i po prohození" accent="var(--accent-text)" slot={cheatSlotA} setSlot={setCheatSlotA} />
            <CheatSlotPanel title="Debuffy obránce" hint="navíc k vlastním hodnotám, drží se armády i po prohození" accent="var(--accent-text)" slot={cheatSlotB} setSlot={setCheatSlotB} />
            <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: -6, marginBottom: 14 }}>
              Tabulka níže vždy ukáže obojí: "Základ" (jen vestavěné schopnosti) a "S bonusy" (základ + tohle nastavení), ať je vidět rozdíl.
            </div>
          </>
          )}
          {(cheatAttackerIds.size === 0 || cheatTargetIds.size === 0) && (
            <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 14 }}>Zaškrtni aspoň jednu jednotku na obou stranách, ať se má co vygenerovat.</div>
          )}
        </div>
      )}

      {/* Printable result matrix sits right after the modifiers panel (not
          after the unit checklists below) so it's reachable without much
          scrolling — kept as its own top-level block (not nested inside the
          .no-print wrapper above/below) since a display:none ancestor would
          hide it from printing even with its own display override. */}
      {view === "lists" && cheatMatrix.length > 0 && cheatMatrix[0].cells.length > 0 && (
        <div className="print-area" style={{ margin: "0 14px 16px", overflowX: "auto", background: "#fff", borderRadius: 8, padding: 12 }}>
          <button
            onClick={() => window.print()}
            className="wh40k-btn no-print"
            style={{ display: "flex", alignItems: "center", gap: 6, border: "none", background: "var(--accent)", color: "#fff", borderRadius: 6, padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer", marginBottom: 10 }}
          >
            Vytisknout cheat sheet
          </button>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#111", marginBottom: 2 }}>BATTLECALC — Cheat Sheet: damage na jedno kolo útoku</div>
          <div style={{ fontSize: 9.5, color: "#777", marginBottom: 8 }}>
            Každá buňka: 4 lebky = % zničené jednotky. Horní řádek <b>S</b> = na dálku (Shoot), dolní řádek <b>M</b> = na blízko (Melee). V obou řádcích: <span style={{ color: "#999" }}>šedá</span> = Základ (jen vestavěné schopnosti), <span style={{ color: "#1b5faa" }}>modrá</span> = S bonusy (základ + nastavené bonusy/debuffy).
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, color: "#111" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "4px 6px", border: "1px solid #ccc", background: "#f0f0f0" }}>Útočník \ Cíl</th>
                {cheatMatrix[0].cells.map((c) => (
                  <th key={c.target.id} style={{ textAlign: "center", padding: "4px 6px", border: "1px solid #ccc", background: "#f0f0f0" }}>
                    {c.target.name}
                    <div style={{ fontWeight: 400, fontSize: 8.5, color: "#555" }}>
                      T{c.target.toughness} Sv{c.target.save}+{c.target.invul > 0 ? " Inv" + c.target.invul + "+" : ""} W{c.target.wounds} ({totalModels(c.target)}x)
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cheatMatrix.map((row) => (
                <tr key={row.attacker.id}>
                  <td style={{ padding: "4px 6px", border: "1px solid #ccc", fontWeight: 700 }}>{row.attacker.name}</td>
                  {row.cells.map((c) => {
                    const targetModels = totalModels(c.target) || 1;
                    const rangedBaseFrac = killedModelsByType(c.base.res, "ranged") / targetModels;
                    const rangedBoostedFrac = killedModelsByType(c.boosted.res, "ranged") / targetModels;
                    const meleeBaseFrac = killedModelsByType(c.base.res, "melee") / targetModels;
                    const meleeBoostedFrac = killedModelsByType(c.boosted.res, "melee") / targetModels;
                    const cell = (frac, color, trackColor) => (
                      <div style={{ textAlign: "center" }}>
                        <MiniSkullPie frac={frac} size={16} color={color} trackColor={trackColor} />
                        <div style={{ fontSize: 6.5, color, fontWeight: 600 }}>{(frac * 100).toFixed(0)}%</div>
                      </div>
                    );
                    return (
                      <td key={c.target.id} style={{ padding: "3px 4px", border: "1px solid #ccc", textAlign: "center" }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: 3, alignItems: "center" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                            <span style={{ fontSize: 6.5, color: "#999", width: 8 }}>S</span>
                            {cell(rangedBaseFrac, "#666", "#e6e6e6")}
                            {cell(rangedBoostedFrac, "#1b5faa", "#dbe8f5")}
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                            <span style={{ fontSize: 6.5, color: "#999", width: 8 }}>M</span>
                            {cell(meleeBaseFrac, "#666", "#e6e6e6")}
                            {cell(meleeBoostedFrac, "#1b5faa", "#dbe8f5")}
                          </div>
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {view === "lists" && (
        <div className="no-print" style={{ padding: "4px 14px 16px" }}>
          {(cheatAttackerIds.size > 0 || cheatTargetIds.size > 0) && (
            <button
              onClick={swapCheatAttackersAndTargets}
              className="wh40k-btn"
              style={{ display: "flex", alignItems: "center", gap: 6, border: "1px solid var(--field-border)", background: "var(--field-bg)", color: "var(--text)", borderRadius: 6, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", marginBottom: 10 }}
            >
              <ArrowLeftRight size={13} /> Prohodit útočníky a cíle
            </button>
          )}

          <div className="wh40k-grid-2" style={{ marginBottom: 14 }}>
            <div style={{ background: "var(--panel)", border: "1px solid var(--accent)", borderRadius: 10, padding: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--accent-text)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>Útočníci</div>
              {armies.length > 0 && (
                <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
                  <select
                    id="army-select-att"
                    className="wh40k-select"
                    style={{ flex: 1, background: "var(--field-bg)", border: "1px solid var(--field-border)", borderRadius: 6, color: "var(--text)", padding: "5px 6px", fontSize: 11 }}
                    defaultValue=""
                  >
                    <option value="" disabled>
                      Zaškrtnout celou armádu…
                    </option>
                    {armies.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.unitIds.length}x)
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => {
                      const el = document.getElementById("army-select-att");
                      if (el && el.value) addArmyToAttackers(el.value);
                    }}
                    title="Zaškrtnout celou vybranou armádu"
                    style={{ display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "1px solid var(--accent)", background: "transparent", color: "var(--accent-text)", borderRadius: 6, width: 26, height: 26, cursor: "pointer" }}
                  >
                    <Plus size={13} />
                  </button>
                </div>
              )}
              {cheatAttackerIds.size > 0 && (
                <button onClick={() => setCheatAttackerIds(new Set())} style={{ background: "transparent", border: "none", color: "var(--muted)", fontSize: 10.5, cursor: "pointer", padding: 0, marginBottom: 6 }}>
                  Vyčistit výběr ({cheatAttackerIds.size})
                </button>
              )}
              {Object.entries(groupedLibrary).map(([faction, units]) => (
                <div key={faction} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "var(--amber)", textTransform: "uppercase", marginBottom: 3 }}>{faction}</div>
                  {units.map((u) => (
                    <label key={u.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, padding: "2px 0", cursor: "pointer" }}>
                      <input type="checkbox" checked={cheatAttackerIds.has(u.id)} onChange={() => toggleCheatAttacker(u.id)} />
                      {u.name}
                    </label>
                  ))}
                </div>
              ))}
              {library.length === 0 && <div style={{ fontSize: 12, color: "var(--muted)" }}>Knihovna je prázdná.</div>}
            </div>

            <div style={{ background: "var(--panel)", border: "1px solid var(--blue)", borderRadius: 10, padding: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#a9c6e5", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>Cíle</div>
              {armies.length > 0 && (
                <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
                  <select
                    id="army-select-tgt"
                    className="wh40k-select"
                    style={{ flex: 1, background: "var(--field-bg)", border: "1px solid var(--field-border)", borderRadius: 6, color: "var(--text)", padding: "5px 6px", fontSize: 11 }}
                    defaultValue=""
                  >
                    <option value="" disabled>
                      Zaškrtnout celou armádu…
                    </option>
                    {armies.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.unitIds.length}x)
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => {
                      const el = document.getElementById("army-select-tgt");
                      if (el && el.value) addArmyToTargets(el.value);
                    }}
                    title="Zaškrtnout celou vybranou armádu"
                    style={{ display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "1px solid var(--blue)", background: "transparent", color: "#a9c6e5", borderRadius: 6, width: 26, height: 26, cursor: "pointer" }}
                  >
                    <Plus size={13} />
                  </button>
                </div>
              )}
              {cheatTargetIds.size > 0 && (
                <button onClick={() => setCheatTargetIds(new Set())} style={{ background: "transparent", border: "none", color: "var(--muted)", fontSize: 10.5, cursor: "pointer", padding: 0, marginBottom: 6 }}>
                  Vyčistit výběr ({cheatTargetIds.size})
                </button>
              )}
              {Object.entries(groupedLibrary).map(([faction, units]) => (
                <div key={faction} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "var(--amber)", textTransform: "uppercase", marginBottom: 3 }}>{faction}</div>
                  {units.map((u) => (
                    <label key={u.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, padding: "2px 0", cursor: "pointer" }}>
                      <input type="checkbox" checked={cheatTargetIds.has(u.id)} onChange={() => toggleCheatTarget(u.id)} />
                      {u.name}
                    </label>
                  ))}
                </div>
              ))}
              {library.length === 0 && <div style={{ fontSize: 12, color: "var(--muted)" }}>Knihovna je prázdná.</div>}
            </div>
          </div>
        </div>
      )}

      {view === "board" && (
        <div className="no-print" style={{ padding: "4px 14px 16px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--label)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 10 }}>Deska</div>
          <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 10, lineHeight: 1.5 }}>
            Zaškrtni jednotky z knihovny do své strany nebo strany protihráče — objeví se jako token na desce, který přetáhneš na místo. Dvojklik na token ho odebere.
          </div>

          <Row cols={3}>
            <NumberField label="Šířka desky (in)" value={board.widthIn} onChange={(v) => setBoardSize(Math.max(1, v), board.heightIn)} min={1} small />
            <NumberField label="Výška desky (in)" value={board.heightIn} onChange={(v) => setBoardSize(board.widthIn, Math.max(1, v))} min={1} small />
            <div style={{ display: "flex", alignItems: "flex-end" }}>
              <button
                onClick={clearBoardTokens}
                disabled={board.tokens.length === 0}
                style={{
                  width: "100%",
                  border: "1px solid var(--field-border)",
                  background: "transparent",
                  color: board.tokens.length === 0 ? "var(--muted)" : "var(--text)",
                  borderRadius: 6,
                  padding: "6px 9px",
                  fontSize: 12,
                  cursor: board.tokens.length === 0 ? "not-allowed" : "pointer",
                }}
              >
                Vyčistit desku
              </button>
            </div>
          </Row>

          <div className="wh40k-vs-columns" style={{ marginTop: 10, marginBottom: 12 }}>
            <div style={{ background: "var(--panel)", border: "1px solid var(--accent)", borderRadius: 10, padding: 12, maxHeight: 220, overflowY: "auto" }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--accent-text)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8, position: "sticky", top: 0, background: "var(--panel)" }}>
                Moje jednotky
              </div>
              {Object.entries(groupedLibrary).map(([faction, units]) => (
                <div key={faction} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 9.5, fontWeight: 700, color: "var(--amber)", textTransform: "uppercase", marginBottom: 3 }}>{faction}</div>
                  {units.map((u) => (
                    <label key={u.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, padding: "2px 0", cursor: "pointer" }}>
                      <input type="checkbox" checked={board.tokens.some((t) => t.unitId === u.id && t.side === "mine")} onChange={() => toggleUnitOnBoard(u.id, "mine")} />
                      {u.name}
                    </label>
                  ))}
                </div>
              ))}
              {library.length === 0 && <div style={{ fontSize: 12, color: "var(--muted)" }}>Knihovna je prázdná.</div>}
            </div>
            <div style={{ background: "var(--panel)", border: "1px solid #c0392b", borderRadius: 10, padding: 12, maxHeight: 220, overflowY: "auto" }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: "#e0857c", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8, position: "sticky", top: 0, background: "var(--panel)" }}>
                Jednotky protihráče
              </div>
              {Object.entries(groupedLibrary).map(([faction, units]) => (
                <div key={faction} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 9.5, fontWeight: 700, color: "var(--amber)", textTransform: "uppercase", marginBottom: 3 }}>{faction}</div>
                  {units.map((u) => (
                    <label key={u.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, padding: "2px 0", cursor: "pointer" }}>
                      <input type="checkbox" checked={board.tokens.some((t) => t.unitId === u.id && t.side === "theirs")} onChange={() => toggleUnitOnBoard(u.id, "theirs")} />
                      {u.name}
                    </label>
                  ))}
                </div>
              ))}
              {library.length === 0 && <div style={{ fontSize: 12, color: "var(--muted)" }}>Knihovna je prázdná.</div>}
            </div>
          </div>

          <div
            ref={boardContainerRef}
            style={{
              position: "relative",
              width: "100%",
              // Cap how tall a portrait-shaped board (e.g. 44x60") can render
              // — without this, "width: 100%" alone forces the height to
              // whatever the aspect ratio demands, which can run to way more
              // than a screen's height and turn the page into an endless
              // scroll. 68vh keeps the whole board on screen on most
              // displays; the aspect-ratio then also caps the width so it
              // never overflows the column horizontally either.
              maxWidth: `calc(68vh * ${board.widthIn} / ${board.heightIn})`,
              aspectRatio: `${board.widthIn} / ${board.heightIn}`,
              margin: "0 auto",
              background: "#2b3a2e",
              border: "2px solid var(--field-border)",
              borderRadius: 8,
              overflow: "hidden",
              touchAction: "none",
            }}
          >
            {/* Just a directional tint (my side / their side) — not any official deployment-zone shape. */}
            <div
              style={{
                position: "absolute",
                inset: 0,
                background:
                  "linear-gradient(to bottom, rgba(47,143,232,0.16) 0%, rgba(47,143,232,0.16) 38%, transparent 38%, transparent 62%, rgba(192,57,43,0.16) 62%, rgba(192,57,43,0.16) 100%)",
                pointerEvents: "none",
              }}
            />
            {board.tokens.map((t) => {
              const unit = library.find((u) => u.id === t.unitId);
              const baseSizeIn = (unit ? unit.baseSize || 32 : 32) / 25.4;
              const sizePctW = Math.max(1.2, (baseSizeIn / board.widthIn) * 100);
              const sizePctH = Math.max(1.2, (baseSizeIn / board.heightIn) * 100);
              return (
                <BoardTokenView
                  key={t.id}
                  token={t}
                  unit={unit}
                  containerRef={boardContainerRef}
                  sizePctW={sizePctW}
                  sizePctH={sizePctH}
                  onMove={moveBoardToken}
                  onCommit={commitBoardTokenMove}
                  onRemove={removeBoardToken}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* BOTTOM NAV */}
      <div className="no-print" style={{ position: "absolute", bottom: 0, left: 0, right: 0, display: "flex", borderTop: "1px solid var(--field-border)", background: "rgba(8,14,23,0.97)", backdropFilter: "blur(8px)" }}>
        {[
          ["home", Home, "Domů"],
          ["calculator", Crosshair, "Kalkulačka"],
          ["board", MapIcon, "Deska"],
          ["library", SkullIcon, "Knihovna"],
          ["history", Clock, "Historie"],
          ["lists", List, "Cheat sheet"],
        ].map(([key, Icon, label]) => (
          <button
            key={key}
            onClick={() => setView(key)}
            style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "9px 0 10px", background: "transparent", border: "none", cursor: "pointer", color: view === key ? "var(--accent-text)" : "var(--muted)" }}
          >
            <Icon size={17} />
            <span style={{ fontSize: 8.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</span>
          </button>
        ))}
      </div>

      {/* Custom confirm/alert dialogs — replace window.confirm/alert, which can be
          unreliable inside a sandboxed artifact iframe. */}
      {(confirmDialog || alertMessage) && (
        <div
          className="no-print"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
            padding: 20,
          }}
        >
          <div style={{ background: "var(--panel)", border: "1px solid var(--field-border)", borderRadius: 12, padding: 18, maxWidth: 320, boxShadow: "0 12px 32px rgba(0,0,0,0.5)" }}>
            <div style={{ fontSize: 13.5, color: "var(--text)", marginBottom: 16, lineHeight: 1.5 }}>{confirmDialog ? confirmDialog.message : alertMessage}</div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              {confirmDialog && (
                <button
                  onClick={() => setConfirmDialog(null)}
                  style={{ border: "1px solid var(--field-border)", background: "transparent", color: "var(--text)", borderRadius: 6, padding: "7px 14px", fontSize: 13, cursor: "pointer" }}
                >
                  Zrušit
                </button>
              )}
              <button
                onClick={() => {
                  if (confirmDialog) confirmDialog.onConfirm();
                  setConfirmDialog(null);
                  setAlertMessage(null);
                }}
                className="wh40k-btn"
                style={{ border: "none", background: confirmDialog ? "#c0413a" : "var(--accent)", color: "#fff", borderRadius: 6, padding: "7px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}
              >
                {confirmDialog ? "Ano, smazat" : "OK"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
