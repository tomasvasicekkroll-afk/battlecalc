// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const calls = { inserts: [], deletes: [], rpcs: [] };
const state = { rpcData: null, insertError: null };
vi.mock("../supabaseClient", () => ({
  supabase: {
    rpc: async (name, args) => {
      calls.rpcs.push([name, args]);
      return { data: state.rpcData, error: null };
    },
    from: () => ({
      insert: async (row) => {
        calls.inserts.push(row);
        return { error: state.insertError };
      },
      delete: () => ({
        eq: async (col, val) => {
          calls.deletes.push([col, val]);
          return { error: null };
        },
      }),
      select: () => ({
        gt: () => ({ order: async () => ({ data: [{ token: "t", title: "x", unit_count: 1 }], error: null }) }),
      }),
    }),
  },
}));

import { newToken, isValidToken, shareUrl, buildSharePayload, createShare, fetchShare, deleteShare, listMyShares, captureShareFromUrl, pendingShareToken, clearPendingShare } from "../shares.js";

beforeEach(() => {
  calls.inserts = [];
  calls.deletes = [];
  calls.rpcs = [];
  state.rpcData = null;
  state.insertError = null;
  localStorage.clear();
  window.history.replaceState({}, "", "/");
});

describe("share links", () => {
  it("generates unguessable url-safe tokens that pass validation", () => {
    const a = newToken();
    expect(isValidToken(a)).toBe(true);
    expect(a.length).toBeGreaterThanOrEqual(16);
    expect(a).not.toBe(newToken());
    expect(isValidToken("short")).toBe(false);
    expect(isValidToken("has spaces and ! chars......")).toBe(false);
    expect(isValidToken(null)).toBe(false);
  });

  it("builds a link on the given origin", () => {
    expect(shareUrl("abc", "https://x.example")).toBe("https://x.example/?share=abc");
  });

  it("uploads units without personal fields, and armies by name/unit ids only", () => {
    const p = buildSharePayload([{ id: "u", name: "U", isFavorite: true, sourceId: "s", associations: [1], members: [] }], [{ id: "a", name: "Army", unitIds: ["u"], extra: 1 }]);
    expect(p.units[0]).toEqual({ id: "u", name: "U", members: [] });
    expect(p.armies).toEqual([{ name: "Army", unitIds: ["u"] }]);
  });

  it("creates a share row and returns its token", async () => {
    const token = await createShare({ title: "Moje armáda", units: [{ id: "u", name: "U" }], armies: [] });
    expect(isValidToken(token)).toBe(true);
    expect(calls.inserts[0]).toMatchObject({ token, title: "Moje armáda", unit_count: 1 });
  });

  it("surfaces insert errors (e.g. share limit reached)", async () => {
    state.insertError = { message: "row-level security" };
    await expect(createShare({ title: "", units: [], armies: [] })).rejects.toBeTruthy();
  });

  it("opens a share through get_share and tolerates unknown tokens", async () => {
    expect(await fetchShare("not valid")).toBeNull(); // never even asks the server
    expect(calls.rpcs).toHaveLength(0);
    const token = newToken();
    expect(await fetchShare(token)).toBeNull();
    state.rpcData = { title: "T", expires_at: "2030-01-01", payload: { units: [{ id: "a" }], armies: [{ name: "A", unitIds: ["a"] }] } };
    expect(await fetchShare(token)).toEqual({ title: "T", expiresAt: "2030-01-01", units: [{ id: "a" }], armies: [{ name: "A", unitIds: ["a"] }] });
    expect(calls.rpcs[0][0]).toBe("get_share");
  });

  it("lists and deletes own shares", async () => {
    expect(await listMyShares()).toHaveLength(1);
    await deleteShare("tok");
    expect(calls.deletes).toEqual([["token", "tok"]]);
  });

  it("keeps a link opened before login and cleans the URL", () => {
    const token = newToken();
    window.history.replaceState({}, "", `/?share=${token}&x=1`);
    captureShareFromUrl();
    expect(pendingShareToken()).toBe(token);
    expect(window.location.search).toBe("?x=1");
    clearPendingShare();
    expect(pendingShareToken()).toBeNull();
  });

  it("ignores malformed tokens in the URL", () => {
    window.history.replaceState({}, "", "/?share=bad");
    captureShareFromUrl();
    expect(pendingShareToken()).toBeNull();
    expect(window.location.search).toBe("");
  });
});
