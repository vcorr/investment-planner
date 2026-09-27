import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Reads the two public settings from web/.env.local (see web/.env.example); throws when either is missing. */
export function supabaseConfig(): { url: string; publishableKey: string } {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (typeof url !== "string" || url === "" || typeof publishableKey !== "string" || publishableKey === "") {
    throw new Error("Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in web/.env.local (see web/.env.example).");
  }
  return { url, publishableKey };
}

export function createSupabase(): SupabaseClient {
  const { url, publishableKey } = supabaseConfig();
  return createClient(url, publishableKey);
}
