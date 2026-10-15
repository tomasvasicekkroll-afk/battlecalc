import { describe, it, expect } from "vitest";
import { computeWeapon, computeUnitVsUnit, defenderProfile, emptyBonus, emptyWeapon } from "../../App.jsx";
import { RULESETS, normalizeEdition } from "../rules.js";
import { runMonteCarlo } from "../montecarlo.js";

const R10 = RULESETS["10"];
const R11 = RULESETS["11"];
const def = (o = {}, unit = {}) =>
  defenderProfile({ toughness: 4, save: 4, invul: 0, wounds: 2, fnp: 0, keywords: {}, ...unit }, { models: 10, ...o });
const wp = (o = {}) => ({ ...emptyWeapon(), attacks: 10, hitX: 3, strength: 4, ap: 0, damage: 1, ...o });

describe("edition rules", () => {
  it("normalizes unknown editions to the default", () => {
    expect(normalizeEdition("10")).toBe("10");
    expect(normalizeEdition("9")).toBe("11");
    expect(normalizeEdition(null)).toBe("11");
  });

  it("11th: cover is -1 to hit, the save is untouched", () => {
    const base = computeWeapon(wp(), 1, def(), emptyBonus(), R11).detail;
    const cover = computeWeapon(wp(), 1, def({ benefitOfCover: true }), emptyBonus(), R11).detail;
    expect(cover.hitX).toBe(base.hitX + 1);
    expect(cover.effSave).toBe(base.effSave);
  });

  it("10th: cover is +1 to the armour save, the hit roll is untouched", () => {
    const base = computeWeapon(wp({ ap: -1 }), 1, def(), emptyBonus(), R10).detail;
    const cover = computeWeapon(wp({ ap: -1 }), 1, def({ benefitOfCover: true }), emptyBonus(), R10).detail;
    expect(cover.hitX).toBe(base.hitX);
    expect(cover.effSave).toBe(base.effSave - 1);
  });

  it("10th: Sv 3+ or better gets no cover against AP 0, but does against AP -1", () => {
    const d = def({ benefitOfCover: true }, { save: 3 });
    expect(computeWeapon(wp({ ap: 0 }), 1, d, emptyBonus(), R10).detail.effSave).toBe(3);
    expect(computeWeapon(wp({ ap: -1 }), 1, d, emptyBonus(), R10).detail.effSave).toBe(3); // 3+1-1
  });

  it("10th: cover never improves an invulnerable save", () => {
    const d = def({ benefitOfCover: true }, { save: 6, invul: 4 });
    expect(computeWeapon(wp({ ap: -2 }), 1, d, emptyBonus(), R10).detail.effSave).toBe(4);
  });

  it("11th: with Lethal + Devastating the better option is chosen", () => {
    const w = wp({ attacks: 30, hitX: 2, lethalHits: true, devastatingWounds: true, strength: 4, ap: -3, damage: 3 });
    const r11 = computeWeapon(w, 1, def({}, { toughness: 4, save: 3 }), emptyBonus(), R11);
    const noLethal = computeWeapon({ ...w, lethalHits: false }, 1, def({}, { toughness: 4, save: 3 }), emptyBonus(), R11, true);
    const lethalOnly = computeWeapon(w, 1, def({}, { toughness: 4, save: 3 }), emptyBonus(), R11, true);
    expect(r11.totalDamage).toBeCloseTo(Math.max(noLethal.totalDamage, lethalOnly.totalDamage), 9);
    expect(["auto-wound", "wound-roll"]).toContain(r11.lethalChoice);
  });

  it("10th: Lethal Hits stay forced (no choice)", () => {
    const w = wp({ lethalHits: true, devastatingWounds: true });
    expect(computeWeapon(w, 1, def(), emptyBonus(), R10).lethalChoice).toBeUndefined();
  });

  it("11th Fire Overwatch ignores hit re-rolls, 10th keeps them", () => {
    const w = wp({ rerollHit: "all" });
    const b = { ...emptyBonus(), fireOverwatch: true };
    const d10 = computeWeapon(w, 1, def(), b, R10).detail;
    const d11 = computeWeapon(w, 1, def(), b, R11).detail;
    expect(d10.pHit).toBeCloseTo(1 - (5 / 6) ** 2, 9);
    expect(d11.pHit).toBeCloseTo(1 / 6, 9);
  });

  it("Devastating Wounds: overflow is lost in 11th, carries over in 10th (simulation)", async () => {
    // one crit wound of damage 3 against 2-wound models
    const w = wp({ attacks: 1, hitX: 1, strength: 8, damage: 3, devastatingWounds: true, critWoundOn: 2 });
    const run = async (rules) => {
      const res = computeUnitVsUnit(
        { id: "a", name: "A", members: [{ id: "m", name: "M", count: 1, weapons: [w] }] },
        { ranged: def(), melee: def() },
        emptyBonus(),
        rules
      );
      return runMonteCarlo(res.simPlan, { iterations: 20000, seed: 5, yield: async () => {} });
    };
    const s10 = await run(R10);
    const s11 = await run(R11);
    // 10th: 3 mortal wounds = 1 model + 1 wound on the next; 11th: 1 model only, 1 wound lost
    expect(s10.damage.mean).toBeGreaterThan(s11.damage.mean + 0.3);
    expect(s11.damage.max).toBe(2);
    expect(s10.damage.max).toBe(3);
  });
});
