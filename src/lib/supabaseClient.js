// Not wired into the app yet — this is the connection point for goal 2
// (user accounts + database). Once there's a real Supabase project, fill in
// .env.local (see .env.example) and this client becomes usable; storage.js
// and an auth screen still need to be built on top of it.
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = url && anonKey ? createClient(url, anonKey) : null;
