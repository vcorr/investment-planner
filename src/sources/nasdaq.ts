import { z } from "zod";

// Nasdaq Nordic's public website API (decision D10, amendment A13). Unofficial: no published terms or uptime
// promise, so every response is validated and errors are raised rather than guessed around.

export const SOURCE = "api.nasdaq.com/api/nordic";
const BASE = "https://api.nasdaq.com/api/nordic";
const USER_AGENT = "Mozilla/5.0 (compatible; nordic-paper-trader/0.1)";
/** Pause between requests, to stay polite towards an unofficial API. */
export const REQUEST_GAP_MS = 500;
const REQUEST_TIMEOUT_MS = 30_000;

export type Market = "HEL" | "STO" | "CPH";
export type Segment = "MAIN_MARKET" | "FIRST_NORTH";

const statusSchema = z.object({
  rCode: z.number(),
  bCodeMessage: z.array(z.object({ code: z.number(), errorMessage: z.string() })).nullable().optional(),
});

/** Plain decimals, optionally with comma thousand separators: "9.128", "14,639,094", "134,991,407.22". */
const NASDAQ_NUMBER = /^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/;

/** Nasdaq formats numbers as strings with comma thousand separators ("14,639,094"); "" means no value. */
export function parseNasdaqNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "-") return null;
  if (!NASDAQ_NUMBER.test(trimmed)) throw new Error(`Unparseable Nasdaq number: "${raw}"`);
  return Number(trimmed.replaceAll(",", ""));
}

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(`${BASE}${path}`, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body: unknown = await response.json().catch(() => null);
  if (body === null) throw new Error(`Nasdaq ${path}: HTTP ${response.status}, body is not JSON`);
  assertOk(path, response.status, body);
  return body;
}

function assertOk(path: string, httpStatus: number, body: unknown): void {
  const status = z.object({ data: z.unknown(), status: statusSchema }).safeParse(body);
  if (!status.success) throw new Error(`Nasdaq ${path}: HTTP ${httpStatus}, unexpected response shape`);
  const { rCode, bCodeMessage } = status.data.status;
  if (httpStatus !== 200 || rCode !== 200 || status.data.data === null) {
    const messages = bCodeMessage?.map((m) => `${m.code} ${m.errorMessage}`).join("; ");
    throw new Error(`Nasdaq ${path}: HTTP ${httpStatus}, rCode ${rCode}${messages ? ` (${messages})` : ""}`);
  }
}

// ---- Share list -------------------------------------------------------------------------------------------

const screenerRowSchema = z.object({
  orderbookId: z.string().min(1),
  symbol: z.string().min(1),
  fullName: z.string().min(1),
  isin: z.string().length(12),
  currency: z.string().length(3),
  sector: z.string(),
});

const screenerSchema = z.object({
  data: z.object({ instrumentListing: z.object({ rows: z.array(screenerRowSchema) }) }),
});

export type ScreenerRow = z.infer<typeof screenerRowSchema>;

export function parseScreener(body: unknown): ScreenerRow[] {
  return screenerSchema.parse(body).data.instrumentListing.rows;
}

export async function fetchShareList(market: Market, segment: Segment): Promise<ScreenerRow[]> {
  const path = `/screener/shares?tableonly=false&category=${segment}&market=${market}`;
  return parseScreener(await getJson(path));
}

// ---- Daily bars -------------------------------------------------------------------------------------------

const barRowSchema = z.object({
  dateTime: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  bid: z.string(),
  ask: z.string(),
  open: z.string(),
  high: z.string(),
  low: z.string(),
  close: z.string(),
  average: z.string(),
  totalVolume: z.string(),
  turnover: z.string(),
  trades: z.string(),
});

const chartDownloadSchema = z.object({
  data: z.object({
    chartData: z.object({ orderbookId: z.string(), isin: z.string() }),
    charts: z.object({ rows: z.array(barRowSchema) }),
  }),
});

export interface DailyBar {
  tradeDate: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  average: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  turnover: number | null;
  trades: number | null;
}

export interface BarRequest {
  orderbookId: string;
  fromDate: string;
  toDate: string;
}

/**
 * Returns bars oldest first (the API returns them newest first). Throws if the response is for another
 * instrument, falls outside the requested dates, repeats a date, or contains an impossible bar.
 */
export function parseDailyBars(body: unknown, request: BarRequest): DailyBar[] {
  const { chartData, charts } = chartDownloadSchema.parse(body).data;
  if (chartData.orderbookId !== request.orderbookId) {
    throw new Error(`Nasdaq: asked for ${request.orderbookId}, got ${chartData.orderbookId}`);
  }
  const bars = charts.rows
    .map((r) => ({
      tradeDate: r.dateTime,
      open: parseNasdaqNumber(r.open),
      high: parseNasdaqNumber(r.high),
      low: parseNasdaqNumber(r.low),
      close: parseNasdaqNumber(r.close),
      average: parseNasdaqNumber(r.average),
      bid: parseNasdaqNumber(r.bid),
      ask: parseNasdaqNumber(r.ask),
      volume: parseNasdaqNumber(r.totalVolume),
      turnover: parseNasdaqNumber(r.turnover),
      trades: parseNasdaqNumber(r.trades),
    }))
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  bars.forEach((bar, i) => {
    const where = `${request.orderbookId} ${bar.tradeDate}`;
    if (bar.tradeDate < request.fromDate || bar.tradeDate > request.toDate) throw new Error(`Nasdaq: ${where} is outside the requested range`);
    if (i > 0 && bars[i - 1]?.tradeDate === bar.tradeDate) throw new Error(`Nasdaq: ${where} appears twice`);
    assertPlausibleBar(bar, where);
  });
  return bars;
}

function assertPlausibleBar(bar: DailyBar, where: string): void {
  const prices = [bar.open, bar.high, bar.low, bar.close, bar.average].filter((p): p is number => p !== null);
  if (prices.some((p) => p <= 0)) throw new Error(`Nasdaq: ${where} has a non-positive price`);
  const { high, low } = bar;
  if (high === null || low === null) return;
  if (high < low) throw new Error(`Nasdaq: ${where} has high below low`);
  for (const [name, p] of [["open", bar.open], ["close", bar.close]] as const) {
    if (p !== null && (p < low || p > high)) throw new Error(`Nasdaq: ${where} ${name} ${p} is outside [${low}, ${high}]`);
  }
}

/** Daily bars for one order book, inclusive date range (YYYY-MM-DD). */
export async function fetchDailyBars(orderbookId: string, fromDate: string, toDate: string): Promise<DailyBar[]> {
  const path = `/instruments/${orderbookId}/chart/download?assetClass=SHARES&fromDate=${fromDate}&toDate=${toDate}`;
  return parseDailyBars(await getJson(path), { orderbookId, fromDate, toDate });
}

export const pause = (ms = REQUEST_GAP_MS) => new Promise((resolve) => setTimeout(resolve, ms));
