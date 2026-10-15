// Monte Carlo simulation of one attacking unit against one defending unit.
//
// The exact calculator (computeWeapon in App.jsx) works with expected values.
// This module instead rolls every die: hit, wound, save, damage and Feel No
// Pain, one attack at a time, and allocates the damage to defender models one
// by one (damage beyond a model's remaining wounds is lost, mortal wounds
// spill over). Repeating that thousands of times gives the real *distribution*
// of outcomes - how many models die in the typical, bad and good case - not
// just the average.
//
// It is pure and has no React/DOM dependencies. The input "plan" is produced
// by computeUnitVsUnit (field `simPlan`), which in turn copies the already
// resolved numbers out of computeWeapon, so modifiers, rerolls, Melta, cover,
// Anti-X etc. behave exactly as in the exact calculation.
//
// plan = {
//   weapons: [{ type: "ranged"|"melee", sim: WeaponSim }],
//   mortals: [{ type, amount, fnp }],     // flat mortal wounds (e.g. charge)
//   defender: { models, wounds },
// }
// WeaponSim: see computeWeapon's `sim` return value.

// Small fast seeded PRNG (mulberry32): reproducible runs for tests, and plenty
// good for dice.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomSeed() {
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    return crypto.getRandomValues(new Uint32Array(1))[0];
  }
  return Math.floor(Math.random() * 4294967296);
}

// Turns [[value, probability], ...] into a sampler plus its mean.
function buildDist(entries) {
  if (!entries || entries.length === 0) return null;
  const sorted = entries.slice().sort((a, b) => a[0] - b[0]);
  const values = sorted.map((e) => e[0]);
  const cum = [];
  let acc = 0;
  let mean = 0;
  sorted.forEach(([v, p]) => {
    acc += p;
    cum.push(acc);
    mean += v * p;
  });
  return { values, cum, mean };
}

function sampleDist(dist, rng) {
  const u = rng() * dist.cum[dist.cum.length - 1];
  for (let i = 0; i < dist.cum.length; i++) {
    if (u < dist.cum[i]) return dist.values[i];
  }
  return dist.values[dist.values.length - 1];
}

// "Re-roll one damage roll": reroll results at or below the threshold that
// maximises the expected result (same policy as expectedValueWithOneReroll).
function bestRerollThreshold(dist) {
  let best = dist.mean;
  let bestT = -Infinity;
  let cumP = 0;
  let prev = 0;
  for (let i = 0; i < dist.values.length; i++) {
    const p = dist.cum[i] - prev;
    prev = dist.cum[i];
    cumP += p;
    let keptE = 0;
    for (let j = i + 1; j < dist.values.length; j++) {
      const pj = dist.cum[j] - dist.cum[j - 1];
      keptE += dist.values[j] * pj;
    }
    const e = cumP * dist.mean + keptE;
    if (e > best + 1e-12) {
      best = e;
      bestT = dist.values[i];
    }
  }
  return bestT;
}

// Fractional counts (e.g. 3.5 average attacks without known dice) are rounded
// up or down at random so the mean is preserved.
function roundStoch(x, rng) {
  if (!(x > 0)) return 0;
  const f = Math.floor(x);
  return f + (rng() < x - f ? 1 : 0);
}

// Pre-processes a WeaponSim once, so the per-iteration loop only rolls dice.
function prepareWeapon(w) {
  const s = w.sim;
  const attacksDist = buildDist(s.attacksDist);
  const damageDist = buildDist(s.damageDist);
  return {
    type: w.type,
    s,
    attacksDist,
    attacksOffset: attacksDist ? s.attacksMean - attacksDist.mean : 0,
    damageDist,
    damageOffset: damageDist ? s.damageMean - damageDist.mean : 0,
    rerollDamageBelow: damageDist && s.rerollOneDamage ? bestRerollThreshold(damageDist) : -Infinity,
    fnpProb: s.fnp > 0 ? (7 - s.fnp) / 6 : 0,
  };
}

const d6 = (rng) => 1 + Math.floor(rng() * 6);

