// ECB euro reference rates (EXR dataflow), published around 16:00 CET on TARGET days.

export const SOURCE = "data-api.ecb.europa.eu EXR";
const BASE = "https://data-api.ecb.europa.eu/service/data/EXR";
const REQUEST_TIMEOUT_MS = 30_000;

export interface FxRate {
  currency: string;
  rateDate: string;
  unitsPerEur: number;
}

/** Minimal RFC 4180 parser: handles quoted fields containing commas and doubled quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

export function parseEcbCsv(text: string): FxRate[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new Error("ECB: empty response");
  const col = (name: string) => {
    const index = header.indexOf(name);
    if (index < 0) throw new Error(`ECB: column ${name} missing`);
    return index;
  };
  const currency = col("CURRENCY");
  const period = col("TIME_PERIOD");
  const value = col("OBS_VALUE");
  return rows.map((r, i) => {
    const code = r[currency];
    const rateDate = r[period];
    const raw = r[value];
    if (code === undefined || rateDate === undefined || raw === undefined) throw new Error(`ECB: row ${i + 1} is short`);
    if (!/^[A-Z]{3}$/.test(code)) throw new Error(`ECB: bad currency "${code}" in row ${i + 1}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rateDate)) throw new Error(`ECB: bad date "${rateDate}" in row ${i + 1}`);
    if (!/^\d+(\.\d+)?$/.test(raw) || Number(raw) <= 0) throw new Error(`ECB: bad rate "${raw}" in row ${i + 1}`);
    return { currency: code, rateDate, unitsPerEur: Number(raw) };
  });
}

/** Daily reference rates for the given currencies, inclusive date range (YYYY-MM-DD). */
export async function fetchRates(currencies: string[], fromDate: string, toDate: string): Promise<FxRate[]> {
  const url = `${BASE}/D.${currencies.join("+")}.EUR.SP00.A?startPeriod=${fromDate}&endPeriod=${toDate}&format=csvdata`;
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`ECB: HTTP ${response.status}`);
  const rates = parseEcbCsv(await response.text());
  const missing = currencies.filter((c) => !rates.some((r) => r.currency === c));
  if (missing.length > 0) throw new Error(`ECB: no rates returned for ${missing.join(", ")}`);
  const unexpected = rates.find((r) => !currencies.includes(r.currency) || r.rateDate < fromDate || r.rateDate > toDate);
  if (unexpected) throw new Error(`ECB: unexpected rate ${unexpected.currency} ${unexpected.rateDate}`);
  return rates;
}
