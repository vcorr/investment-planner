import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { newsLinks } from "../src/db/tables/news-links.js";
import { admissibleItems, decisionCutoff, isAdmissible } from "../src/news/admissibility.js";
import { COMPANY_ALIASES } from "../src/news/aliases.js";
import { DEDUP_THRESHOLDS, flagDuplicates, type DedupItem } from "../src/news/dedup.js";
import { createLinker, linkStats, type LinkableItem, type LinkableListing } from "../src/news/linking.js";
import { companyKey } from "../src/news/names.js";
import { noveltyMove, sessionCloseUtc, type CloseBar } from "../src/news/novelty.js";
import { zonedTimeToUtc } from "../src/news/time.js";
import { utcIso } from "../supabase/functions/_shared/nasdaq-news.js";

// Real announcements (24-26 Sep 2026, V24) and the real share lists (1,082 shares, fetched 2026-09-27).
interface RawNews {
  disclosureId: number;
  company: string | null;
  market: string;
  headline: string;
  language: string | null;
  releaseTime: string;
}
const news: RawNews[] = JSON.parse(readFileSync("test/fixtures/nasdaq-company-news.json", "utf8")).results.item;
const shares: LinkableListing[] = JSON.parse(readFileSync("test/fixtures/nasdaq-share-lists.json", "utf8")).shares;
const linker = createLinker(shares);

const item = (id: number): RawNews => {
  const found = news.find((n) => n.disclosureId === id);
  if (found === undefined) throw new Error(`fixture has no disclosureId ${id}`);
  return found;
};
const orderbooks = (i: LinkableItem): string[] => linker.link(i).links.map((l) => l.orderbookId).sort();
const orderbookOf = (market: string, fullName: string): string => {
  const found = shares.filter((s) => s.market === market && s.fullName === fullName);
  if (found.length !== 1) throw new Error(`share list has ${found.length} rows for ${market} ${fullName}`);
  return found[0]!.orderbookId;
};

describe("companyKey", () => {
  it("removes legal forms and share classes, folds case, accents and punctuation", () => {
    expect(companyKey("Besqab AB(publ)")).toBe("besqab");
    expect(companyKey("Bure Equity  AB")).toBe("bure equity");
    expect(companyKey("Industrivärden, AB")).toBe("industrivarden");
    expect(companyKey("Kesko Oyj B")).toBe("kesko");
    expect(companyKey("A.P. Møller - Mærsk B")).toBe("a p moller maersk");
    expect(companyKey("Raisio Oyj Vaihto-osake")).toBe("raisio");
    expect(companyKey("AS Tallink Grupp FDR")).toBe("tallink grupp");
    expect(companyKey("Fortinova Fastigheter ser. B")).toBe("fortinova fastigheter");
    expect(companyKey("Vestas Wind Systems A/S")).toBe("vestas wind systems");
    expect(companyKey("Eolus Aktiebolag")).toBe("eolus");
  });

  it("never removes the last word, and gives null for a name without letters or digits", () => {
    expect(companyKey("AB")).toBe("ab");
    expect(companyKey("JM AB")).toBe("jm");
    expect(companyKey(" – ")).toBeNull();
  });
});

