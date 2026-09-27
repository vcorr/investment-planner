import { useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Email-link sign-in. `shouldCreateUser: false`: only an existing user (Vasco) can get a link. */
export function SignIn({ supabase }: { supabase: SupabaseClient }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function send() {
    setSending(true);
    setStatus(null);
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: false, emailRedirectTo: window.location.origin },
    });
    setSending(false);
    setStatus(error ? `Could not send the link: ${error.message}` : "Check your email for the sign-in link.");
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <h2>Sign in</h2>
      <label>
        Email
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
      </label>
      <button type="submit" disabled={sending || email.trim() === ""}>
        {sending ? "Sending…" : "Send sign-in link"}
      </button>
      {status ? <p role="status">{status}</p> : null}
    </form>
  );
}
