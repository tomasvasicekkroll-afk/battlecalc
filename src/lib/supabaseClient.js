// Supabase client. Configured from VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
// (see .env.example); `null` when they are missing, in which case AuthGate
// shows a configuration message instead of the app. Used by auth.js, AuthGate
// and storage.js.
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = url && anonKey ? createClient(url, anonKey) : null;
