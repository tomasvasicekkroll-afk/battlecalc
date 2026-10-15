// Per-user storage backed by Supabase (table: user_data, see supabase/schema.sql).
// Same get/set(key, value) shape the app already used for window.storage, so
// App.jsx didn't need to change beyond this file. Requires an authenticated
// session — AuthGate makes sure the app only mounts once signed in.
//
// Errors are thrown, never swallowed: a failed read must not look like "nothing
// saved yet", and a failed write must not look like a successful save.
//
// Offline support (PWA): every value that is read or written is mirrored in
// localStorage. When the network is unreachable, reads fall back to that copy
// and writes are kept locally and queued; the queue is sent to Supabase as soon
// as the connection is back (last write wins per key, as before). A key with
// unsent local changes is never overwritten by what the server holds.
import { supabase } from "./supabaseClient";

const CACHE_PREFIX = "bc:cache:";
const PENDING_PREFIX = "bc:pending:";
const LAST_USER_KEY = "bc:lastUser";

// ---- localStorage helpers (can throw or be unavailable: private mode, quota) ----
function lsGet(k) {
  try {
    return localStorage.getItem(k);
  } catch (e) {
    return null;
  }
}
function lsSet(k, v) {
  try {
    localStorage.setItem(k, v);
    return true;
  } catch (e) {
    return false; // quota or blocked: the cache is best-effort
  }
}
function lsRemove(k) {
  try {
    localStorage.removeItem(k);
  } catch (e) {
    /* ignore */
  }
}

const cacheKey = (userId, key) => `${CACHE_PREFIX}${userId}:${key}`;
const pendingKey = (userId) => `${PENDING_PREFIX}${userId}`;

