// Per-user storage backed by Supabase (table: user_data, see supabase/schema.sql).
// Same get/set(key, value) shape the app already used for window.storage, so
// App.jsx didn't need to change beyond this file. Requires an authenticated
// session — AuthGate makes sure the app only mounts once signed in.
//
// Errors are thrown, never swallowed: a failed read must not look like "nothing
// saved yet", and a failed write must not look like a successful save.
import { supabase } from "./supabaseClient";

async function currentUserId() {
  if (!supabase) throw new Error("Supabase není nakonfigurovaný");
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (!data.session) throw new Error("Nejsi přihlášený/á");
  return data.session.user.id;
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

export const storage = {
  // Resolves to { value } or null when nothing is stored under the key.
  // Rejects when the read itself failed.
  async get(key) {
    const userId = await currentUserId();
    const { data, error } = await supabase
      .from("user_data")
      .select("value")
      .eq("user_id", userId)
      .eq("key", key)
      .maybeSingle();
    if (error) throw error;
    return data ? { value: data.value } : null;
  },
  async set(key, value) {
    assertWritable(key);
    const userId = await currentUserId();
    const { error } = await supabase.from("user_data").upsert(
      { user_id: userId, key, value, updated_at: new Date().toISOString() },
      { onConflict: "user_id,key" }
    );
    if (error) throw error;
  },
  async delete(key) {
    assertWritable(key);
    const userId = await currentUserId();
    const { error } = await supabase.from("user_data").delete().eq("user_id", userId).eq("key", key);
    if (error) throw error;
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
};
