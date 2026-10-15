import { describe, it, expect, vi, beforeEach } from "vitest";

const calls = { upserts: [], deletes: [], selects: [] };
const state = { rows: [], rpc: true, failWrite: false };

vi.mock("../supabaseClient", () => ({
  supabase: {
    rpc: async () => ({ data: state.rpc, error: null }),
    from: () => {
      const q = { filters: {} };
      const api = {
        select(cols) {
          q.cols = cols;
          return api;
        },
        order() {
          return api;
        },
        in(col, vals) {
          q.in = vals;
          return api;
        },
        range(from, to) {
          calls.selects.push([from, to]);
          return Promise.resolve({ data: state.rows.slice(from, to + 1), error: null });
        },
        then(resolve) {
          // awaiting select().in(...) directly
          const data = state.rows.filter((r) => (q.in ? q.in.includes(r.id) : true));
          resolve({ data, error: null });
        },
        upsert(rows, opts) {
          calls.upserts.push({ rows, opts });
          return Promise.resolve({ error: state.failWrite ? { message: "denied" } : null });
        },
        delete() {
          return {
            in(col, ids) {
              calls.deletes.push(ids);
              return Promise.resolve({ error: null });
            },
          };
        },
      };
      return api;
    },
  },
}));

import { listSharedUnits, fetchSharedUnits, publishUnits, deleteSharedUnits, isAdmin, hashSignature, cleanForPublish, withFreshIds } from "../community.js";

beforeEach(() => {
  calls.upserts = [];
  calls.deletes = [];
  calls.selects = [];
  state.rows = [];
  state.rpc = true;
  state.failWrite = false;
});

const unit = (name, extra = {}) => ({ id: "x" + name, name, faction: "F", points: "100", isFavorite: true, members: [{ id: "m", name: "M", count: 2, weapons: [{ id: "w" }] }], ...extra });

describe("community library", () => {
  it("hashes signatures stably", async () => {
    expect(await hashSignature("a")).toBe(await hashSignature("a"));
    expect(await hashSignature("a")).not.toBe(await hashSignature("b"));
    expect((await hashSignature("a")).length).toBe(64);
  });

  it("removes personal fields before publishing and gives copies fresh ids", () => {
    const c = cleanForPublish(unit("A"));
    expect(c.id).toBeUndefined();
    expect(c.isFavorite).toBeUndefined();
    const copy = withFreshIds({ ...c, members: [{ id: "m", weapons: [{ id: "w" }] }] });
    expect(copy.id).toBeTruthy();
    expect(copy.members[0].id).not.toBe("m");
    expect(copy.members[0].weapons[0].id).not.toBe("w");
    expect(copy.isFavorite).toBe(false);
  });

  it("publishes in chunks, upserting on the content signature", async () => {
    const units = Array.from({ length: 60 }, (_, i) => unit("U" + i));
    const progress = [];
    const n = await publishUnits(units, (u) => u.name, (d, t) => progress.push([d, t]));
    expect(n).toBe(60);
    expect(calls.upserts.length).toBe(3); // 25 + 25 + 10
    expect(calls.upserts[0].opts).toEqual({ onConflict: "sig" });
    expect(calls.upserts[0].rows[0]).toMatchObject({ faction: "F", name: "U0", model_count: 2 });
    expect(calls.upserts[0].rows[0].unit.isFavorite).toBeUndefined();
    expect(progress.at(-1)).toEqual([60, 60]);
  });

  it("does not send two rows with the same signature in one request", async () => {
    await publishUnits([unit("Same"), unit("Same")], (u) => u.name);
    expect(calls.upserts[0].rows).toHaveLength(1);
  });

  it("surfaces write errors (e.g. not an admin)", async () => {
    state.failWrite = true;
    await expect(publishUnits([unit("A")], (u) => u.name)).rejects.toBeTruthy();
  });

  it("pages through the listing", async () => {
    state.rows = Array.from({ length: 2300 }, (_, i) => ({ id: "r" + i, name: "n" + i }));
    const list = await listSharedUnits();
    expect(list).toHaveLength(2300);
    expect(calls.selects).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it("fetches unit bodies for given ids and deletes in batches", async () => {
    state.rows = [{ id: "a", unit: { name: "A" } }, { id: "b", unit: { name: "B" } }, { id: "c", unit: { name: "C" } }];
    expect(await fetchSharedUnits(["a", "c"])).toEqual([{ name: "A" }, { name: "C" }]);
    await deleteSharedUnits(Array.from({ length: 150 }, (_, i) => "i" + i));
    expect(calls.deletes.map((d) => d.length)).toEqual([100, 50]);
  });

  it("isAdmin reflects the rpc and is false on failure", async () => {
    expect(await isAdmin()).toBe(true);
    state.rpc = false;
    expect(await isAdmin()).toBe(false);
  });
});
