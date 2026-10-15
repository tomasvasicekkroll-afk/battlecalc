// Edition-specific rule switches for the damage calculation.
//
// Everything that differs between 10th and 11th edition lives here as data, so
// a correction after reading the official core rules is a one-line change and
// the maths in App.jsx (computeWeapon) stays free of "if edition" branches.
// Only differences that change expected damage are modelled; everything that
// is the same in both editions (hit/wound tables, Sustained Hits, Anti-X,
// Torrent, Rapid Fire, FNP, ...) is not listed.
//
// Sources for the 11th edition column are secondary summaries (Wahapedia 11e
// core rules, Bell of Lost Souls, Tabletop Battles, UnitCrunch changelog 1.3.0)
// - verify against the official PDF; entries marked `verify` are the least certain.
import { createContext, useContext } from "react";

export const RULESETS = {
  "10": {
    id: "10",
    label: "10. edice",
    // Benefit of Cover: +1 to the armour save (not for Sv 3+ or better against AP 0).
    coverMode: "save",
    // Lethal Hits always auto-wound a critical hit.
    lethalHitsOptional: false,
    // Damage from Devastating Wounds is applied as mortal wounds, which carry
    // over to the next model.
    devastatingSpill: true,
    // Fire Overwatch hits only on an unmodified 6; re-rolls still work.
    overwatchRerolls: true,
  },
  "11": {
    id: "11",
    label: "11. edice",
    // Cover became -1 to the attacker's hit roll against ranged attacks.
    coverMode: "hit",
    // Lethal Hits is optional: the attacker may roll to wound normally, which
    // is the only way a hit can become a Critical Wound for Devastating Wounds
    // (auto-wounds are not Critical Wounds).
    lethalHitsOptional: true,
    // Wahapedia 11e worked example: a Critical Wound with Damage 3 against
    // 2-wound models destroys one model and the third mortal wound is lost.
    // (verify)
    devastatingSpill: false,
    // Fire Overwatch uses Snap Shooting: only unmodified 6s hit, and re-rolls
    // are disabled. (verify)
    overwatchRerolls: false,
  },
};

export const DEFAULT_EDITION = "11";

export function normalizeEdition(v) {
  return v === "10" || v === "11" ? v : DEFAULT_EDITION;
}

// Lets any component read the active ruleset (for labels and hints) without
// threading it through every prop list.
export const RulesContext = createContext(RULESETS[DEFAULT_EDITION]);
export const useRules = () => useContext(RulesContext);
