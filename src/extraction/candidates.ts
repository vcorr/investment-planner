import { z } from "zod";

// The companies the model may name for one announcement: the announcing company's shares plus up to N peers
// from the same ICB industry, taken from the Nasdaq share lists. The model can only choose among these.

/** ASSUMED: enough for spillover without swamping a cheap model; revisit after the live check. */
export const DEFAULT_MAX_PEERS = 10;

/** One row of the Nasdaq screener share lists (`test/fixtures/nasdaq-share-lists.json`). */
export const shareRowSchema = z.object({
  orderbookId: z.string().min(1),
  symbol: z.string().min(1),
  fullName: z.string().min(1),
  isin: z.string().length(12),
  currency: z.string().length(3),
  sector: z.string(),
  market: z.enum(["HEL", "STO", "CPH"]),
  segment: z.enum(["MAIN_MARKET", "FIRST_NORTH"]),
});
export type ShareRow = z.infer<typeof shareRowSchema>;

export interface Candidate {
  isin: string;
  name: string;
  /** Every market the ISIN trades on, in HEL, STO, CPH order. */
  markets: ShareRow["market"][];
  segment: ShareRow["segment"];
  sector: string;
  role: "announcer" | "peer";
}

export interface CandidateOptions {
  maxPeers?: number;
  /**
   * Liquidity per ISIN, e.g. median daily turnover in euros, used to prefer the most traded peers.
   * Shares without a figure rank after those with one. Without the map, peers on the announcer's market come
   * first, then by ISIN, which is deterministic but arbitrary.
   */
  liquidityEur?: ReadonlyMap<string, number>;
}

const MARKET_ORDER: Record<ShareRow["market"], number> = { HEL: 0, STO: 1, CPH: 2 };

/** One entry per ISIN; a share listed on several markets must agree on name, sector and segment. */
function byIsin(shares: readonly ShareRow[]): Map<string, Omit<Candidate, "role">> {
  const out = new Map<string, Omit<Candidate, "role">>();
  for (const s of shares) {
    const existing = out.get(s.isin);
    if (!existing) {
      out.set(s.isin, { isin: s.isin, name: s.fullName, markets: [s.market], segment: s.segment, sector: s.sector });
      continue;
    }
    if (existing.sector !== s.sector) throw new Error(`Share list: ${s.isin} has sectors "${existing.sector}" and "${s.sector}"`);
    if (!existing.markets.includes(s.market)) existing.markets.push(s.market);
    existing.markets.sort((a, b) => MARKET_ORDER[a] - MARKET_ORDER[b]);
  }
  return out;
}

/**
 * Announcer first (in the order given), then peers. Peers share an ICB industry with an announcer share, rank by
 * liquidity (highest first, missing last), then by sharing a market with the announcer, then by ISIN.
 */
export function buildCandidates(linkedIsins: readonly string[], shares: readonly ShareRow[], options: CandidateOptions = {}): Candidate[] {
  const maxPeers = options.maxPeers ?? DEFAULT_MAX_PEERS;
  if (!Number.isInteger(maxPeers) || maxPeers < 0) throw new Error(`Candidates: bad maxPeers ${maxPeers}`);
  if (linkedIsins.length === 0) throw new Error("Candidates: an announcement needs at least one linked share");
  const all = byIsin(shares);
  const linked = [...new Set(linkedIsins)].map((isin) => {
    const share = all.get(isin);
    if (!share) throw new Error(`Candidates: linked ISIN ${isin} is not in the share lists`);
    return share;
  });
  const linkedSet = new Set(linked.map((s) => s.isin));
  const sectors = new Set(linked.map((s) => s.sector).filter((s) => s !== ""));
  const markets = new Set(linked.flatMap((s) => s.markets));
  const liquidity = options.liquidityEur;
  const peers = [...all.values()]
    .filter((s) => !linkedSet.has(s.isin) && sectors.has(s.sector))
    .map((s) => ({ share: s, liq: liquidity?.get(s.isin), sameMarket: s.markets.some((m) => markets.has(m)) }))
    .sort(
      (a, b) =>
        (b.liq ?? -Infinity) - (a.liq ?? -Infinity) ||
        Number(b.sameMarket) - Number(a.sameMarket) ||
        a.share.isin.localeCompare(b.share.isin),
    )
    .slice(0, maxPeers)
    .map((p) => p.share);
  return [...linked.map((s) => ({ ...s, role: "announcer" as const })), ...peers.map((s) => ({ ...s, role: "peer" as const }))];
}
