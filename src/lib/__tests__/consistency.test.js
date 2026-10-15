import { describe, it, expect } from "vitest";
import { computeUnitVsUnit, defenderProfile, emptyBonus, emptyWeapon } from "../../App.jsx";
import { runMonteCarlo } from "../montecarlo.js";

// The exact calculator and the simulation are two models of the same rules,
// fed from the same resolved numbers. Their averages must agree.
const unit = (weapon, count = 5) => ({
  id: "a",
  name: "Attacker",
  members: [{ id: "m", name: "Model", count, weapons: [{ ...emptyWeapon(), ...weapon }] }],
});
const defender = (over = {}) => ({
  id: "d",
  name: "Defender",
  toughness: 4,
  save: 3,
  invul: 0,
  wounds: 400, // one huge model: no overflow loss, so damage is directly comparable
  fnp: 0,
  psychicFnp: 0,
  woundDebuff: false,
  damageReduction: 0,
  keywords: {},
  members: [{ count: 20 }],
  ...over,
});

async function compare(weapon, defOver = {}, bonus = emptyBonus()) {
  const def = defenderProfile(defender(defOver), { models: 1 });
  const res = computeUnitVsUnit(unit(weapon), { ranged: def, melee: def }, bonus);
  const sim = await runMonteCarlo(res.simPlan, { iterations: 60000, seed: 7, yield: async () => {} });
  return { exactDamage: res.totalDamage, simDamage: sim.damage.mean, sim };
}

const close = (a, b, rel = 0.04) => expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.max(0.05, rel * Math.max(a, b)));

describe("exact calculation vs Monte Carlo", () => {
  it("plain weapon", async () => {
    const r = await compare({ attacks: 2, hitX: 3, strength: 5, ap: -1, damage: 1 });
    close(r.exactDamage, r.simDamage);
  });
  it("Sustained Hits + Lethal Hits + rerolls", async () => {
    const r = await compare({ attacks: 3, hitX: 3, strength: 4, ap: 0, damage: 1, sustained: 1, lethalHits: true, rerollHit: "ones", rerollWound: "all" });
    close(r.exactDamage, r.simDamage);
  });
  it("Devastating Wounds", async () => {
    const r = await compare({ attacks: 4, hitX: 3, strength: 8, ap: -2, damage: 2, devastatingWounds: true });
    close(r.exactDamage, r.simDamage);
  });
  it("Feel No Pain and damage reduction", async () => {
    const r = await compare({ attacks: 3, hitX: 3, strength: 6, ap: -2, damage: 3 }, { fnp: 5, damageReduction: 1 });
    close(r.exactDamage, r.simDamage);
  });
  it("invulnerable save", async () => {
    const r = await compare({ attacks: 3, hitX: 3, strength: 6, ap: -3, damage: 2 }, { invul: 4 });
    close(r.exactDamage, r.simDamage);
  });
  it("dice damage and attacks (D6 / D3+1)", async () => {
    const r = await compare({ attacks: 3.5, attacksDice: "D6", hitX: 3, strength: 5, ap: -1, damage: 3.5, damageDice: "D6" });
    close(r.exactDamage, r.simDamage);
  });
  it("Torrent (auto-hit)", async () => {
    const r = await compare({ attacks: 6, hitX: 1, strength: 4, ap: 0, damage: 1 });
    close(r.exactDamage, r.simDamage);
  });
  it("overflow damage is lost on multi-model units (exact calc overestimates)", async () => {
    // damage D6 into 2-wound models: the exact figure counts every pip, the simulation only what fits
    const w = { attacks: 3.5, attacksDice: "D6", hitX: 2, strength: 8, ap: -4, damage: 3.5, damageDice: "D6" };
    const def = defenderProfile(defender({ wounds: 2 }), { models: 40 });
    const res = computeUnitVsUnit(unit(w), { ranged: def, melee: def }, emptyBonus());
    const sim = await runMonteCarlo(res.simPlan, { iterations: 30000, seed: 3, yield: async () => {} });
    expect(sim.damage.mean).toBeLessThan(res.totalDamage * 0.8);
    expect(sim.kills.mean).toBeLessThanOrEqual(res.killedModels + 0.5);
  });
});
