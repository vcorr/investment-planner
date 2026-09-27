import { COMPANY_ALIASES, type CompanyAlias } from "./aliases.js";
import { companyKey, newsMarket, type Exchange } from "./names.js";

// Links announcements to listings by company name and market (brief §8.3). The API has no ISIN (V23).
// Rules, in order:
//   1. The announcement's market label gives the exchange (HEL, STO, CPH). The segment is not used, because
//      the label and the share list disagree for some issuers (Calviks and Verve Group Media are announced
//      under "Main Market, Stockholm" but listed on First North).
//   2. Every listing on that exchange whose `companyKey` equals the announcement's links, so a company with
//      several share classes links to all of them. Method `exact` when the raw names are identical,
//      otherwise `normalised`.
//      If nothing matches and the name has a comma, the part before the first comma is tried the same way:
//      the API writes some Swedish names in register order ("Ericsson, Telefonab. L M",
//      "Kinnevik, Investment AB", "Hennes & Mauritz AB, H & M"; seen in the live API on 2026-09-27).
//   3. An alias (aliases.ts) adds its listings with method `alias`.
//   4. Each linked listing's ISIN then links the same share on the other exchanges (`via: "same_isin"`),
//      because a cross-listed company announces under one market only: Sampo's news carries
//      "Main Market, Stockholm", but the share we trade is Sampo in Helsinki.
// Nothing is forced: an announcement with no match is returned unlinked with a reason and kept for
// sector and macro use.

export interface LinkableListing {
  orderbookId: string;
  /** The share list's `fullName`, e.g. "Kesko Oyj B". */
  fullName: string;
  isin: string;
  market: Exchange;
  segment: "MAIN_MARKET" | "FIRST_NORTH";
}

export interface LinkableItem {
  disclosureId: number;
  company: string | null;
  /** The API's market label, e.g. "Main Market, Helsinki". */
  market: string;
}

export type LinkMethod = "exact" | "normalised" | "alias";
/** `market`: on the exchange the announcement names. `same_isin`: the same share cross-listed elsewhere. */
export type LinkVia = "market" | "same_isin";

export interface NewsLink {
  disclosureId: number;
  orderbookId: string;
  method: LinkMethod;
  /** The listing's `fullName` that matched. */
  matchedName: string;
  via: LinkVia;
}

export type UnlinkedReason = "no_company" | "market_out_of_scope" | "no_match";

export interface LinkResult {
  disclosureId: number;
  links: NewsLink[];
  /** Set when `links` is empty. */
  unlinked: UnlinkedReason | null;
}

export interface Linker {
  link(item: LinkableItem): LinkResult;
}

export function createLinker(listings: readonly LinkableListing[], aliases: readonly CompanyAlias[] = COMPANY_ALIASES): Linker {
  const byKey = new Map<string, LinkableListing[]>();
  const byIsin = new Map<string, LinkableListing[]>();
  const byName = new Map<string, LinkableListing[]>();
  const byId = new Map<string, LinkableListing>();
  for (const listing of listings) {
    if (byId.has(listing.orderbookId)) throw new Error(`Linker: orderbook ${listing.orderbookId} appears twice`);
    byId.set(listing.orderbookId, listing);
    const key = companyKey(listing.fullName);
    if (key === null) throw new Error(`Linker: listing ${listing.orderbookId} has no usable name "${listing.fullName}"`);
    push(byKey, `${listing.market}|${key}`, listing);
    push(byIsin, listing.isin, listing);
    push(byName, `${listing.market}|${listing.fullName}`, listing);
  }

  const aliasListings = new Map<string, LinkableListing[]>();
  for (const alias of aliases) {
    for (const name of alias.fullNames) {
      const found = byName.get(`${alias.exchange}|${name}`);
      if (found === undefined) throw new Error(`Linker: alias for "${alias.company}" names "${name}", which is not listed on ${alias.exchange}`);
      for (const listing of found) push(aliasListings, `${alias.exchange}|${alias.company}`, listing);
    }
  }

  return {
    link(item: LinkableItem): LinkResult {
      const { disclosureId, company } = item;
      const market = newsMarket(item.market);
      if (market === null) return { disclosureId, links: [], unlinked: "market_out_of_scope" };
      const key = company === null ? null : companyKey(company);
      if (company === null || key === null) return { disclosureId, links: [], unlinked: "no_company" };

      let matches = byKey.get(`${market.exchange}|${key}`) ?? [];
      if (matches.length === 0 && company.includes(",")) {
        const head = companyKey(company.slice(0, company.indexOf(",")));
        if (head !== null) matches = byKey.get(`${market.exchange}|${head}`) ?? [];
      }
      const direct = new Map<string, NewsLink>();
      for (const listing of matches) {
        const method: LinkMethod = listing.fullName === company ? "exact" : "normalised";
        direct.set(listing.orderbookId, { disclosureId, orderbookId: listing.orderbookId, method, matchedName: listing.fullName, via: "market" });
      }
      for (const listing of aliasListings.get(`${market.exchange}|${company}`) ?? []) {
        if (direct.has(listing.orderbookId)) continue;
        direct.set(listing.orderbookId, { disclosureId, orderbookId: listing.orderbookId, method: "alias", matchedName: listing.fullName, via: "market" });
      }

      const links = [...direct.values()];
      const all = new Set(direct.keys());
      for (const link of [...direct.values()]) {
        for (const sibling of byIsin.get(byId.get(link.orderbookId)!.isin) ?? []) {
          if (all.has(sibling.orderbookId)) continue;
          all.add(sibling.orderbookId);
          links.push({ disclosureId, orderbookId: sibling.orderbookId, method: link.method, matchedName: sibling.fullName, via: "same_isin" });
        }
      }
      return { disclosureId, links, unlinked: links.length === 0 ? "no_match" : null };
    },
  };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

// ---- Report -----------------------------------------------------------------------------------------------

export interface MarketLinkStats {
  /** The API's market label. */
  market: string;
  items: number;
  linked: number;
  /** linked / items. */
  rate: number;
  /** Distinct unmatched company names, sorted. */
  unmatched: string[];
}

/** Match rate per in-scope market label, for the PR and the daily report. Out-of-scope items are left out. */
export function linkStats(items: readonly LinkableItem[], results: readonly LinkResult[]): MarketLinkStats[] {
  if (items.length !== results.length) throw new Error("linkStats: items and results differ in length");
  const stats = new Map<string, { items: number; linked: number; unmatched: Set<string> }>();
  items.forEach((item, i) => {
    const result = results[i]!;
    if (result.disclosureId !== item.disclosureId) throw new Error(`linkStats: result ${i} is for another item`);
    if (result.unlinked === "market_out_of_scope") return;
    let entry = stats.get(item.market);
    if (entry === undefined) stats.set(item.market, (entry = { items: 0, linked: 0, unmatched: new Set() }));
    entry.items += 1;
    if (result.links.length > 0) entry.linked += 1;
    else entry.unmatched.add(item.company ?? "(no company)");
  });
  return [...stats.entries()]
    .map(([market, s]) => ({ market, items: s.items, linked: s.linked, rate: s.linked / s.items, unmatched: [...s.unmatched].sort() }))
    .sort((a, b) => (a.market < b.market ? -1 : a.market > b.market ? 1 : 0));
}