describe("linking on the real fixture", () => {
  const inScope = news.filter((n) => linker.link(n).unlinked !== "market_out_of_scope");
  const stats = linkStats(news, news.map((n) => linker.link(n)));
  const rate = (market: string): number => stats.find((s) => s.market === market)!.rate;

  it("covers the 177 in-scope items and leaves the 23 Baltic and Icelandic items out", () => {
    expect(inScope).toHaveLength(177);
    expect(stats.reduce((s, m) => s + m.items, 0)).toBe(177);
  });

  // Every unmatched Main Market item comes from an issuer with no share on the lists: bond and mortgage
  // issuers, investment funds, an ETF manager and a central bank (checked by hand against the share lists).
  // The minimums sit just under the fixture's rates (47/48, 51/61, 15/36), so losing one real match fails.
  it("meets the minimum Main Market match rates", () => {
    expect(rate("Main Market, Helsinki")).toBeGreaterThanOrEqual(0.97);
    expect(rate("Main Market, Stockholm")).toBeGreaterThanOrEqual(0.83);
    expect(rate("Main Market, Copenhagen")).toBeGreaterThanOrEqual(0.41);
  });

  it("leaves unmatched exactly the issuers that have no listed share", () => {
    const unmatched = Object.fromEntries(stats.map((s) => [s.market, s.unmatched]));
    expect(unmatched).toEqual({
      "Main Market, Helsinki": ["Seligson & Co Rahastoyhtiö Oyj"],
      "Main Market, Stockholm": [
        "0to9 AB",
        "Arwidsro Fastighets AB (publ)",
        "Conapto Holding AB",
        "Dura Sverige AB",
        "Holmström Fastigheter Holding AB",
        "Keystone Academic Solutions AS",
        "Morgan Stanley B.V",
        "Point Properties Portfolio 1 AB",
        "Royal Bank of Canada",
        "Sveriges Riksbank",
      ],
      "Main Market, Copenhagen": [
        "BI Erhvervsejendomme A/S",
        "DLR Kredit A/S",
        "Danske Invest",
        "Investeringsforeningen BankInvest",
        "Investeringsforeningen Maj Invest",
        "Investeringsforeningen Wealth Invest",
        "Jyske Realkredit A/S",
        "Kapitalforeningen BLS Invest",
        "Kapitalforeningen Wealth Invest",
        "Nordea Kredit Realkreditaktieselskab",
        "Nykredit Realkredit A/S",
        "Realkredit Danmark A/S",
        "Sparinvest SICAV",
        "Totalkredit A/S",
      ],
      "First North Finland": [],
      "First North Sweden": ["Pro Kapital Grupp", "Åhléns Group AB"],
      "First North Denmark": [],
    });
  });

  it("keeps unmatched items with a reason and never forces a near name", () => {
    const riksbank = linker.link(item(1465269));
    expect(riksbank).toEqual({ disclosureId: 1465269, links: [], unlinked: "no_match" });
    // Mortgage banks must not fall onto the listed banks with a similar name.
    expect(linker.link(item(1465133)).links).toEqual([]); // Nordea Kredit, not Nordea Bank
    expect(linker.link(item(1465308)).links).toEqual([]); // Jyske Realkredit, not Jyske Bank
  });

  it("reports out-of-scope markets and missing company names", () => {
    expect(linker.link(item(1465411)).unlinked).toBe("market_out_of_scope"); // Iceland
    expect(linker.link({ disclosureId: 1, company: null, market: "Main Market, Helsinki" }).unlinked).toBe("no_company");
  });

  it("marks a raw-name match as exact and a rule match as normalised", () => {
    expect(linker.link(item(1465096)).links).toEqual([
      { disclosureId: 1465096, orderbookId: orderbookOf("STO", "ABB Ltd"), method: "exact", matchedName: "ABB Ltd", via: "market" },
    ]);
    const fortum = linker.link(item(1465293)).links;
    expect(fortum.map((l) => [l.method, l.matchedName])).toEqual([["normalised", "Fortum Oyj"]]);
  });
});

describe("multi-class companies", () => {
  it("links a company to every share class on its market", () => {
    expect(orderbooks(item(1465193))).toEqual([orderbookOf("HEL", "Kesko Oyj A"), orderbookOf("HEL", "Kesko Oyj B")].sort());
    expect(orderbooks(item(1465267))).toEqual([orderbookOf("STO", "NCC A"), orderbookOf("STO", "NCC B")].sort());
    expect(orderbooks(item(1465264))).toEqual([orderbookOf("STO", "Industrivärden A"), orderbookOf("STO", "Industrivärden C")].sort());
  });

  // Company names as the live API writes them (fetched through a scraper on 2026-09-27); not in the fixture.
  it("links Volvo and Ericsson to both classes, and not Volvo Car", () => {
    const volvo = { disclosureId: 2, company: "Volvo, AB", market: "Main Market, Stockholm" };
    expect(orderbooks(volvo)).toEqual([orderbookOf("STO", "Volvo A"), orderbookOf("STO", "Volvo B")].sort());
    const ericsson = { disclosureId: 3, company: "Ericsson, Telefonab. L M", market: "Main Market, Stockholm" };
    expect(orderbooks(ericsson)).toEqual([orderbookOf("STO", "Ericsson A"), orderbookOf("STO", "Ericsson B")].sort());
    const hm = { disclosureId: 4, company: "Hennes & Mauritz AB, H & M", market: "Main Market, Stockholm" };
    expect(orderbooks(hm)).toEqual([orderbookOf("STO", "Hennes & Mauritz B")]);
    const volvoCar = { disclosureId: 5, company: "Volvo Car AB", market: "Main Market, Stockholm" };
    expect(orderbooks(volvoCar)).toEqual([orderbookOf("STO", "Volvo Car B")]);
  });

  it("links a cross-listed share on its other exchanges through the ISIN", () => {
    // Sampo's announcement carries "Main Market, Stockholm"; the development sample trades Sampo in Helsinki.
    const links = linker.link(item(1465247)).links;
    expect(links.map((l) => [shares.find((s) => s.orderbookId === l.orderbookId)!.market, l.via])).toEqual([
      ["STO", "market"],
      ["HEL", "same_isin"],
      ["CPH", "same_isin"],
    ]);
    expect(links.map((l) => l.orderbookId)).toContain("TX50094"); // Sampo Oyj A, Helsinki (sample-prices.json)
  });
});

