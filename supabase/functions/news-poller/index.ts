// News poller: fetches Nasdaq Nordic company announcements and stores the in-scope ones in `news_items`.
// Called every 5 minutes by Supabase Cron (supabase/sql/schedule-news-poller.sql). Never poll more often
// than every 30 seconds (V12). Deployed with verify_jwt = false; the caller must send the default secret
// key in the `apikey` header, which withSupabase checks.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import postgres from "postgres";
import { decideNextPage, newsQueryUrl, PAGE_SIZE, parseNewsPage, type NewsRow } from "../_shared/nasdaq-news.ts";

const REQUEST_TIMEOUT_MS = 30_000;
/** Pause between pages during catch-up, to stay polite towards an unofficial API. */
const PAGE_GAP_MS = 2_000;
const USER_AGENT = "Mozilla/5.0 (compatible; nordic-paper-trader/0.1)";

interface PollResult {
  fetched: number;
  inScope: number;
  inserted: number;
  pages: number;
  gap: boolean;
}

type Sql = ReturnType<typeof postgres>;

async function fetchPage(start: number): Promise<unknown> {
  const url = newsQueryUrl(start);
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Nasdaq news start=${start}: HTTP ${response.status}`);
  const body: unknown = await response.json().catch(() => null);
  if (body === null) throw new Error(`Nasdaq news start=${start}: body is not JSON`);
  return body;
}

/**
 * IDs from `ids` that are already in the table. JSON is sent as a text parameter and cast in SQL: a bare
 * `${json}::jsonb` lets the driver encode the string a second time, so it arrives as a jsonb string, not an array.
 */
async function storedIds(sql: Sql, ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const rows = await sql<{ id: string }[]>`
    select disclosure_id::text as id from news_items
    where disclosure_id in (select jsonb_array_elements_text(${JSON.stringify(ids)}::text::jsonb)::bigint)`;
  return new Set(rows.map((r) => Number(r.id)));
}

/** Inserts new rows only. `fetched_at` takes its default, so the first sighting is never overwritten. */
async function insertRows(sql: Sql, rows: NewsRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const payload = rows.map((r) => ({
    disclosure_id: r.disclosureId,
    company: r.company,
    market: r.market,
    category: r.category,
    category_id: r.categoryId,
    headline: r.headline,
    language: r.language,
    languages: r.languages,
    message_url: r.messageUrl,
    released_at: r.releasedAt,
    published_at: r.publishedAt,
    raw_hash: r.rawHash,
    source: r.source,
  }));
  const inserted = await sql`
    insert into news_items (disclosure_id, company, market, category, category_id, headline, language, languages,
                            message_url, released_at, published_at, raw_hash, source)
    select disclosure_id, company, market, category, category_id, headline, language, languages,
           message_url, released_at, published_at, raw_hash, source
    from jsonb_to_recordset(${JSON.stringify(payload)}::text::jsonb) as x(
      disclosure_id bigint, company text, market text, category text, category_id integer, headline text,
      language text, languages text[], message_url text, released_at timestamptz, published_at timestamptz,
      raw_hash char(64), source text)
    on conflict (disclosure_id) do nothing
    returning disclosure_id`;
  return inserted.length;
}

async function poll(sql: Sql): Promise<PollResult> {
  const result: PollResult = { fetched: 0, inScope: 0, inserted: 0, pages: 0, gap: false };
  // New announcements arriving mid-run shift items from one page onto the next. Those repeats must not
  // count as overlap with earlier runs, or catch-up would stop too soon.
  const seenThisRun = new Set<number>();
  for (;;) {
    if (result.pages > 0) await new Promise((resolve) => setTimeout(resolve, PAGE_GAP_MS));
    const page = await parseNewsPage(await fetchPage(result.pages * PAGE_SIZE));
    result.pages += 1;
    result.fetched += page.itemCount;
    const rows = page.rows.filter((r) => !seenThisRun.has(r.disclosureId));
    result.inScope += rows.length;
    const pageIds = rows.map((r) => r.disclosureId);
    pageIds.forEach((id) => seenThisRun.add(id));
    // Read what was stored before inserting, or every item would look old.
    const stored = await storedIds(sql, pageIds);
    result.inserted += await insertRows(sql, rows);
    const decision = decideNextPage({ pageIds, storedIds: stored, itemCount: page.itemCount, pagesFetched: result.pages });
    result.gap = decision.gap;
    if (!decision.fetchNext) return result;
  }
}

export default {
  fetch: withSupabase({ auth: "secret" }, async () => {
    const dbUrl = Deno.env.get("SUPABASE_DB_URL");
    if (!dbUrl) return Response.json({ error: "SUPABASE_DB_URL is not set" }, { status: 500 });
    // prepare: false, because SUPABASE_DB_URL may point at the transaction pooler.
    const sql = postgres(dbUrl, { max: 1, prepare: false });
    try {
      const result = await poll(sql);
      if (result.gap) console.warn("news-poller: page cap reached without overlap; older items may be missing", result);
      return Response.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("news-poller failed:", message);
      return Response.json({ error: message }, { status: 500 });
    } finally {
      await sql.end({ timeout: 5 });
    }
  }),
};
