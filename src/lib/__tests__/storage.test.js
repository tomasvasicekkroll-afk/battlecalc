// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

// A tiny in-memory stand-in for the Supabase client, with a switchable network.
const remote = new Map();
const net = { down: false };
const networkError = () => ({ message: "TypeError: Failed to fetch", name: "TypeError" });

vi.mock("../supabaseClient", () => {
  const builder = (table) => {
    const q = { table, filters: {}, op: "select" };
    const api = {
      select() {
        q.op = "select";
        return api;
      },
      eq(col, val) {
        q.filters[col] = val;
        return api;
      },
      async maybeSingle() {
        if (net.down) return { data: null, error: networkError() };
        const v = remote.get(`${q.filters.user_id}:${q.filters.key}`);
        return { data: v === undefined ? null : { value: v }, error: null };
      },
      async upsert(row) {
        if (net.down) return { error: networkError() };
        remote.set(`${row.user_id}:${row.key}`, row.value);
        return { error: null };
      },
      delete() {
        q.op = "delete";
        return {
          eq(c1, v1) {
            return {
              async eq(c2, v2) {
                if (net.down) return { error: networkError() };
                remote.delete(`${v1}:${v2}`);
                return { error: null };
              },
            };
          },
        };
      },
    };
    return api;
  };
  return {
    supabase: {
      auth: { getSession: async () => ({ data: { session: { user: { id: "u1" } } }, error: null }) },
      from: builder,
    },
  };
});

let storage;
beforeEach(async () => {
  remote.clear();
  net.down = false;
  localStorage.clear();
  vi.resetModules();
  ({ storage } = await import("../storage.js"));
});

describe("storage", () => {
  it("reads and writes through to the server", async () => {
    await storage.set("library_v2", "[1]");
    expect(remote.get("u1:library_v2")).toBe("[1]");
    expect(await storage.get("library_v2")).toEqual({ value: "[1]" });
    expect(await storage.get("missing")).toBeNull();
  });

  it("serves the last known value when the network is down", async () => {
    await storage.set("armies_v1", "[2]");
    net.down = true;
    expect(await storage.get("armies_v1")).toEqual({ value: "[2]" });
    expect(storage.getStatus().offline).toBe(true);
  });

  it("throws when offline with nothing cached (so the app never treats it as empty)", async () => {
    net.down = true;
    await expect(storage.get("history_v1")).rejects.toBeTruthy();
  });

  it("queues writes while offline and sends them when the network returns", async () => {
    net.down = true;
    await storage.set("library_v2", "[3]"); // does not throw: kept locally
    expect(remote.has("u1:library_v2")).toBe(false);
    expect(storage.getStatus().pending).toBe(1);
    net.down = false;
    await storage.flush();
    expect(remote.get("u1:library_v2")).toBe("[3]");
    expect(storage.getStatus().pending).toBe(0);
  });

  it("does not let an older server value overwrite unsent local changes", async () => {
    remote.set("u1:board_v1", "OLD");
    net.down = true;
    await storage.set("board_v1", "NEW");
    net.down = false;
    // reading before the flush returns the local change, never the stale server copy
    expect((await storage.get("board_v1")).value).toBe("NEW");
    await storage.flush();
    expect(remote.get("u1:board_v1")).toBe("NEW");
  });

  it("still refuses to write a key that failed to load", async () => {
    storage.block("library_v2");
    await expect(storage.set("library_v2", "[]")).rejects.toThrow(/pozastaveno/);
    expect(storage.isBlocked("library_v2")).toBe(true);
  });

  it("notifies subscribers about status changes", async () => {
    const seen = [];
    const off = storage.subscribe((s) => seen.push({ ...s }));
    net.down = true;
    await storage.set("a", "1");
    off();
    expect(seen.some((s) => s.offline && s.pending === 1)).toBe(true);
  });
});