describe("aliases", () => {
  it("every alias names listings that exist on its exchange", () => {
    for (const alias of COMPANY_ALIASES) {
      for (const name of alias.fullNames) expect(orderbookOf(alias.exchange, name)).toBeTruthy();
      expect(alias.why.length).toBeGreaterThan(20);
    }
  });

  it("links D/S Norden by alias", () => {
    expect(linker.link(item(1465252)).links).toEqual([
      { disclosureId: 1465252, orderbookId: orderbookOf("CPH", "D/S Norden"), method: "alias", matchedName: "D/S Norden", via: "market" },
    ]);
  });

  it("refuses an alias that names a missing listing", () => {
    expect(() => createLinker(shares, [{ exchange: "HEL", company: "X", fullNames: ["No Such Oyj"], why: "test" }])).toThrow(/not listed on HEL/);
  });
});

describe("flagDuplicates", () => {
  const asDedup = (n: RawNews): DedupItem => ({
    disclosureId: n.disclosureId,
    company: n.company,
    headline: n.headline,
    language: n.language,
    releasedAt: new Date(utcIso(n.releaseTime)),
  });
  const results = flagDuplicates(news.map(asDedup));
  const of = (id: number) => results.find((r) => r.disclosureId === id)!;

  it("flags 25 duplicates in the fixture and returns one result per item, in order", () => {
    expect(results.map((r) => r.disclosureId)).toEqual(news.map((n) => n.disclosureId));
    expect(results.filter((r) => r.duplicateOf !== null)).toHaveLength(25);
  });

  it("flags the same release in two or three languages, with the English item as primary on a tie", () => {
    expect(of(1465266)).toEqual({ disclosureId: 1465266, duplicateOf: 1465265, reasons: ["translation"] }); // Besqab sv -> en
    expect(of(1465265).duplicateOf).toBeNull();
    expect(of(1465161).duplicateOf).toBe(1465160); // Viking Line sv
    expect(of(1465162).duplicateOf).toBe(1465160); // Viking Line fi
    // Nordea Kredit No. 85: the Danish item has the lower ID, but the English one is primary.
    expect(of(1465290).duplicateOf).toBe(1465291);
  });

  it("keeps a company's separate releases apart", () => {
    // Konecranes: financial targets at 15:45 and a buy-back at 15:50, each in Finnish and English.
    expect(of(1465199).duplicateOf).toBe(1465200);
    expect(of(1465201).duplicateOf).toBe(1465202);
    expect(of(1465200).duplicateOf).toBeNull();
    // QPR Software: five managers' transactions at the same second, headlines differing only by name.
    for (const id of [1465312, 1465313, 1465314, 1465315, 1465317]) expect(of(id).reasons).toEqual([]);
    // Copenhagen Capital: two identical "Storaktionærmeddelelse" headlines 94 s apart, beyond the 60 s window.
    expect(of(1465166).reasons).toEqual([]);
    expect(of(1465167).reasons).toEqual([]);
  });

  it("flags one release posted under two markets", () => {
    // Pro Kapital Grupp, Tallinn (1465275) and First North Sweden (1465274), same second, same headline.
    expect(of(1465275)).toEqual({ disclosureId: 1465275, duplicateOf: 1465274, reasons: ["same_headline"] });
  });

  it("flags a corrected reissue within the window, with the original as primary", () => {
    const correction = asDedup(item(1465101)); // "Correction: Oriola Corporation: Notification of a change in shareholding"
    const original = { ...correction, disclosureId: 1, headline: correction.headline.replace(/^Correction: /, "") };
    const hours = (h: number) => ({ ...original, releasedAt: new Date(correction.releasedAt.getTime() - h * 3_600_000) });
    expect(flagDuplicates([correction, hours(24)])).toEqual([
      { disclosureId: 1465101, duplicateOf: 1, reasons: ["correction"] },
      { disclosureId: 1, duplicateOf: null, reasons: ["correction"] },
    ]);
    expect(flagDuplicates([correction, hours(DEDUP_THRESHOLDS.correctionWindowHours)])[0]!.duplicateOf).toBe(1);
    expect(flagDuplicates([correction, hours(DEDUP_THRESHOLDS.correctionWindowHours + 1)])[0]!.duplicateOf).toBeNull();
  });

  it("does not pair translations when two releases in two languages share one second", () => {
    const at = new Date("2026-09-24T12:45:00.000Z");
    const burst = [1465199, 1465200, 1465201, 1465202].map((id) => ({ ...asDedup(item(id)), releasedAt: at }));
    expect(flagDuplicates(burst).every((r) => r.duplicateOf === null)).toBe(true);
  });

  it("treats headlines with different numbers as different releases", () => {
    const a = asDedup(item(1465133)); // "No. 84, 2026 - Fixing of coupons ..."
    const b = { ...a, disclosureId: 2, headline: a.headline.replace("No. 84", "No. 85") };
    expect(flagDuplicates([a, b]).every((r) => r.duplicateOf === null)).toBe(true);
    // One number is the only change (word similarity 17/19 = 0.89): with the similarity bar lowered to 0.8,
    // the number rule alone keeps them apart.
    const c = asDedup(item(1465101));
    const d = { ...c, disclosureId: 3, headline: c.headline.replace("Section 10", "Section 11") };
    const loose = { ...DEDUP_THRESHOLDS, minHeadlineJaccard: 0.8 };
    expect(flagDuplicates([c, d], loose).every((r) => r.duplicateOf === null)).toBe(true);
    // Same numbers: paired (the lower disclosure ID, 3, is primary on the tie).
    expect(flagDuplicates([c, { ...d, headline: c.headline.replace("Section", "section") }], loose)[0]!.duplicateOf).toBe(3);
  });
});