// One weapon, one iteration. Mutates `state` (defender) and returns the
// damage actually dealt.
function resolveWeapon(pw, state, rng) {
  const s = pw.s;

  // --- number of attacks -------------------------------------------------
  let attacks;
  if (pw.attacksDist) {
    let sum = 0;
    for (let i = 0; i < s.instances; i++) sum += sampleDist(pw.attacksDist, rng) + pw.attacksOffset;
    attacks = roundStoch(sum, rng);
  } else {
    attacks = roundStoch(s.instances * s.attacksMean, rng);
  }
  if (attacks <= 0) return 0;

  // --- hit rolls ---------------------------------------------------------
  // outcome: 0 miss, 1 hit, 2 critical hit
  const rollHit = (allowReroll) => {
    if (s.autoHit) return 1; // Torrent etc.: no roll, so no critical hit either
    let r = d6(rng);
    if (allowReroll && ((s.rerollHit === "ones" && r === 1) || (s.rerollHit === "all" && r < s.hitX && r < s.critHitsOn))) {
      r = d6(rng);
    }
    if (r >= s.critHitsOn) return 2;
    return r >= s.hitX ? 1 : 0;
  };
  let hits = 0;
  let crits = 0;
  let misses = 0;
  for (let i = 0; i < attacks; i++) {
    const o = rollHit(true);
    if (o === 2) crits++;
    else if (o === 1) hits++;
    else misses++;
  }
  if (s.rerollOneHit && misses > 0) {
    const o = rollHit(false);
    if (o === 2) crits++;
    else if (o === 1) hits++;
  }

  const sustainedExtra = s.sustained > 0 ? crits * s.sustained : 0;
  const lethalAuto = s.lethalHits ? crits : 0;
  const woundRolls = hits + sustainedExtra + (s.lethalHits ? 0 : crits);

  // --- wound rolls -------------------------------------------------------
  // outcome: 0 fail, 1 wound, 2 critical wound
  const rollWound = (allowReroll) => {
    let r = d6(rng);
    if (allowReroll && ((s.rerollWound === "ones" && r === 1) || (s.rerollWound === "all" && r < s.woundNeed && r < s.critWoundOn))) {
      r = d6(rng);
    }
    if (r >= s.critWoundOn) return 2;
    return r >= s.woundNeed ? 1 : 0;
  };
  let wounds = lethalAuto; // Lethal Hits: skip the wound roll, can still be saved
  let devWounds = 0;
  let failedWounds = 0;
  for (let i = 0; i < woundRolls; i++) {
    const o = rollWound(true);
    if (o === 2 && s.devastatingWounds) devWounds++;
    else if (o > 0) wounds++;
    else failedWounds++;
  }
  if (s.rerollOneWound && failedWounds > 0) {
    const o = rollWound(false);
    if (o === 2 && s.devastatingWounds) devWounds++;
    else if (o > 0) wounds++;
  }

  // --- saving throws -----------------------------------------------------
  let failedSaves = 0;
  for (let i = 0; i < wounds; i++) {
    let r = d6(rng);
    if (r < s.effSave && ((s.saveReroll === "ones" && r === 1) || s.saveReroll === "all")) r = d6(rng);
    if (r < s.effSave) failedSaves++;
  }

  // --- damage ------------------------------------------------------------
  const rollDamage = () => {
    let d;
    if (pw.damageDist) {
      d = sampleDist(pw.damageDist, rng);
      if (d <= pw.rerollDamageBelow) d = sampleDist(pw.damageDist, rng);
      d += pw.damageOffset;
      d = roundStoch(d, rng);
    } else {
      d = roundStoch(s.damageMean, rng);
    }
    if (s.damageReduction > 0) d = Math.max(1, d - s.damageReduction);
    return d;
  };

  let dealt = 0;
  for (let i = 0; i < failedSaves; i++) dealt += applyDamage(state, afterFnp(rollDamage(), pw.fnpProb, rng), false);
  // Devastating Wounds: mortal wounds that carry over to the next model (10th)
  // or are applied to one model with the excess lost (11th).
  const devSpill = s.devastatingSpill !== false;
  for (let i = 0; i < devWounds; i++) dealt += applyDamage(state, afterFnp(rollDamage(), pw.fnpProb, rng), devSpill);
  return dealt;
}

// Feel No Pain is rolled per point of damage.
function afterFnp(damage, fnpProb, rng) {
  if (fnpProb <= 0) return damage;
  let left = 0;
  for (let i = 0; i < damage; i++) if (rng() >= fnpProb) left++;
  return left;
}

