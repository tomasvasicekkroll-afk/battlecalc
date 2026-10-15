// Private share links between users (see supabase/shares.sql).
//
// The owner picks what to share, gets a link with a random token, and sends it
// to whoever they like. The link expires after 30 days and can be deleted at
// any time. There is no list of other people's shares anywhere.
import { supabase } from "./supabaseClient";

const PENDING_KEY = "battlecalc:pendingShare";
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

function client() {
  if (!supabase) throw new Error("Supabase není nakonfigurovaný");
  return supabase;
}

export function newToken() {
  const bytes = new Uint8Array(18); // 144 bits
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const isValidToken = (t) => typeof t === "string" && TOKEN_RE.test(t);

export function shareUrl(token, origin) {
  return `${origin || window.location.origin}/?share=${token}`;
}

// What gets uploaded: units without anything personal, plus the armies that use them.
export function buildSharePayload(units, armies) {
  return {
    battlecalcShare: 1,
    units: units.map(({ isFavorite, sourceId, associations, ...rest }) => rest),
    armies: armies.map((a) => ({ name: a.name, unitIds: a.unitIds })),
  };
}

export async function createShare({ title, units, armies }) {
  const token = newToken();
  const payload = buildSharePayload(units, armies);
  const { error } = await client()
    .from("shares")
    .insert({ token, title: String(title || "").slice(0, 120), payload, unit_count: units.length });
  if (error) throw error;
  return token;
}

export async function listMyShares() {
  const { data, error } = await client()
    .from("shares")
    .select("token,title,unit_count,created_at,expires_at")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function deleteShare(token) {
  const { error } = await client().from("shares").delete().eq("token", token);
  if (error) throw error;
}

// null when the link is unknown or expired.
export async function fetchShare(token) {
  if (!isValidToken(token)) return null;
  const { data, error } = await client().rpc("get_share", { p_token: token });
  if (error) throw error;
  if (!data || !data.payload) return null;
  const p = data.payload;
  return {
    title: data.title || "",
    expiresAt: data.expires_at,
    units: Array.isArray(p.units) ? p.units : [],
    armies: Array.isArray(p.armies) ? p.armies : [],
  };
}

// A link opened before signing in must survive the login redirect (magic link,
// Google), which drops the query string: stash the token, clean the URL.
export function captureShareFromUrl() {
  try {
    const url = new URL(window.location.href);
    const token = url.searchParams.get("share");
    if (!token) return;
    if (isValidToken(token)) localStorage.setItem(PENDING_KEY, token);
    url.searchParams.delete("share");
    window.history.replaceState({}, "", url.pathname + (url.search || "") + url.hash);
  } catch (e) {
    /* storage blocked or no window: nothing to capture */
  }
}

export function pendingShareToken() {
  try {
    const t = localStorage.getItem(PENDING_KEY);
    return isValidToken(t) ? t : null;
  } catch (e) {
    return null;
  }
}

export function clearPendingShare() {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch (e) {
    /* ignore */
  }
}
