// Per-user storage backed by Supabase (table: user_data, see supabase/schema.sql).
// Same get/set(key, value) shape the app already used for window.storage, so
// App.jsx didn't need to change beyond this file. Requires an authenticated
// session — AuthGate makes sure the app only mounts once signed in.
import { supabase } from "./supabaseClient";

async function currentUserId() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session ? data.session.user.id : null;
}

export const storage = {
  async get(key) {
    const userId = await currentUserId();
    if (!userId) return null;
    const { data, error } = await supabase
      .from("user_data")
      .select("value")
      .eq("user_id", userId)
      .eq("key", key)
      .maybeSingle();
    if (error || !data) return null;
    return { value: data.value };
  },
  async set(key, value) {
    const userId = await currentUserId();
    if (!userId) return;
    await supabase.from("user_data").upsert(
      { user_id: userId, key, value, updated_at: new Date().toISOString() },
      { onConflict: "user_id,key" }
    );
  },
  async delete(key) {
    const userId = await currentUserId();
    if (!userId) return;
    await supabase.from("user_data").delete().eq("user_id", userId).eq("key", key);
  },
  async list() {
    const userId = await currentUserId();
    if (!userId) return [];
    const { data } = await supabase.from("user_data").select("key").eq("user_id", userId);
    return (data || []).map((r) => r.key);
  },
};