// Normal damage hits one model: whatever exceeds its remaining wounds is
// lost. Mortal wounds (also Devastating Wounds) keep going to the next model.
function applyDamage(state, damage, mortal) {
  let dealt = 0;
  let left = damage;
  while (left > 0 && state.modelsLeft > 0) {
    const take = Math.min(left, state.current);
    state.current -= take;
    dealt += take;
    left = mortal ? left - take : 0;
    if (state.current <= 0) {
      state.modelsLeft--;
      state.current = state.wounds;
    }
  }
  return dealt;
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.max(0, Math.ceil(p * sortedArr.length) - 1));
  return sortedArr[idx];
}

function summarize(values) {
  const n = values.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  const mean = n ? sum / n : 0;
  let sq = 0;
  for (let i = 0; i < n; i++) sq += (values[i] - mean) ** 2;
  const sorted = Float64Array.from(values).sort();
  return {
    mean,
    sd: n > 1 ? Math.sqrt(sq / (n - 1)) : 0,
    p5: percentile(sorted, 0.05),
    p25: percentile(sorted, 0.25),
    p50: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    p95: percentile(sorted, 0.95),
    min: sorted[0] || 0,
    max: sorted[n - 1] || 0,
  };
}

// Runs the simulation. Asynchronous only so the page stays responsive: it
// works for ~12 ms, yields to the browser, and continues. Resolves to null if
// `signal` was aborted (the inputs changed meanwhile).
export async function runMonteCarlo(plan, options = {}) {
  const iterations = Math.max(1, Math.floor(options.iterations || 10000));
  const rng = options.rng || mulberry32(options.seed !== undefined ? options.seed : randomSeed());
  const { signal, onProgress } = options;
  const yieldNow = options.yield || (() => new Promise((resolve) => setTimeout(resolve, 0)));
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

  const models = Math.max(0, Math.round(plan.defender.models));
  const wounds = Math.max(1, Math.round(plan.defender.wounds));
  // Ranged attacks resolve before melee, as in a real turn sequence.
  const ordered = plan.weapons.slice().sort((a, b) => (a.type === b.type ? 0 : a.type === "melee" ? 1 : -1));
  const prepared = ordered.map(prepareWeapon);
  const mortals = (plan.mortals || []).map((m) => ({
    type: m.type,
    amount: m.amount,
    fnpProb: m.fnp > 0 ? (7 - m.fnp) / 6 : 0,
  }));

  const kills = new Uint16Array(iterations);
  const damage = new Float64Array(iterations);
  let rangedTotal = 0;
  let meleeTotal = 0;

  let done = 0;
  while (done < iterations) {
    if (signal && signal.aborted) return null;
    const sliceStart = now();
    while (done < iterations && now() - sliceStart < 12) {
      // time check only every 64 iterations to keep the loop tight
      const stop = Math.min(iterations, done + 64);
      for (; done < stop; done++) {
        const state = { modelsLeft: models, current: wounds, wounds };
        let total = 0;
        for (let k = 0; k < prepared.length; k++) {
          const dealt = resolveWeapon(prepared[k], state, rng);
          total += dealt;
          if (prepared[k].type === "melee") meleeTotal += dealt;
          else rangedTotal += dealt;
        }
        for (let k = 0; k < mortals.length; k++) {
          const dealt = applyDamage(state, afterFnp(Math.round(mortals[k].amount), mortals[k].fnpProb, rng), true);
          total += dealt;
          if (mortals[k].type === "melee") meleeTotal += dealt;
          else rangedTotal += dealt;
        }
        kills[done] = models - state.modelsLeft;
        damage[done] = total;
      }
    }
    if (onProgress) onProgress(done / iterations);
    if (done < iterations) await yieldNow();
  }

  const hist = new Array(models + 1).fill(0);
  let atLeast1 = 0;
  let wipe = 0;
  const halfNeeded = Math.max(1, Math.ceil(models / 2));
  let half = 0;
  for (let i = 0; i < iterations; i++) {
    hist[kills[i]]++;
    if (kills[i] >= 1) atLeast1++;
    if (models > 0 && kills[i] >= models) wipe++;
    if (kills[i] >= halfNeeded) half++;
  }

  return {
    iterations,
    defenderModels: models,
    kills: summarize(kills),
    damage: summarize(damage),
    rangedDamageMean: rangedTotal / iterations,
    meleeDamageMean: meleeTotal / iterations,
    pAtLeast1: atLeast1 / iterations,
    pWipe: wipe / iterations,
    pHalf: half / iterations,
    halfNeeded,
    hist: hist.map((c) => c / iterations),
  };
}
