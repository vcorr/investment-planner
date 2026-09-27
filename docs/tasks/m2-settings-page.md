# Task: M2 — settings page for the ethical screen rules

Cloud agent task. **Read `docs/tasks/README.md` first**: its rules on shared files, fixtures and hand-back apply. **You are the only task allowed to change `src/settings/settings.ts`.**

## Goal

Vasco sets the ethical screen rules himself, and wants to change them over time (D5, D6, A7). Build a small web page where he signs in, edits the rules and per-company overrides, and saves them. Each save becomes a new, hashed settings version (A11). Saving is refused while a scored month is running, because any change during a scored month voids it (brief §11).

This is the first slice of the web interface. The rest (performance, predictions, today's report) comes later, in the same app.

## Read

- `BRIEF.md`: §7.2 (the ethical screen), §11 (pre-registration)
- `docs/decisions.md`: D5, D6, D8, D9, A7, A11, A12. Hosting is Supabase plus Firebase Hosting. For now the page runs only on Vasco's Mac, and hosting comes later.
- The existing settings code: `src/settings/settings.ts` (schema, canonical JSON, hash), `src/settings/store.ts` (save rule: a new version unless it equals the current one), and `src/jobs/seed-sample.ts`
- The Edge Function pattern: `supabase/functions/news-poller/` (`withSupabase`, `deno.json`, the `_shared/` folder)

## Build

1. **Settings schema**, extended with a `screen` section. Move the schema and `canonicalJson` into `supabase/functions/_shared/settings.ts`, so the Edge Function and Node use one definition, and re-export them from `src/settings/settings.ts`. A test must prove that Node and the shared file hash identically.
   - `screen.rules[]`, one per excluded activity:
     - `id` and `activity` (e.g. "Fossil fuels"), plus a `description`
     - `test`, one of:
       - `{ kind: "any_involvement" }`
       - `{ kind: "revenue_share", maxPct }`
       - `{ kind: "role", roles: [...] }`, where roles are, for example, `extracts`, `produces`, `sells`, `distributes`, `services` or `consumes`. That is how Vasco can express the natural-gas question (D6).
     - optional `notes`
   - `screen.borderline`: the literal `"exclude_until_reviewed"` (brief §7.2: unreviewed borderline cases are excluded).
   - `screen.overrides[]`: `{ isin, verdict: "include" | "exclude", reason, decidedOn }`. Overrides always win (A7).
   - **Defaults:** the brief's five excluded activities (fossil fuels, weapons and defence, mining, pesticides, tobacco), with `any_involvement` as a placeholder test and a note saying Vasco has not reviewed them yet. Add no rule for natural-gas consumers: Vasco decides that in the page.
   - Update `src/jobs/seed-sample.ts` to save the defaults with the sample universe. The stored version 2 has no `screen`, so it will not parse any more. The main session re-runs the seed, which creates version 3. Say so in the PR.
2. **Lock rule.**
   - A table `scored_months` in `src/db/tables/experiment.ts`: `id`, `starts_on`, `ends_on`, `announced_at`, `ended_early_at` (nullable), with `.enableRLS()`. Write no migration.
   - A pure function `settingsLocked(months, todayHelsinki)`: true inside a month that has not ended early.
   - With no rows, nothing is locked.
3. **Edge Function** `supabase/functions/settings/`:
   - **Auth:** `withSupabase({ auth: "user" })`. Only the user whose ID is in the `ALLOWED_USER_ID` environment variable may use it, and everyone else gets 403.
   - **Database:** connect as in `news-poller` (`SUPABASE_DB_URL`, send JSON as `${JSON.stringify(x)}::text::jsonb`).
   - `GET`: the current version (id, hash, created at, note, settings), whether settings are locked, and the list of past versions (id, created at, note, hash).
   - `POST { settings, note }`:
     - validate with the shared schema
     - refuse if locked (409)
     - refuse an empty note
     - hash, and insert a new version unless it equals the current one
     - return the result
   - Validation errors return 400 with the zod issues, readable by the page.
4. **Web app** in `web/`: Vite + React + TypeScript, plain and readable, no design system needed. It is configured with `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. Provide `web/.env.example`; do not commit real values.
   - **Sign-in:** Supabase Auth with an email link (`signInWithOtp`, `shouldCreateUser: false`). Google sign-in comes later.
   - **Settings screen:**
     - the universe, read-only
     - screen rules: add, edit and remove, with the test type as a choice and the fields to match
     - overrides: add and remove, with the ISIN checked for format
     - a required "change note", and Save
   - Show validation errors, the lock state (the form is read-only when locked), and the version history.
   - Scripts: `web:dev`, `web:build`. The existing `pnpm typecheck` and `pnpm test` must also cover `web/`, or add a web typecheck to them.
5. **Tests:**
   - schema defaults, and a rejection for each rule kind's bad inputs
   - identical hashes in Node and the shared file
   - `settingsLocked` at month boundaries
   - the Edge Function's handler logic, extracted into a pure function and tested with a fake store: 403, 409, 400, no-op on identical settings, and a new version otherwise
   - one render test of the settings form

## For the main session

These go in the PR:
- Deploy the function and set the `ALLOWED_USER_ID` secret.
- Create Vasco's user, and turn off new sign-ups.
- Set the auth redirect URL for `http://localhost:5173`.
- Run the migration and re-run the seed.
