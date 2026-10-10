import { useEffect, useState } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { SettingsPage } from "./SettingsPage.tsx";
import { SignIn } from "./SignIn.tsx";

export function App({ supabase }: { supabase: SupabaseClient }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, [supabase]);

  return (
    <main>
      <header>
        <h1>Nordic Paper Trader: settings</h1>
        {session ? (
          <p>
            Signed in as {session.user.email}.{" "}
            <button type="button" onClick={() => void supabase.auth.signOut()}>
              Sign out
            </button>
          </p>
        ) : null}
      </header>
      {session === undefined ? <p>Loading…</p> : session ? <SettingsPage supabase={supabase} /> : <SignIn supabase={supabase} />}
    </main>
  );
}
