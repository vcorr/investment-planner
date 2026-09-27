// Settings API for the web page (M2). GET returns the current version, the lock state and the history;
// POST { settings, note } stores a new, hashed version unless it equals the current one. Only the user in
// ALLOWED_USER_ID may call it. Saves are refused while a scored month runs (brief §11, A11).
// The request logic lives in ../_shared/settings-handler.ts, where Node tests cover it.
// Deployed with verify_jwt = false: withSupabase verifies the user's JWT against the project's JWKS itself.

import "@supabase/functions-js/edge-runtime.d.ts";
import { fromSupabaseUrl, withSupabase } from "@supabase/server";
import postgres from "postgres";
import { helsinkiToday } from "../_shared/settings.ts";
import {
  handleSettingsRequest,
  type SettingsStore,
  type StoredVersion,
  type VersionSummary,
} from "../_shared/settings-handler.ts";

type Sql = ReturnType<typeof postgres>;

interface VersionRow {
  id: number;
  hash: string;
  note: string | null;
  created_at: Date;
}

const summary = (r: VersionRow): VersionSummary => ({
  id: r.id,
  hash: r.hash,
  note: r.note,
  createdAt: r.created_at.toISOString(),
});

function postgresStore(sql: Sql): SettingsStore {
  return {
    atomically(fn) {
      // One transaction, serialised by an advisory lock, so two saves cannot interleave.
      return sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext('settings_versions'))`;
        return fn(postgresStore(tx as unknown as Sql));
      }) as Promise<Awaited<ReturnType<typeof fn>>>;
    },
    async currentVersion(): Promise<StoredVersion | null> {
      const [row] = await sql<(VersionRow & { payload: unknown })[]>`
        select id, hash, note, created_at, payload from settings_versions order by id desc limit 1`;
      return row ? { ...summary(row), payload: row.payload } : null;
    },
    async listVersions() {
      const rows = await sql<VersionRow[]>`select id, hash, note, created_at from settings_versions order by id desc`;
      return rows.map(summary);
    },
    async scoredMonths() {
      const rows = await sql<{ starts_on: string; ends_on: string; ended_early_at: Date | null }[]>`
        select starts_on::text, ends_on::text, ended_early_at from scored_months`;
      return rows.map((r) => ({ startsOn: r.starts_on, endsOn: r.ends_on, endedEarlyAt: r.ended_early_at }));
    },
    async insertVersion({ hash, settings, note }) {
      // JSON goes in as text and is cast in SQL; a bare `::jsonb` makes postgres.js encode it twice.
      const [row] = await sql<VersionRow[]>`
        insert into settings_versions (hash, payload, note)
        values (${hash}, ${JSON.stringify(settings)}::text::jsonb, ${note})
        returning id, hash, note, created_at`;
      if (!row) throw new Error("Settings insert returned no row");
      return summary(row);
    },
  };
}

const supabaseUrl = Deno.env.get("SUPABASE_URL");

export default {
  fetch: withSupabase(
    { auth: "user", ...(supabaseUrl ? { issuer: fromSupabaseUrl(supabaseUrl) } : {}) },
    async (req: Request, ctx) => {
      const dbUrl = Deno.env.get("SUPABASE_DB_URL");
      if (!dbUrl) return Response.json({ error: "SUPABASE_DB_URL is not set" }, { status: 500 });
      const request = {
        method: req.method,
        userId: ctx.userClaims?.id ?? null,
        body: req.method === "POST" ? await req.text() : "",
      };
      const context = { allowedUserId: Deno.env.get("ALLOWED_USER_ID"), todayHelsinki: helsinkiToday() };
      // prepare: false, because SUPABASE_DB_URL may point at the transaction pooler. postgres.js connects
      // lazily, so a refused user (403) never opens a connection.
      const sql = postgres(dbUrl, { max: 1, prepare: false });
      try {
        const result = await handleSettingsRequest(request, postgresStore(sql), context);
        return Response.json(result.body, { status: result.status });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("settings failed:", message);
        return Response.json({ error: message }, { status: 500 });
      } finally {
        await sql.end({ timeout: 5 });
      }
    },
  ),
};
