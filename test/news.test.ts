import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  decideNextPage,
  IN_SCOPE_MARKETS,
  MAX_PAGES,
  NEWS_SOURCE,
  newsQueryUrl,
  PAGE_SIZE,
  parseNewsPage,
  parseTrigger,
  utcIso,
} from "../supabase/functions/_shared/nasdaq-news.js";
import { canonicalJson as settingsCanonicalJson } from "../src/settings/settings.js";

// Real response, 200 items from 24 to 26 September 2026, saved on 2026-09-26.
const fixture = (): any => JSON.parse(readFileSync("test/fixtures/nasdaq-company-news.json", "utf8"));

/** The fixture with its first item (disclosureId 1465411, Iceland) changed. */
function withFirstItem(change: (item: Record<string, unknown>) => void): unknown {
  const body = fixture();
  change(body.results.item[0]);
  return body;
}

/** The fixture with its first Helsinki item (disclosureId 1465405, Framery) changed. */
function withHelsinkiItem(change: (item: Record<string, unknown>) => void): unknown {
  const body = fixture();
  const item = body.results.item.find((i: any) => i.disclosureId === 1465405);
  change(item);
  return body;
}

describe("parseNewsPage", () => {
  it("keeps the six in-scope markets and drops Baltic and Icelandic items", async () => {
    const page = await parseNewsPage(fixture());
    expect(page.itemCount).toBe(200);
    // Helsinki 48 + Stockholm 61 + Copenhagen 36 + First North Finland 9, Sweden 20, Denmark 3.
    expect(page.rows).toHaveLength(177);
    expect(new Set(page.rows.map((r) => r.market))).toEqual(IN_SCOPE_MARKETS);
  });

  it("uses labels that occur in the real response", () => {
    const markets = new Set(fixture().results.item.map((i: any) => i.market));
    for (const m of IN_SCOPE_MARKETS) expect(markets).toContain(m);
  });

  it("maps every field and converts times to UTC ISO strings", async () => {
    const body = fixture();
    const raw = body.results.item.find((i: any) => i.disclosureId === 1465405);
    const row = (await parseNewsPage(body)).rows.find((r) => r.disclosureId === 1465405);
    expect(row).toEqual({
      disclosureId: 1465405,
      company: "Framery Group Oyj",
      market: "Main Market, Helsinki",
      category: "Changes in company's own shares",
      categoryId: 69,
      headline: "Framery Group Plc: Acquisition of own shares during week 39, 2026",
      language: "en",
      languages: ["fi", "en"],
      messageUrl: "https://view.news.eu.nasdaq.com/view?id=b68443eccbc0c1aa211e3de8ea967a8ce&lang=en&src=listed",
      releasedAt: "2026-09-25T17:00:00.000Z",
      publishedAt: "2026-09-25T17:00:00.000Z",
      rawHash: createHash("sha256").update(canonicalJson(raw)).digest("hex"),
      source: NEWS_SOURCE,
    });
  });

  it("keeps the newest-first order", async () => {
    const released = (await parseNewsPage(fixture())).rows.map((r) => r.releasedAt);
    expect([...released].sort().reverse()).toEqual(released);
  });

  it("hashes the canonical JSON, so key order does not matter", async () => {
    const reordered = fixture();
    reordered.results.item = reordered.results.item.map((i: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(i).reverse()),
    );
    const a = await parseNewsPage(fixture());
    const b = await parseNewsPage(reordered);
    expect(b.rows.map((r) => r.rawHash)).toEqual(a.rows.map((r) => r.rawHash));
    expect(new Set(a.rows.map((r) => r.rawHash)).size).toBe(a.rows.length);
  });

  it("matches the settings canonical JSON", () => {
    for (const item of fixture().results.item) expect(canonicalJson(item)).toBe(settingsCanonicalJson(item));
  });

  it.each([
    ["disclosureId missing", (i: any) => delete i.disclosureId, /disclosureId/],
    ["disclosureId as a string", (i: any) => (i.disclosureId = "1465411"), /disclosureId/],
    ["disclosureId fractional", (i: any) => (i.disclosureId = 1.5), /disclosureId/],
    ["headline missing", (i: any) => delete i.headline, /headline/],
    ["headline empty", (i: any) => (i.headline = " "), /headline/],
    ["releaseTime missing", (i: any) => delete i.releaseTime, /releaseTime/],
    ["releaseTime as a number", (i: any) => (i.releaseTime = 1790000000), /releaseTime/],
    ["releaseTime in ISO form", (i: any) => (i.releaseTime = "2026-09-26T09:19:50Z"), /not YYYY-MM-DD HH:mm:ss/],
    ["releaseTime without seconds", (i: any) => (i.releaseTime = "2026-09-26 09:19"), /not YYYY-MM-DD HH:mm:ss/],
    ["releaseTime impossible", (i: any) => (i.releaseTime = "2026-02-30 09:19:50"), /not a real time/],
    ["published malformed", (i: any) => (i.published = "26.09.2026 09:19:50"), /not YYYY-MM-DD HH:mm:ss/],
    ["market missing", (i: any) => delete i.market, /market/],
    ["categoryId as a string", (i: any) => (i.categoryId = "436"), /categoryId/],
    ["languages not a list", (i: any) => (i.languages = "en"), /languages/],
  ])("throws on an in-scope item with %s", async (_name, change, error) => {
    await expect(parseNewsPage(withHelsinkiItem(change))).rejects.toThrow(error);
  });

  it("validates out-of-scope items too", async () => {
    await expect(parseNewsPage(withFirstItem((i) => delete i.headline))).rejects.toThrow(/headline/);
  });

  it("stores null for optional fields that are absent", async () => {
    const body = withHelsinkiItem((i) => {
      delete i.company;
      delete i.published;
      i.languages = null;
    });
    const row = (await parseNewsPage(body)).rows.find((r) => r.disclosureId === 1465405);
    expect(row).toMatchObject({ company: null, publishedAt: null, languages: null });
  });

  it("throws on a repeated disclosureId", async () => {
    const body = fixture();
    body.results.item.push({ ...body.results.item[5] });
    await expect(parseNewsPage(body)).rejects.toThrow(/appears twice/);
  });

  it.each([
    ["null", null],
    ["no results", { count: 0 }],
    ["results.item not an array", { results: { item: {} } }],
  ])("throws on a response with %s", async (_name, body) => {
    await expect(parseNewsPage(body)).rejects.toThrow(/unexpected response shape/);
  });

  it("accepts an empty page", async () => {
    expect(await parseNewsPage({ results: { item: [] }, count: 0 })).toEqual({ itemCount: 0, rows: [] });
  });
});

