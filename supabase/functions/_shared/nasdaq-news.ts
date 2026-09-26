// Nasdaq Nordic company announcements (decision D11, docs/verification.md V23).
// Dependency-free so that both the Deno Edge Function and the Node tests can import it.
// The API is unofficial, so every item is checked by hand and errors are raised rather than guessed around.

export const NEWS_SOURCE = "api.news.eu.nasdaq.com/news/query.action";
export const PAGE_SIZE = 200;
/** Pages fetched per run at most; about 2 to 3 days each, so a run can close a gap of roughly 10 days. */
export const MAX_PAGES = 5;

/** The six markets we keep (D11). Labels exactly as the API writes them. Baltic and Icelandic items are dropped. */
export const IN_SCOPE_MARKETS: ReadonlySet<string> = new Set([
  "Main Market, Helsinki",
  "Main Market, Stockholm",
  "Main Market, Copenhagen",
  "First North Finland",
  "First North Sweden",
  "First North Denmark",
]);

/** Newest first. `timeZone=UTC` matters: `CET` returns local time including summer time (V23). */
export function newsQueryUrl(start: number): string {
  if (!Number.isInteger(start) || start < 0) throw new Error(`Nasdaq news: bad start ${start}`);
  return (
    "https://api.news.eu.nasdaq.com/news/query.action?type=json&showAttachments=false&showCnsSpecific=true" +
    "&showCompany=true&countResults=true&displayLanguage=en&timeZone=UTC&dateMask=yyyy-MM-dd%20HH:mm:ss" +
    `&dir=DESC&globalGroup=companyNews&globalName=NordicAllMarkets&limit=${PAGE_SIZE}&start=${start}`
  );
}

export interface NewsRow {
  disclosureId: number;
  company: string | null;
  market: string;
  category: string | null;
  categoryId: number | null;
  headline: string;
  language: string | null;
  languages: string[] | null;
  messageUrl: string | null;
  /** UTC, ISO 8601. */
  releasedAt: string;
  publishedAt: string | null;
  rawHash: string;
  source: string;
}

export interface NewsPage {
  /** Items on the page before the market filter; fewer than PAGE_SIZE means the feed has ended. */
  itemCount: number;
  /** In-scope items only. */
  rows: NewsRow[];
}

/** Validates every item on the page, then keeps the in-scope markets. Throws on the first bad item. */
export async function parseNewsPage(body: unknown): Promise<NewsPage> {
  const items = itemsOf(body);
  const seen = new Set<number>();
  const rows: NewsRow[] = [];
  for (const [i, item] of items.entries()) {
    const row = await parseItem(item, i);
    if (seen.has(row.disclosureId)) throw new Error(`Nasdaq news: disclosureId ${row.disclosureId} appears twice`);
    seen.add(row.disclosureId);
    if (IN_SCOPE_MARKETS.has(row.market)) rows.push(row);
  }
  return { itemCount: items.length, rows };
}

function itemsOf(body: unknown): unknown[] {
  if (!isRecord(body) || !isRecord(body.results) || !Array.isArray(body.results.item)) {
    throw new Error("Nasdaq news: unexpected response shape, no results.item array");
  }
  return body.results.item;
}

async function parseItem(item: unknown, index: number): Promise<NewsRow> {
  if (!isRecord(item)) throw new Error(`Nasdaq news: item ${index} is not an object`);
  const disclosureId = item.disclosureId;
  if (typeof disclosureId !== "number" || !Number.isSafeInteger(disclosureId) || disclosureId <= 0) {
    throw new Error(`Nasdaq news: item ${index} has a missing or invalid disclosureId`);
  }
  const where = `Nasdaq news: disclosureId ${disclosureId}`;
  const headline = item.headline;
  if (typeof headline !== "string" || headline.trim() === "") throw new Error(`${where} has a missing or empty headline`);
  const market = item.market;
  if (typeof market !== "string" || market === "") throw new Error(`${where} has a missing market`);
  if (typeof item.releaseTime !== "string") throw new Error(`${where} has a missing releaseTime`);

  const published = optional(item.published, "string", where, "published");
  const languages = item.languages ?? null;
  if (languages !== null && !(Array.isArray(languages) && languages.every((l) => typeof l === "string"))) {
    throw new Error(`${where} has languages that are not a list of strings`);
  }
  const categoryId = optional(item.categoryId, "number", where, "categoryId");
  if (categoryId !== null && !Number.isInteger(categoryId)) throw new Error(`${where} has a non-integer categoryId`);

  return {
    disclosureId,
    company: optional(item.company, "string", where, "company"),
    market,
    category: optional(item.cnsCategory, "string", where, "cnsCategory"),
    categoryId,
    headline,
    language: optional(item.language, "string", where, "language"),
    languages: languages as string[] | null,
    messageUrl: optional(item.messageUrl, "string", where, "messageUrl"),
    releasedAt: utcIso(item.releaseTime, where),
    publishedAt: published === null ? null : utcIso(published, where),
    rawHash: await sha256Hex(canonicalJson(item)),
    source: NEWS_SOURCE,
  };
}