function readPending(userId) {
  try {
    const arr = JSON.parse(lsGet(pendingKey(userId)) || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}
function writePending(userId, arr) {
  if (arr.length === 0) lsRemove(pendingKey(userId));
  else lsSet(pendingKey(userId), JSON.stringify(arr));
}

// ---- connectivity ----
function isOfflineError(e) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  if (!e) return false;
  if (e.name === "TypeError" || e.name === "AuthRetryableFetchError") return true;
  return /failed to fetch|network|load failed|fetch failed|offline/i.test(String(e.message || ""));
}

// ---- status for the UI ----
let status = { offline: typeof navigator !== "undefined" && navigator.onLine === false, pending: 0 };
const listeners = new Set();
function setStatus(patch) {
  const next = { ...status, ...patch };
  if (next.offline === status.offline && next.pending === status.pending) return;
  status = next;
  listeners.forEach((fn) => fn(status));
}

// Keys whose initial load failed (network error, timeout, corrupt value).
// Writing them would overwrite whatever is really stored with the app's empty
// in-memory default, so set/delete refuse until the page is reloaded.
const blockedKeys = new Set();

function assertWritable(key) {
  if (blockedKeys.has(key)) {
    throw new Error(`Data "${key}" se nepodařilo načíst, ukládání je pozastaveno (obnov stránku).`);
  }
}

async function currentUserId() {
  if (!supabase) throw new Error("Supabase není nakonfigurovaný");
  let result;
  try {
    result = await supabase.auth.getSession();
  } catch (e) {
    result = { data: { session: null }, error: e };
  }
  const { data, error } = result;
  if (data && data.session) {
    lsSet(LAST_USER_KEY, data.session.user.id);
    return data.session.user.id;
  }
  // Offline with an expired token the session cannot be refreshed; the cached
  // data still belongs to the last signed-in user.
  if (error && isOfflineError(error)) {
    const last = lsGet(LAST_USER_KEY);
    if (last) return last;
  }
  if (error) throw error;
  throw new Error("Nejsi přihlášený/á");
}

// Sends every queued local change to Supabase. Safe to call any time.
let flushing = null;
async function flushPending() {
  if (flushing) return flushing;
  flushing = (async () => {
    let userId;
    try {
      userId = await currentUserId();
    } catch (e) {
      return;
    }
    let pending = readPending(userId);
    setStatus({ pending: pending.length });
    for (const key of pending.slice()) {
      const value = lsGet(cacheKey(userId, key));
      if (value === null) {
        pending = pending.filter((k) => k !== key);
        writePending(userId, pending);
        continue;
      }
      const { error } = await supabase.from("user_data").upsert(
        { user_id: userId, key, value, updated_at: new Date().toISOString() },
        { onConflict: "user_id,key" }
      );
      if (error) {
        if (isOfflineError(error)) setStatus({ offline: true });
        break; // keep the rest queued; try again later
      }
      pending = pending.filter((k) => k !== key);
      writePending(userId, pending);
      setStatus({ offline: false, pending: pending.length });
    }
    setStatus({ pending: readPending(userId).length });
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    setStatus({ offline: false });
    flushPending();
  });
  window.addEventListener("offline", () => setStatus({ offline: true }));
}

export const storage = {
  // Resolves to { value } or null when nothing is stored under the key.
  // Rejects when the read failed and there is no local copy to fall back to.
  async get(key) {
    const userId = await currentUserId();
    // Unsent local changes win over the (older) server copy.
    if (readPending(userId).includes(key)) {
      const local = lsGet(cacheKey(userId, key));
      if (local !== null) {
        flushPending();
        return { value: local };
      }
    }
    let result;
    try {
      result = await supabase.from("user_data").select("value").eq("user_id", userId).eq("key", key).maybeSingle();
    } catch (e) {
      result = { data: null, error: e };
    }
    const { data, error } = result;
    if (error) {
      if (isOfflineError(error)) {
        setStatus({ offline: true });
        const cached = lsGet(cacheKey(userId, key));
        if (cached !== null) return { value: cached };
      }
      throw error;
    }
    setStatus({ offline: false });
    if (!data) {
      lsRemove(cacheKey(userId, key));
      return null;
    }
    lsSet(cacheKey(userId, key), data.value);
    return { value: data.value };
  },
  async set(key, value) {
    assertWritable(key);
    const userId = await currentUserId();
    // Always keep a local copy first: it is what the app reads back offline.
    const cached = lsSet(cacheKey(userId, key), value);
    let result;
    try {
      result = await supabase.from("user_data").upsert(
        { user_id: userId, key, value, updated_at: new Date().toISOString() },
        { onConflict: "user_id,key" }
      );
    } catch (e) {
      result = { error: e };
    }
    const { error } = result;
    if (error) {
      if (isOfflineError(error)) {
        if (!cached) throw error; // nowhere to keep it: report the failure
        const pending = readPending(userId);
        if (!pending.includes(key)) writePending(userId, [...pending, key]);
        setStatus({ offline: true, pending: readPending(userId).length });
        return;
      }
      throw error;
    }
    const pending = readPending(userId).filter((k) => k !== key);
    writePending(userId, pending);
    setStatus({ offline: false, pending: pending.length });
    if (pending.length > 0) flushPending();
  },
  async delete(key) {
    assertWritable(key);
    const userId = await currentUserId();
    const { error } = await supabase.from("user_data").delete().eq("user_id", userId).eq("key", key);
    if (error) throw error;
    lsRemove(cacheKey(userId, key));
    writePending(userId, readPending(userId).filter((k) => k !== key));
  },
  async list() {
    const userId = await currentUserId();
    const { data, error } = await supabase.from("user_data").select("key").eq("user_id", userId);
    if (error) throw error;
    return (data || []).map((r) => r.key);
  },
  // Called by the app when it could not load a key, so the empty default state
  // is never written back over the stored data.
  block(key) {
    blockedKeys.add(key);
  },
  isBlocked(key) {
    return blockedKeys.has(key);
  },
  // { offline, pending }: whether the server is unreachable and how many keys
  // still wait to be sent. Returns an unsubscribe function.
  getStatus() {
    return status;
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  flush: flushPending,
};