describe("utcIso", () => {
  it("reads the time as UTC", () => {
    expect(utcIso("2026-09-26 09:19:50")).toBe("2026-09-26T09:19:50.000Z");
    expect(utcIso("2026-12-31 23:59:59")).toBe("2026-12-31T23:59:59.000Z");
  });

  it.each(["2026-09-26 24:00:00", "2026-13-01 00:00:00", " 2026-09-26 09:19:50", ""])("rejects %j", (raw) => {
    expect(() => utcIso(raw)).toThrow();
  });
});

describe("newsQueryUrl", () => {
  it("asks for UTC times, newest first, one page at the given offset", () => {
    const url = new URL(newsQueryUrl(400));
    expect(url.searchParams.get("timeZone")).toBe("UTC");
    expect(url.searchParams.get("dateMask")).toBe("yyyy-MM-dd HH:mm:ss");
    expect(url.searchParams.get("dir")).toBe("DESC");
    expect(url.searchParams.get("globalGroup")).toBe("companyNews");
    expect(url.searchParams.get("limit")).toBe(String(PAGE_SIZE));
    expect(url.searchParams.get("start")).toBe("400");
  });

  it("rejects a bad offset", () => {
    expect(() => newsQueryUrl(-200)).toThrow();
    expect(() => newsQueryUrl(1.5)).toThrow();
  });
});

describe("decideNextPage", () => {
  const ids = [105, 104, 103, 102, 101];
  const full = { itemCount: PAGE_SIZE };

  it("stops when the page overlaps stored items", () => {
    expect(decideNextPage({ ...full, pageIds: ids, storedIds: new Set([101, 50]), pagesFetched: 1 })).toEqual({
      fetchNext: false,
      gap: false,
    });
  });

  it("continues while every item on the page is new", () => {
    expect(decideNextPage({ ...full, pageIds: ids, storedIds: new Set([50]), pagesFetched: 1 })).toEqual({
      fetchNext: true,
      gap: false,
    });
  });

  it("stops at the page cap and reports a gap when nothing overlapped", () => {
    expect(decideNextPage({ ...full, pageIds: ids, storedIds: new Set(), pagesFetched: MAX_PAGES })).toEqual({
      fetchNext: false,
      gap: true,
    });
  });

  it("does not report a gap when the last allowed page overlaps", () => {
    expect(decideNextPage({ ...full, pageIds: ids, storedIds: new Set([103]), pagesFetched: MAX_PAGES })).toEqual({
      fetchNext: false,
      gap: false,
    });
  });

  it("stops without a gap at the end of the feed", () => {
    expect(decideNextPage({ pageIds: ids, storedIds: new Set(), itemCount: 37, pagesFetched: 2 })).toEqual({
      fetchNext: false,
      gap: false,
    });
  });

  it("continues past a full page with no in-scope items", () => {
    expect(decideNextPage({ ...full, pageIds: [], storedIds: new Set([1]), pagesFetched: 1 })).toEqual({
      fetchNext: true,
      gap: false,
    });
  });

  it("walks a simulated backlog: pages 1 and 2 new, page 3 overlaps", () => {
    const stored = new Set([7, 8, 9]);
    const pages = [[20, 19, 18], [17, 16, 15], [14, 9, 8]];
    const decisions = pages.map((pageIds, i) =>
      decideNextPage({ ...full, pageIds, storedIds: stored, pagesFetched: i + 1, pageSize: PAGE_SIZE }),
    );
    expect(decisions.map((d) => d.fetchNext)).toEqual([true, true, false]);
    expect(decisions.some((d) => d.gap)).toBe(false);
  });

  it("works on the fixture: a first run with an empty table would page on", async () => {
    const page = await parseNewsPage(fixture());
    const pageIds = page.rows.map((r) => r.disclosureId);
    expect(decideNextPage({ pageIds, storedIds: new Set(), itemCount: page.itemCount, pagesFetched: 1 }).fetchNext).toBe(true);
    const again = decideNextPage({ pageIds, storedIds: new Set(pageIds.slice(-1)), itemCount: page.itemCount, pagesFetched: 1 });
    expect(again).toEqual({ fetchNext: false, gap: false });
  });
});

describe("parseTrigger", () => {
  it("reads the trigger the schedule sends", () => {
    expect(parseTrigger('{"trigger": "schedule"}')).toBe("schedule");
    expect(parseTrigger('{"trigger": "cutoff"}')).toBe("cutoff");
  });

  it("treats an empty body or no trigger as manual", () => {
    expect(parseTrigger("")).toBe("manual");
    expect(parseTrigger("{}")).toBe("manual");
  });

  it.each(['{"trigger": "hourly"}', '{"trigger": 1}', "[]", "null", "not json"])("rejects %s", (body) => {
    expect(() => parseTrigger(body)).toThrow();
  });
});
