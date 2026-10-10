import type { Currency } from "../costs/config.js";
import type { FxRate } from "../sources/ecb.js";
import type { Market } from "../sources/nasdaq.js";
import { equalWeightMarketSeries, type MarketReturn } from "./market.js";
import { adjustBars, assertIsoDate, assertValidSeries, barsUpTo, type AdjustmentEvent, type PriceBasis, type PriceSeries } from "./series.js";
import {
  distanceFromHigh,
  eurRateLookup,
  medianTurnoverEur,
  realisedVolatility,
  relativeMomentum,
  volumeAnomaly,
  WINDOWS,
  type MedianTurnover,
  type RealisedVolatility,
  type RelativeMomentum,
  type Signal,
} from "./signals.js";

// All §9 signals for every share in the universe on one date, as one object for the decision packet (§10.1).
// Everything dated after `asOf` is dropped before any computation, so later data cannot leak in.

export interface SnapshotInput {
  /** The date whose close the signals describe, YYYY-MM-DD. */
  asOf: string;
  /** Orderbook IDs. Also the members of each exchange's equal-weight series. */
  universe: readonly string[];
  /** Price series for at least every share in the universe. */
  series: readonly PriceSeries[];
  /** ECB reference rates for SEK and DKK. */
  fxRates: readonly FxRate[];
  /** Dividend and split events. Leave out when there is no source: prices are then used raw, and flagged. */
  adjustments?: readonly AdjustmentEvent[];
}

export interface ShareSignals {
  orderbookId: string;
  market: Market;
  currency: Currency;
  /** Date of the share's latest bar on or before `asOf`; earlier than `asOf` if it did not trade that day. */
  barDate: string | null;
  priceBasis: PriceBasis;
  adjustmentsApplied: number;
  momentum: { d20: RelativeMomentum; d60: RelativeMomentum; d120: RelativeMomentum };
  distanceFrom52WeekHigh: Signal;
  volumeAnomaly: Signal;
  realisedVolatility20: RealisedVolatility;
  medianTurnover60: MedianTurnover;
}

export interface MarketSummary {
  market: Market;
  members: number;
  /** The exchange's last equal-weight return on or before `asOf`, with its member count. */
  latest: MarketReturn | null;
}

export interface SignalSnapshot {
  asOf: string;
  /** RAW_UNADJUSTED when no adjustment list was given (A13): ex-dividend days then look like price drops. */
  priceBasis: PriceBasis;
  windows: typeof WINDOWS;
  markets: MarketSummary[];
  shares: ShareSignals[];
}

export function signalSnapshot(input: SnapshotInput): SignalSnapshot {
  const { asOf, universe, fxRates, adjustments } = input;
  assertIsoDate(asOf, "asOf");
  if (new Set(universe).size !== universe.length) throw new Error("The universe lists a share twice");
  const byId = new Map<string, PriceSeries>();
  for (const s of input.series) {
    if (byId.has(s.orderbookId)) throw new Error(`${s.orderbookId} has two price series`);
    byId.set(s.orderbookId, s);
  }

  // Cut at the as-of date first, then adjust using only events known by then.
  const prepared = universe.map((id) => {
    const s = byId.get(id);
    if (s === undefined) throw new Error(`${id} is in the universe but has no price series`);
    assertValidSeries(s);
    const adjusted = adjustBars(id, barsUpTo(s.bars, asOf), asOf, adjustments);
    return { series: { ...s, bars: adjusted.bars }, priceBasis: adjusted.priceBasis, eventsApplied: adjusted.eventsApplied };
  });

  const marketOrder: Market[] = ["HEL", "STO", "CPH"];
  const marketSeries = new Map<Market, MarketReturn[]>();
  const markets: MarketSummary[] = [];
  for (const market of marketOrder) {
    const members = prepared.map((p) => p.series).filter((s) => s.market === market);
    if (members.length === 0) continue;
    const series = equalWeightMarketSeries(market, members, asOf);
    marketSeries.set(market, series);
    markets.push({ market, members: members.length, latest: series.at(-1) ?? null });
  }

  const shares = prepared.map(({ series, priceBasis, eventsApplied }): ShareSignals => {
    const { bars } = series;
    const market = marketSeries.get(series.market)!;
    return {
      orderbookId: series.orderbookId,
      market: series.market,
      currency: series.currency,
      barDate: bars.at(-1)?.tradeDate ?? null,
      priceBasis,
      adjustmentsApplied: eventsApplied,
      momentum: {
        d20: relativeMomentum(bars, market, 20),
        d60: relativeMomentum(bars, market, 60),
        d120: relativeMomentum(bars, market, 120),
      },
      distanceFrom52WeekHigh: distanceFromHigh(bars),
      volumeAnomaly: volumeAnomaly(bars),
      realisedVolatility20: realisedVolatility(bars),
      medianTurnover60: medianTurnoverEur(bars, eurRateLookup(series.currency, fxRates)),
    };
  });

  return {
    asOf,
    priceBasis: adjustments === undefined ? "RAW_UNADJUSTED" : "ADJUSTED",
    windows: WINDOWS,
    markets,
    shares,
  };
}