/** Missing or null gives null; present with the wrong type throws. */
function optional(value: unknown, type: "string", where: string, field: string): string | null;
function optional(value: unknown, type: "number", where: string, field: string): number | null;
function optional(value: unknown, type: "string" | "number", where: string, field: string): string | number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== type) throw new Error(`${where} has ${field} of type ${typeof value}, expected ${type}`);
  return value as string | number;
}

const NASDAQ_TIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;

/** "2026-09-26 09:19:50" (UTC, because the query sets timeZone=UTC) to "2026-09-26T09:19:50.000Z". */
export function utcIso(raw: string, where = "Nasdaq news"): string {
  const match = NASDAQ_TIME.exec(raw);
  if (!match) throw new Error(`${where}: time "${raw}" is not YYYY-MM-DD HH:mm:ss`);
  const iso = `${match[1]}T${match[2]}.000Z`;
  const parsed = new Date(iso);
  // The round trip rejects impossible dates such as 2026-02-30, which Date would otherwise roll forward.
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== iso) throw new Error(`${where}: time "${raw}" is not a real time`);
  return iso;
}

// ---- Paging -----------------------------------------------------------------------------------------------

export interface PagingInput {
  /** In-scope disclosure IDs on the page just fetched. */
  pageIds: readonly number[];
  /** Which of those were already stored before this run. */
  storedIds: ReadonlySet<number>;
  /** Items on the page before the market filter. */
  itemCount: number;
  /** Pages fetched so far in this run, including this one. */
  pagesFetched: number;
  pageSize?: number;
  maxPages?: number;
}

export interface PagingDecision {
  fetchNext: boolean;
  /** True when the cap was hit without reaching stored items, so older announcements may be missing. */
  gap: boolean;
}

/**
 * Continue only while every item on the page is new. Any overlap means we have caught up with earlier runs.
 * A short page means the feed has no more items. Stop at `maxPages` and report a gap if still no overlap.
 */
export function decideNextPage(input: PagingInput): PagingDecision {
  const { pageIds, storedIds, itemCount, pagesFetched, pageSize = PAGE_SIZE, maxPages = MAX_PAGES } = input;
  if (pageIds.some((id) => storedIds.has(id))) return { fetchNext: false, gap: false };
  if (itemCount < pageSize) return { fetchNext: false, gap: false };
  if (pagesFetched >= maxPages) return { fetchNext: false, gap: true };
  return { fetchNext: true, gap: false };
}

// ---- Helpers ----------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** JSON with object keys sorted at every level. Same output as `canonicalJson` in src/settings/settings.ts. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- Run log ------------------------------------------------------------------------------------------------

/** Poll-run log rows older than this are deleted at the end of each run. */
export const RUN_LOG_RETENTION_DAYS = 90;

export type PollTrigger = "schedule" | "cutoff" | "manual";
const TRIGGERS: ReadonlySet<string> = new Set(["schedule", "cutoff", "manual"]);

/**
 * Reads `{"trigger": "..."}` from a request body. A missing or empty body means "manual";
 * an unknown trigger is an error rather than a guess.
 */
export function parseTrigger(body: string): PollTrigger {
  if (body.trim() === "") return "manual";
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Request body is not JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Request body must be a JSON object");
  const trigger = (parsed as Record<string, unknown>).trigger;
  if (trigger === undefined) return "manual";
  if (typeof trigger !== "string" || !TRIGGERS.has(trigger)) throw new Error(`Unknown trigger: ${JSON.stringify(trigger)}`);
  return trigger as PollTrigger;
}
