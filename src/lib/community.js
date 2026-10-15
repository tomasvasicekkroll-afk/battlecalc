// Community unit library, backed by the shared_units table (supabase/community.sql).
//
// Everybody signed in can browse and copy units; only admins can publish or
// delete (enforced by row-level security, not just by hiding buttons in the UI).
import { supabase } from "./supabaseClient";

const PAGE = 1000; // Supabase returns at most 1000 rows per request
const CHUNK = 25; // units per write request (each carries a full JSON unit)

function client() {
  if (!supabase) throw new Error("Supabase není nakonfigurovaný");
  return supabase;
}

const chunks = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

// SHA-256 hex of the unit signature, used as the row's unique key.
export async function hashSignature(text) {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  // Very old browsers: a plain string hash is still stable, just shorter.
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return "x" + (h >>> 0).toString(16) + ":" + text.length;
}

// What gets published: the unit without anything personal or local.
export function cleanForPublish(unit) {
  const { id, isFavorite, sourceId, associations, ...rest } = unit;
  return rest;
}

// A copy of a community unit with fresh ids, ready to drop into a library.
export function withFreshIds(unit) {
  return {
    ...unit,
    id: crypto.randomUUID(),
    isFavorite: false,
    members: (unit.members || []).map((m) => ({
      ...m,
      id: crypto.randomUUID(),
      weapons: (m.weapons || []).map((w) => ({ ...w, id: crypto.randomUUID() })),
    })),
  };
}

export async function isAdmin() {
  try {
    const { data, error } = await client().rpc("is_admin");
    return !error && data === true;
  } catch (e) {
    return false;
  }
}

// Light listing for browsing: no unit bodies. Pages through everything.
export async function listSharedUnits() {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client()
      .from("shared_units")
      .select("id,faction,name,points,model_count")
      .order("faction", { ascending: true })
      .order("name", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

// Full unit bodies for the given row ids.
export async function fetchSharedUnits(ids) {
  const units = [];
  for (const part of chunks(ids, CHUNK)) {
    const { data, error } = await client().from("shared_units").select("id,unit").in("id", part);
    if (error) throw error;
    (data || []).forEach((r) => units.push(r.unit));
  }
  return units;
}

// Admin: uploads units (existing ones with the same content are updated, not
// duplicated). `signatureOf(unit)` must give the content signature, id-free.
export async function publishUnits(units, signatureOf, onProgress) {
  let done = 0;
  for (const part of chunks(units, CHUNK)) {
    const rows = await Promise.all(
      part.map(async (u) => ({
        sig: await hashSignature(signatureOf(u)),
        faction: String(u.faction || ""),
        name: String(u.name || "").slice(0, 200),
        points: String(u.points || ""),
        model_count: Math.max(1, Math.round(Number(u.modelCount) || (u.members || []).reduce((n, m) => n + (Number(m.count) || 0), 0) || 1)),
        unit: cleanForPublish(u),
      }))
    );
    // one row per signature within a request (Postgres rejects duplicates in one upsert)
    const unique = Array.from(new Map(rows.map((r) => [r.sig, r])).values());
    const { error } = await client().from("shared_units").upsert(unique, { onConflict: "sig" });
    if (error) throw error;
    done += part.length;
    if (onProgress) onProgress(done, units.length);
  }
  return done;
}

export async function deleteSharedUnits(ids) {
  for (const part of chunks(ids, 100)) {
    const { error } = await client().from("shared_units").delete().in("id", part);
    if (error) throw error;
  }
}