describe("admissibility", () => {
  const cutoff = decisionCutoff("2026-09-28"); // 09:15 EEST = 06:15 UTC
  const t = (iso: string) => new Date(iso);

  it("builds the cut-off in Helsinki time", () => {
    expect(cutoff.toISOString()).toBe("2026-09-28T06:15:00.000Z");
  });

  it("admits only items both released and fetched strictly before the cut-off", () => {
    const before = t("2026-09-28T06:14:59.999Z");
    const at = t("2026-09-28T06:15:00.000Z");
    const after = t("2026-09-28T06:20:00.000Z");
    expect(isAdmissible({ releasedAt: before, fetchedAt: before }, cutoff)).toBe(true);
    expect(isAdmissible({ releasedAt: at, fetchedAt: before }, cutoff)).toBe(false);
    expect(isAdmissible({ releasedAt: before, fetchedAt: at }, cutoff)).toBe(false);
    // Released before T but first fetched after it: a back-dated release time must not leak in.
    expect(isAdmissible({ releasedAt: before, fetchedAt: after }, cutoff)).toBe(false);
    expect(isAdmissible({ releasedAt: after, fetchedAt: before }, cutoff)).toBe(false);
    // The API's separate publication time, when present, must also be before T.
    expect(isAdmissible({ releasedAt: before, fetchedAt: before, publishedAt: null }, cutoff)).toBe(true);
    expect(isAdmissible({ releasedAt: before, fetchedAt: before, publishedAt: at }, cutoff)).toBe(false);
  });

  it("filters rows and keeps their order", () => {
    const rows = [
      { id: 1, releasedAt: t("2026-09-27T20:00:00Z"), fetchedAt: t("2026-09-28T00:00:00Z") },
      { id: 2, releasedAt: t("2026-09-28T06:00:00Z"), fetchedAt: t("2026-09-28T06:15:00Z") },
      { id: 3, releasedAt: t("2026-09-28T05:00:00Z"), fetchedAt: t("2026-09-28T05:01:00Z") },
    ];
    expect(admissibleItems(rows, cutoff).map((r) => r.id)).toEqual([1, 3]);
  });

  it("throws on an invalid time rather than guessing", () => {
    expect(() => isAdmissible({ releasedAt: new Date("nope"), fetchedAt: cutoff }, cutoff)).toThrow(/releasedAt/);
  });

  it("follows daylight saving: UTC+2 in winter, UTC+3 in summer (EU changes on 29 Mar and 25 Oct 2026)", () => {
    expect(decisionCutoff("2026-03-27").toISOString()).toBe("2026-03-27T07:15:00.000Z");
    expect(decisionCutoff("2026-03-29").toISOString()).toBe("2026-03-29T06:15:00.000Z");
    expect(decisionCutoff("2026-03-30").toISOString()).toBe("2026-03-30T06:15:00.000Z");
    expect(decisionCutoff("2026-10-23").toISOString()).toBe("2026-10-23T06:15:00.000Z");
    expect(decisionCutoff("2026-10-25").toISOString()).toBe("2026-10-25T07:15:00.000Z");
    expect(decisionCutoff("2026-10-26").toISOString()).toBe("2026-10-26T07:15:00.000Z");
  });

  it("refuses wall-clock times that are skipped or repeated, and bad dates", () => {
    expect(() => zonedTimeToUtc("2026-03-29", "03:30", "Europe/Helsinki")).toThrow(/does not exist/);
    expect(() => zonedTimeToUtc("2026-10-25", "03:30", "Europe/Helsinki")).toThrow(/happens twice/);
    expect(() => decisionCutoff("2026-02-30")).toThrow(/not a real date/);
    expect(() => decisionCutoff("2026-09-28", "9:15")).toThrow(/HH:MM/);
  });
});

