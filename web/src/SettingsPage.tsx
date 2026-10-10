import { useCallback, useEffect, useMemo, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SettingsState } from "../../supabase/functions/_shared/settings-handler.ts";
import { createSettingsApi } from "./api.ts";
import { SettingsForm } from "./SettingsForm.tsx";
import { supabaseConfig } from "./supabase.ts";

/** Loads the settings state from the Edge Function and reloads it after every save attempt that reached it. */
export function SettingsPage({ supabase }: { supabase: SupabaseClient }) {
  const api = useMemo(() => {
    const { url, publishableKey } = supabaseConfig();
    return createSettingsApi({
      supabaseUrl: url,
      publishableKey,
      accessToken: async () => {
        const { data, error } = await supabase.auth.getSession();
        if (error || !data.session) throw new Error("Not signed in");
        return data.session.access_token;
      },
    });
  }, [supabase]);

  const [state, setState] = useState<SettingsState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await api.load());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <p role="alert">Could not load the settings: {error}</p>;
  if (!state) return <p>Loading…</p>;
  return (
    <SettingsForm
      state={state}
      onSave={async (settings, note) => {
        const response = await api.save(settings, note);
        // A 400 changes nothing on the server; anything else (saved, unchanged, locked) may, so reload.
        if (response.ok || response.status !== 400) await load();
        return response;
      }}
    />
  );
}
