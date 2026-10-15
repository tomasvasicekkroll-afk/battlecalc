import { describe, it, expect } from "vitest";
import { runMonteCarlo, mulberry32 } from "../montecarlo.js";

// A weapon that always hits and wounds unless overridden, damage 1, no save.
const baseSim = (over = {}) => ({
  instances: 1,
  attacksMean: 10,
  attacksDist: null,
  autoHit: false,
  hitX: 4,
  critHitsOn: 6,
  rerollHit: "none",
  rerollOneHit: false,
  lethalHits: false,
  sustained: 0,
  woundNeed: 4,
  critWoundOn: 6,
  rerollWound: "none",
  rerollOneWound: false,
  devastatingWounds: false,
  effSave: 7,
  saveReroll: "none",
  damageMean: 1,
  damageDist: null,
  rerollOneDamage: false,
  damageReduction: 0,
  fnp: 0,
  ...over,
});

const run = (sim, defender, extra = {}) =>
  runMonteCarlo(
    { weapons: [{ type: "ranged", sim }], mortals: extra.mortals || [], defender },
    { iterations: 40000, seed: 12345, yield: async () => {} }
  );

describe("montecarlo", () => {
  it("matches the closed-form mean for simple hit/wound chains", async () => {
    // 10 attacks * 1/2 hit * 1/2 wound = 2.5 wounds, 1 damage, 1-wound models
    const r = await run(baseSim(), { models: 20, wounds: 1 });
    expect(r.kills.mean).toBeGreaterThan(2.45);
    expect(r.kills.mean).toBeLessThan(2.55);
    expect(r.damage.mean).toBeCloseTo(r.kills.mean, 6);
  });

  it("is reproducible for a fixed seed", async () => {
    const a = await run(baseSim(), { models: 20, wounds: 1 });
    const b = await run(baseSim(), { models: 20, wounds: 1 });
    expect(a.kills.mean).toBe(b.kills.mean);
  });

  it("loses damage that exceeds a model's wounds (no carry-over)", async () => {
    // Every attack hits+wounds, damage 3 into 2-wound models: 1 model per wound, 2 damage dealt each
    const r = await run(baseSim({ attacksMean: 4, hitX: 2, critHitsOn: 7, woundNeed: 2, critWoundOn: 7, damageMean: 3 }), {
      models: 10,
      wounds: 2,
    });
    // hitX 2 => 5/6 hit, woundNeed 2 => 5/6 wound, 4 attacks => mean wounds 4*25/36
    const expectedWounds = (4 * 25) / 36;
    expect(r.kills.mean).toBeGreaterThan(expectedWounds - 0.05);
    expect(r.kills.mean).toBeLessThan(expectedWounds + 0.05);
    expect(r.damage.mean).toBeCloseTo(r.kills.mean * 2, 6);
  });

  it("spills Devastating Wounds (mortal) over to the next model", async () => {
    // Always crit-wound (critWoundOn 2), damage 4 vs 2-wound models, 1 attack: kills exactly 2 models each time
    const r = await run(
      baseSim({ attacksMean: 1, autoHit: true, woundNeed: 2, critWoundOn: 2, devastatingWounds: true, damageMean: 4, effSave: 2 }),
      { models: 10, wounds: 2 }
    );
    // an unmodified 1 always fails the wound roll (5/6 chance to wound); a crit wound kills exactly 2 models
    expect(r.hist[1]).toBe(0);
    expect(r.kills.max).toBe(2);
    expect(r.hist[2]).toBeGreaterThan(0.82);
    expect(r.hist[2]).toBeLessThan(0.85);
  });

  it("applies Feel No Pain per point of damage", async () => {
    // 6+ FNP => 1/6 of damage points ignored; 60 auto-wounds of 1 damage with no save
    const r = await run(
      baseSim({ attacksMean: 60, autoHit: true, woundNeed: 2, critWoundOn: 7, fnp: 6 }),
      { models: 100, wounds: 1 }
    );
    // wound 5/6 of the time, then 5/6 survive FNP: 60 * 5/6 * 5/6
    expect(r.damage.mean).toBeGreaterThan(41.2);
    expect(r.damage.mean).toBeLessThan(42.1);
  });

  it("Lethal Hits skip the wound roll", async () => {
    // woundNeed impossible (7) but critical hits auto-wound: 60 attacks, crit 1/6 => 10 wounds
    const r = await run(baseSim({ attacksMean: 60, lethalHits: true, hitX: 6, woundNeed: 7, critWoundOn: 7 }), {
      models: 100,
      wounds: 1,
    });
    expect(r.kills.mean).toBeGreaterThan(9.8);
    expect(r.kills.mean).toBeLessThan(10.2);
  });

  it("reports wipe probability and a full histogram", async () => {
    const r = await run(baseSim({ attacksMean: 3, autoHit: true, woundNeed: 2, critWoundOn: 7 }), { models: 1, wounds: 1 });
    expect(r.hist.length).toBe(2);
    expect(r.hist[0] + r.hist[1]).toBeCloseTo(1, 9);
    expect(r.pWipe).toBeCloseTo(r.hist[1], 9);
    // 1 - (1/6)^3
    expect(r.pWipe).toBeGreaterThan(0.99);
  });

  it("can be aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await runMonteCarlo({ weapons: [], mortals: [], defender: { models: 1, wounds: 1 } }, { iterations: 1000, signal: ctrl.signal });
    expect(r).toBeNull();
  });

  it("mulberry32 stays inside [0,1)", () => {
    const rng = mulberry32(1);
    for (let i = 0; i < 1000; i++) {
      const x = rng();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});
