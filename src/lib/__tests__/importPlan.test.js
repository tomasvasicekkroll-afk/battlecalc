import { describe, it, expect } from "vitest";
import { planImport } from "../importPlan.js";

const sig = (u) => JSON.stringify({ ...u, id: undefined });
let n = 0;
const newId = () => "new" + ++n;
const u = (id, name) => ({ id, name });

describe("planImport", () => {
  it("adds new units with fresh ids and skips identical ones", () => {
    n = 0;
    const plan = planImport({ library: [u("mine", "A")], armies: [] }, { units: [u("theirs1", "A"), u("theirs2", "B")], armies: [] }, sig, newId);
    expect(plan.skipped).toBe(1);
    expect(plan.units).toEqual([{ id: "new1", name: "B" }]);
  });

  it("remaps army unit ids, including to units that already existed", () => {
    n = 0;
    const plan = planImport(
      { library: [u("mine", "A")], armies: [] },
      { units: [u("t1", "A"), u("t2", "B")], armies: [{ name: "X", unitIds: ["t1", "t2", "t2"] }] },
      sig,
      newId
    );
    expect(plan.armies).toHaveLength(1);
    expect(plan.armies[0].unitIds).toEqual(["mine", "new1", "new1"]); // duplicates (3x the same unit) are kept
    expect(plan.armies[0].id).toBe("new2");
  });

  it("does not overwrite an army with the same name and drops armies with no resolvable units", () => {
    const plan = planImport(
      { library: [], armies: [{ id: "a", name: "Same", unitIds: [] }] },
      { units: [u("t1", "A")], armies: [{ name: "Same", unitIds: ["t1"] }, { name: "Ghost", unitIds: ["missing"] }] },
      sig,
      newId
    );
    expect(plan.armies).toEqual([]);
  });

  it("treats identical units inside one import as one", () => {
    n = 0;
    const plan = planImport({ library: [], armies: [] }, { units: [u("a", "Same"), u("b", "Same")], armies: [{ name: "X", unitIds: ["a", "b"] }] }, sig, newId);
    expect(plan.units).toHaveLength(1);
    expect(plan.skipped).toBe(1);
    expect(plan.armies[0].unitIds).toEqual(["new1", "new1"]);
  });
});