describe("novelty", () => {
  // Synthetic Helsinki bars. Sessions close at 18:30 EEST = 15:30 UTC.
  const share: CloseBar[] = [
    { tradeDate: "2026-09-21", close: 10.0 },
    { tradeDate: "2026-09-22", close: 10.5 },
    { tradeDate: "2026-09-23", close: 11.0 },
    { tradeDate: "2026-09-24", close: 11.55 },
    { tradeDate: "2026-09-25", close: 99.0 }, // must never be used: its session closes after every cut-off below
  ];
  const p1: CloseBar[] = [
    { tradeDate: "2026-09-22", close: 20.0 },
    { tradeDate: "2026-09-23", close: 21.0 },
    { tradeDate: "2026-09-24", close: 22.0 },
  ];
  const p2: CloseBar[] = [
    { tradeDate: "2026-09-22", close: 40.0 },
    { tradeDate: "2026-09-23", close: 38.0 },
    { tradeDate: "2026-09-24", close: 38.0 },
  ];
  const p3: CloseBar[] = [{ tradeDate: "2026-09-23", close: 5.0 }]; // no close on 22 Sep: left out
  const exchangeBars = new Map([
    ["S", share],
    ["P1", p1],
    ["P2", p2],
    ["P3", p3],
  ]);
  const base = { exchange: "HEL" as const, orderbookId: "S", bars: share, exchangeBars, halfDays: new Set<string>() };

  it("measures an item released during a session from the previous close to that day's close", () => {
    // Released Wed 23 Sep 12:00 Helsinki; cut-off Thu 24 Sep 09:15. Window: close 22 Sep -> close 23 Sep.
    // Share 11.00 / 10.50 - 1 = 1/21 = 0.047619...; exchange mean of P1 +0.05 and P2 -0.05 = 0.
    const r = noveltyMove({ ...base, releasedAt: new Date("2026-09-23T09:00:00Z"), cutoff: decisionCutoff("2026-09-24") });
    expect(r).toMatchObject({ baseDate: "2026-09-22", endDate: "2026-09-23", peers: 2 });
    if (r.adjustedReturn === null) throw new Error(r.reason);
    expect(r.shareReturn).toBeCloseTo(1 / 21, 12);
    expect(r.exchangeReturn).toBeCloseTo(0, 12);
    expect(r.adjustedReturn).toBeCloseTo(0.047619047619, 12);
  });

  it("measures an item released after the close from that close to the next closes", () => {
    // Released Tue 22 Sep 19:00 Helsinki; cut-off Fri 25 Sep 09:15. Window: close 22 Sep -> close 24 Sep.
    // Share 11.55 / 10.50 - 1 = 0.10; P1 22/20 - 1 = 0.10; P2 38/40 - 1 = -0.05; mean 0.025; adjusted 0.075.
    const r = noveltyMove({ ...base, releasedAt: new Date("2026-09-22T16:00:00Z"), cutoff: decisionCutoff("2026-09-25") });
    expect(r).toMatchObject({ baseDate: "2026-09-22", endDate: "2026-09-24", peers: 2 });
    if (r.adjustedReturn === null) throw new Error(r.reason);
    expect(r.shareReturn).toBeCloseTo(0.1, 12);
    expect(r.exchangeReturn).toBeCloseTo(0.025, 12);
    expect(r.adjustedReturn).toBeCloseTo(0.075, 12);
  });

  it("returns null with a reason when no session has closed since the release", () => {
    // Released Thu 24 Sep 07:00 Helsinki, before the open; the 09:15 cut-off comes before any close.
    const r = noveltyMove({ ...base, releasedAt: new Date("2026-09-24T04:00:00Z"), cutoff: decisionCutoff("2026-09-24") });
    expect(r).toEqual({ adjustedReturn: null, reason: "no session has closed since the release" });
    // Released exactly at the 23 Sep close: that close does not reflect it either.
    const atClose = noveltyMove({ ...base, releasedAt: new Date("2026-09-23T15:30:00Z"), cutoff: decisionCutoff("2026-09-24") });
    expect(atClose.adjustedReturn).toBeNull();
  });

  it("returns null when the bars start after the release, or no peer has both closes", () => {
    const early = noveltyMove({ ...base, releasedAt: new Date("2026-09-20T12:00:00Z"), cutoff: decisionCutoff("2026-09-24") });
    expect(early).toEqual({ adjustedReturn: null, reason: "no close at or before the release in the bars supplied" });
    const alone = noveltyMove({
      ...base,
      exchangeBars: new Map([["P3", p3]]),
      releasedAt: new Date("2026-09-23T09:00:00Z"),
      cutoff: decisionCutoff("2026-09-24"),
    });
    expect(alone.adjustedReturn).toBeNull();
  });

  it("skips days without a close and refuses an item released at or after the cut-off", () => {
    const gappy = share.map((b) => (b.tradeDate === "2026-09-22" ? { ...b, close: null } : b));
    const r = noveltyMove({ ...base, bars: gappy, releasedAt: new Date("2026-09-23T09:00:00Z"), cutoff: decisionCutoff("2026-09-24") });
    // Base falls back to the last actual close (21 Sep); P1 and P2 have no close that day, so no peers.
    expect(r.adjustedReturn).toBeNull();
    const cutoff = decisionCutoff("2026-09-24");
    expect(() => noveltyMove({ ...base, releasedAt: cutoff, cutoff })).toThrow(/not admissible/);
  });

  it("throws on bad bars", () => {
    const run = (bars: CloseBar[]) => noveltyMove({ ...base, bars, releasedAt: new Date("2026-09-23T09:00:00Z"), cutoff: decisionCutoff("2026-09-24") });
    expect(() => run([...share, { tradeDate: "2026-09-21", close: 10 }])).toThrow(/two bars/);
    expect(() => run([{ tradeDate: "2026-09-22", close: 0 }])).toThrow(/close 0/);
  });

  it("uses the sourced closing times, including Stockholm's half days", () => {
    expect(sessionCloseUtc("HEL", "2026-09-23", new Set()).toISOString()).toBe("2026-09-23T15:30:00.000Z");
    expect(sessionCloseUtc("STO", "2026-10-29", new Set()).toISOString()).toBe("2026-10-29T16:30:00.000Z");
    expect(sessionCloseUtc("STO", "2026-10-30", new Set(["2026-10-30"])).toISOString()).toBe("2026-10-30T12:00:00.000Z");
    expect(sessionCloseUtc("CPH", "2026-09-23", new Set()).toISOString()).toBe("2026-09-23T15:00:00.000Z");
    expect(() => sessionCloseUtc("HEL", "2026-10-30", new Set(["2026-10-30"]))).toThrow(/no half trading days/);
  });
});

describe("news_links table", () => {
  it("has the agreed columns, a composite key and row-level security", () => {
    const config = getTableConfig(newsLinks);
    expect(config.name).toBe("news_links");
    expect(config.enableRLS).toBe(true);
    expect(config.columns.map((c) => c.name).sort()).toEqual(
      ["created_at", "disclosure_id", "duplicate_of", "matched_name", "method", "orderbook_id", "via"].sort(),
    );
    expect(config.primaryKeys[0]!.columns.map((c) => c.name)).toEqual(["disclosure_id", "orderbook_id"]);
  });
});
