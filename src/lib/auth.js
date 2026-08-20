import { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";

// Tracks the current Supabase auth session for the whole app. `loading` stays
// true only for the very first check (session restore from localStorage on
// page load) so AuthGate knows when it's safe to decide login-screen vs app.
export function useSession() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  return { session, loading };
}
