# M0 — Verification log

Milestone 0 of the Nordic Paper Trader (see `BRIEF.md`). Each `VERIFY` item from the brief is listed with its finding, source and status. All sources were accessed on **2026-09-26** unless stated otherwise.

Status labels: `SOURCED` (primary source, quoted or linked), `COMPUTED` (arithmetic done here), `ASSUMED` (placeholder awaiting calibration), `UNVERIFIED` (not yet confirmed, or secondary source only), `OPEN` (needs an action before it can be resolved).

These rows will be loaded into the `verification_log` table in M1.

---

## 1. Summary

| # | Item | Finding | Status |
|---|---|---|---|
| V1 | Nordnet Helsinki fees, Taso 4 | 0.20 %, minimum 9 € per executed order | SOURCED |
| V2 | Nordnet fees for Stockholm, Copenhagen, Oslo | One schedule for Sweden, Norway and Denmark: Taso 4 0.25 %, Taso 3 0.18 %, Taso 2 0.12 %, Taso 1 0.08 %, minimum 10 € at every tier (stated in euros). Resolved 2026-09-27 | SOURCED |
| V3 | Nordnet FX conversion fee | 0.25 % on automatic conversion; 0.075 % if converted manually via a currency account | SOURCED |
| V4 | EODHD exchange codes | HE, ST, CO, OL | SOURCED |
| V5 | EODHD OHLC semantics | open/high/low/close raw as traded; `adjusted_close` adjusted for splits and dividends; volume split-adjusted | SOURCED |
| V6 | EODHD holiday calendar | Exchange Details v2 returns the current year's holiday calendar, including early-close days | SOURCED (plan entitlement UNVERIFIED) |
| V7 | EODHD fundamentals (sector, industry) in the €19.99 plan | Appears **not** to be included; the fundamentals and calendar feeds sit in the €59.99 and €99.99 plans | UNVERIFIED — confirm with API key |
| V8 | EODHD ISINs | Ticker list endpoint includes ISIN | SOURCED (needs API test) |
| V9 | EODHD EOD availability time for Nordic venues | Not stated for non-US venues; example shows prior session available by 06:51 UTC | UNVERIFIED — measure in M1 |
| V10 | EODHD First North coverage | Not stated | OPEN — confirm with API key |
| V11 | ECB reference rates | Published around 16:00 CET on TARGET working days | SOURCED |
| V12 | Nasdaq Nordic RSS feeds | Feeds exist, but carry **exchange notices** (derivatives, warrants, expiries), not company announcements, and hold only the latest 20 items. Corrected 2026-09-26; see V23 | SOURCED (corrected) |
| V13 | Oslo Newsweb | No official RSS or API found; database terms permit private use only | SOURCED (terms); feed OPEN |
| V14 | Business press RSS | Yle Talous and Kauppalehti feeds exist; others not yet checked | PARTLY SOURCED |
| V15 | Insider transactions | Swedish PDMR register as CSV (Finansinspektionen open data); elsewhere via exchange announcements | SOURCED (SE); rest via news feeds |
| V16 | Exchange hours vs 09:15 Helsinki cut-off | Continuous trading starts 09:00 CET = 10:00 Helsinki on all four venues; cut-off precedes it by 45 min | SOURCED (Oslo secondary) |
| V17 | Holidays in the scored month | No closures in November 2026 on Helsinki, Stockholm or Copenhagen; Stockholm half day on Fri 30 Oct 2026 | SOURCED |
| V18 | Anthropic model IDs | `claude-sonnet-5`, `claude-haiku-4-5` | SOURCED |
| V19 | Structured output | `client.messages.parse()` with `output_config.format` and `zodOutputFormat()` | SOURCED |
| V20 | LLM spend estimate | About $1.45 per decision day; about $30 per 21-day month | COMPUTED from ASSUMED volumes |
| V21 | Development network access | This cloud container cannot reach any data host directly | OPEN — environment setting |

---

## 2. Details

### V1 — Nordnet Helsinki fee schedule (SOURCED)

Source: https://www.nordnet.fi/palvelut/hinnasto

> Taso 4 — Asiakkaille, jotka eivät ole tehneet yhtään kauppaa edellisen kalenterikuukauden aikana. Kaupankäyntipalkkio Helsingin pörssissä: 0,20 %. Minimipalkkio: 9 €

Plain English: Taso 4 applies to customers with no trades in the previous calendar month; Helsinki fee 0.20 %, minimum 9 €.

The four tiers quoted in the brief (0.06 %/3 €, 0.10 %/5 €, 0.15 %/7 €, 0.20 %/9 €) all match the live page. The fee rule is also confirmed on Nordnet's FAQ (https://www.nordnet.fi/faq/kaupankaynti-ja-arvopaperit/valityspalkkiot/miten-valityspalkkio-lasketaan): the larger of the minimum and the percentage fee is charged per executed order.

**Decision recorded:** the simulation's fixed tier is **Taso 4** (Vasco, 2026-09-26: "the most expensive for now").

COMPUTED consequences at Taso 4 (fee per side = max(0.20 % × notional, 9 €)):

| Position | Round-trip fees | As % of position |
|---|---|---|
| 1,000 € | 18.00 € | 1.80 % |
| 1,500 € | 18.00 € | 1.20 % |
| 5,000 € | 20.00 € | 0.40 % |
| Minimum stops binding at | 4,500.00 € | — |

With the ASSUMED 10 bps slippage per side, a 1,500 € Helsinki round trip costs 1.40 %, so the 3× hurdle is **4.20 %**. For a SEK or DKK name the Nordic schedule applies (V2): the cost is 2.03 % and the hurdle **6.10 %** (COMPUTED).

The golden tests in §19 of the brief stay as written (they test the formula at Taso 3 and Taso 1). Taso 4 golden values above will be added.

### V2 — Nordnet fees on Stockholm, Copenhagen, Oslo (SOURCED, 2026-09-27)

Source: https://www.nordnet.fi/palvelut/hinnasto, accessed 2026-09-27. The brokerage table is embedded in the page's data rather than rendered, so it was read from the page source. Row "Ruotsi, Norja ja Tanska" (Sweden, Norway and Denmark):

| | Taso 4 | Taso 3 | Taso 2 | Taso 1 |
|---|---|---|---|---|
| Rate | 0,25 % | 0,18 % | 0,12 % | 0,08 % |
| "Minimipalkkio, Ruotsi, Norja ja Tanska" | Min. 10 € | Min. 10 € | Min. 10 € | Min. 10 € |

The same table confirms Helsinki ("Suomi": 0,20 % / Min. 9 € at Taso 4). The minimum is stated in euros, so the fee is taken to be charged in euros and not to pay the FX fee itself (inference from the stated currency; the FAQ adds that fees are charged the day after the trade from the account's cash balance, https://www.nordnet.fi/faq/kaupankaynti-ja-arvopaperit/valityspalkkiot/miten-valityspalkkio-lasketaan).

COMPUTED consequences at Taso 4, 1,500 € SEK or DKK name, 10 bps ASSUMED slippage per side, FX 0.25 % per side: fees 20 € + FX 7.50 € + slippage 3 € = 30.50 €, a round trip of **2.03 %** and a 3× hurdle of **6.10 %** (was 1.90 % and 5.70 % on the Helsinki schedule). The Nordic minimum stops binding at 4,000 €.

### V3 — Nordnet FX conversion fee (SOURCED)

Source: https://www.nordnet.fi/koulu/valuutanvaihto

> Kun teemme automaattisen valuutanvaihdon, ostokurssi ja myyntikurssi eroavat 0,25 prosentilla nordnet.fi-sivustolla näkemästäsi alustavasta kurssista.

Plain English: on automatic conversion, the rate differs by 0.25 % from the indicative rate.

Also SOURCED (https://www.nordnet.fi/faq/korot-ja-valuuttatilit/valuuttatilit/miten-itse-tehty-valuutanvaihto-eroaa-automaattisesta): manual conversion through a currency account costs 0.075 %. The simulation uses **0.25 %** per conversion (automatic, the default for someone without currency accounts). This replaces the brief's UNVERIFIED secondary source.

### V4–V10 — EODHD

Sources: https://eodhd.com/list-of-stock-markets ; https://eodhd.com/financial-apis/api-for-historical-data-and-volumes ; https://eodhd.com/financial-apis/exchanges-api-trading-hours-and-stock-market-holidays ; https://eodhd.com/financial-apis/bulk-api-eod-splits-dividends ; https://eodhd.com/pricing

- **Codes (SOURCED):** Helsinki `HE` (XHEL), Stockholm `ST` (XSTO), Copenhagen `CO` (XCSE), Oslo `OL` (XOSL). Symbols take the form `NOKIA.HE`.
- **Fields (SOURCED):** "open — Opening price, as traded — not adjusted"; "adjusted_close — Closing price adjusted for both splits and dividends"; "volume — Traded volume, adjusted for splits". The raw `open` is what fills use. Whether EODHD's `open` is the official opening auction price is not stated: **UNVERIFIED**; compare against Nasdaq's official open for a sample in M1.
- **Corporate actions (design consequence):** raw OHLC is not split-adjusted, so signals must be computed on a split-adjusted series built from the splits feed or from `adjusted_close`. Stops and fills use raw prices of the fill day only, so they are unaffected.
- **Bulk endpoint (SOURCED):** one whole-exchange request costs 100 API calls; the plan allows 100,000 per day. Four exchanges daily is about 400 calls (COMPUTED).
- **Holidays (SOURCED):** Exchange Details v2 returns the full holiday calendar for the current year, with `Official`, `Bank` or `EarlyClose` types. Plan entitlement not stated.
- **Fundamentals (UNVERIFIED, likely not included):** the pricing grid marks fundamental data as absent from "EOD Historical Data — All World"; the earnings calendar is stated to be in "Fundamentals Data Feed" and "All-In-One" plans. The fundamentals `General` block contains `Sector`, `Industry`, `GicSector`, `GicIndustry`, `ISIN`.
- **Availability time (UNVERIFIED):** the documentation quotes US timings only; its example shows every exchange-traded symbol on the prior session at 06:51 UTC (08:51 Helsinki summer time). M1 will log arrival times during the build weeks.

**Consequence — sector data.** Sector codes feed the first pass of the ethical screen and the two-per-sector cap. Options, cheapest first:

1. Subscribe to **Fundamentals Data Feed (€59.99) for one month only**, snapshot sector, industry and description for the whole universe, then drop back to EOD (€19.99). Sector labels change rarely, and the snapshot is stored with its date. **Recommended.**
2. Keep Fundamentals throughout: €59.99 per month, 1.20 % of 5,000 € per month (COMPUTED), which would also give an earnings calendar.
3. Take sector from exchange share lists (Nasdaq Nordic, Euronext) if a lawful machine-readable source exists. Not yet verified.

This is a paid-data decision for Vasco (§21.7).

### V11 — ECB reference rates (SOURCED)

Source: https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html

> The reference rates are usually updated at around 16:00 CET every working day, except on TARGET closing days.

On 25 Sept 2026: DKK 7.4755, SEK 11.2900, NOK 10.8400 per euro. A fill at the open is settled in the next morning's run, by which time that day's rate is published, so the brief's timing works. On TARGET closing days, use the previous published rate and tag it. Endpoint: the ECB Data Portal (`data-api.ecb.europa.eu`, series `EXR/D.{SEK,NOK,DKK}.EUR.SP00.A`); the exact query is to be exercised in M1 (network, see V21).

### V12 — Nasdaq Nordic RSS (SOURCED)

Source: https://subscribe.news.eu.nasdaq.com/rss

- Main Markets notices (Copenhagen, Stockholm, Helsinki, Iceland): `https://api.news.eu.nasdaq.com/news/rss/mainMarketNotices`
- First North notices (same markets): `https://api.news.eu.nasdaq.com/news/rss/firstNorthNotices`
- Nasdaq's own news: `https://api.news.eu.nasdaq.com/news/rss/nasdaqNordicNews` (not needed)
- > The CNS RSS feeds have a maximum polling frequency of 30 seconds — if your system polls more often, it may be temporarily blocked.

Whether items carry ISINs is to be checked on the first real fetch (network, V21). With First North now included, both feeds are ingested.

### V13 — Oslo Newsweb (terms SOURCED; feed OPEN)

No official RSS or public API found; community sources agree there is none. Terms (https://newsweb.oslobors.no/disclaimer):

> The contents may not be made available outside of the private sphere or copied for a purpose other than for private use … As copying is also considered downloading and storage on any computer or other device.

Plain English: private use only; no redistribution.

Reading: storing announcements for Vasco's private paper experiment is private use; publishing them in a shared report or web page would not be. So Oslo items may enter packets, but reports show only a title and link, never the text. **Vasco to confirm this reading.** Without a feed, Oslo news would need page polling. If that is judged too fragile, Oslo names can still trade on signals but will carry no news. Decide in M3.

### V14 — Business press (PARTLY SOURCED)

- Yle Talous: `https://yle.fi/rss/t/18-19274/fi` (listed at https://yle.fi/rss).
- Kauppalehti: RSS page at https://www.kauppalehti.fi/rss ("otsikot linkkeinä sivustolle": headlines as links). Terms still to be read.
- Inderes, Dagens industri, E24, Børsen, an international wire: not yet checked. To finish in M3; headlines and summaries only, per the brief.

### V15 — Insider transactions

- Sweden: Finansinspektionen publishes the PDMR Transaction Register as CSV (https://www.fi.se/en/about-fi/about-fi.se/open-data/). SOURCED.
- Finland, Denmark: managers' transactions are published as company announcements, so they arrive through the Nasdaq feeds and can be classed as `insider_trade` events.
- Norway: "Mandatory notification of trade" messages on Newsweb (e.g. https://newsweb.oslobors.no/message/683039), subject to V13.

No extra paid source is needed.

### V16–V17 — Hours and holidays

Source: https://www.nasdaq.com/european-market-activity/trading-hours ; https://live.euronext.com/en/resources/trading-hours-holidays

- Nasdaq Nordic and Oslo continuous equity trading starts 09:00 CET/CEST = **10:00 Helsinki** (Oslo: secondary source, Wikipedia; primary page did not render the times). The 09:15 Helsinki cut-off precedes the earliest open by 45 minutes. **Monitor:** Nasdaq's "Nordic Auctions (INET)" migration is scheduled for Helsinki on 28 Sept and Copenhagen/Stockholm on 5 Oct 2026 (https://www.nasdaq.com/products/european-markets/nordic-auctions). Details did not render; recheck before the shakedown in case auction times move.
- 2026 closures, equities: Helsinki and Stockholm close 24, 25, 31 Dec; Copenhagen 24, 25, 31 Dec; none in November. Stockholm has a **half day on Fri 30 Oct 2026**, in the shakedown week. Euronext (Oslo) lists 31 Dec 2026 as a half day and no November closure.
- **Consequence:** November 2026 has 21 decision days on every venue (COMPUTED).

### V18–V19 — Anthropic API (SOURCED)

Source: the Claude API reference bundled with Claude Code, model table cached 2026-06-24.

| Role | Model ID | Price per MTok (input / output) |
|---|---|---|
| decision | `claude-sonnet-5` | $2 / $10 |
| extraction | `claude-haiku-4-5` | $1 / $5 |

- Use `claude-haiku-4-5`. The brief's `claude-haiku-4-5-20251001` is the same model's dated snapshot, and both work. The dated ID pins the exact version, which suits a pre-registered experiment, so **config will use the dated ID** and log it.
- Structured output: `client.messages.parse({ ..., output_config: { format: zodOutputFormat(schema) } })` from `@anthropic-ai/sdk/helpers/zod`. It validates against the zod schema. The old `output_format` parameter is deprecated.
- Sonnet 5 rejects `budget_tokens` and sampling parameters (`temperature` etc.); it uses adaptive thinking and an `effort` setting. So "temperature 0" is not available; reproducibility comes from the frozen packet, not the sampler. Log `effort` in `llm_calls`.

### V20 — LLM spend estimate (COMPUTED from ASSUMED inputs)

| Component | ASSUMED volume | Cost per day |
|---|---|---|
| Event extraction (Haiku 4.5) | 400 items × 1,500 input + 300 output tokens | $1.20 |
| Decision call (Sonnet 5) | 30,000 input + 6,000 output tokens, ×2 for one retry | $0.24 |
| **Total** | | **≈ $1.44** |

For 21 days, about $30 per month (COMPUTED). One-off M2 screen reading: about 400 names × (20,000 input + 1,000 output) on Sonnet 5 ≈ $20 (COMPUTED).

**Proposed ceiling:** alert at **$5 per day**, about 3.5× the estimate. It is ASSUMED and reviewed after the shakedown, when real volumes are known. LLM spend will be reported as a cost line beside data costs.

### V21 — Development network (OPEN)

This cloud development container's network policy blocks the data hosts; `curl` to ECB, Nasdaq, Newsweb, Nordnet, Yle and EODHD returned connection refusals. Research above was done through a search service. Production runs on Cloud Run, which is unaffected, but M1 cannot be tested here until these hosts are allowed:

`eodhd.com`, `data-api.ecb.europa.eu`, `www.ecb.europa.eu`, `api.news.eu.nasdaq.com`, `newsweb.oslobors.no`, `yle.fi`, `www.kauppalehti.fi`, `www.fi.se`, and the Neon host once the database exists.

Change it in the environment's settings (Network access), either by allowing these domains or choosing a broader access level.

## Added 2026-09-26

| # | Item | Finding | Status |
|---|---|---|---|
| V22 | Free price source for Nasdaq Nordic | `api.nasdaq.com/api/nordic/instruments/TX50063/chart/download?assetClass=SHARES&fromDate=2025-01-01&toDate=2026-09-25` returned 435 daily rows for Nokia (2025-01-02 to 2026-09-25) with fields "Opening price", "High price", "Low price", "Closing price", "Average price", "Total volume", "Turnover", "Trades". Screener (`/api/nordic/screener/shares`, category MAIN_MARKET or FIRST_NORTH, market HEL, STO or CPH) lists ISIN, orderbook ID and sector. Market codes: HEL, STO, CPH, ICE. Orderbook IDs are `TX…` (post-INET). No Oslo. Terms of use not found | SOURCED (tested 2026-09-26); terms UNVERIFIED |
| V23 | Nasdaq company announcements | `api.news.eu.nasdaq.com/news/query.action?type=json&globalGroup=companyNews&globalName=NordicAllMarkets&limit=200&start=N&dir=DESC` returns company, market, category (e.g. "Inside information"), headline, language, release time and message URL; no ISIN. `disclosureId` is unique per announcement. Use `timeZone=UTC`: `timeZone=CET` actually returns Central European local time including summer time. `fromDate` and `toDate` are ignored; paging with `start` goes back about 2-3 days per 200 items; `count` caps at 10,000. About 80-100 items per weekday across Nordic and Baltic markets, about 85 % in HEL, STO and CPH, about 73 % in English (sample of 200, 24 Sep 2026). Filtering by company name returned nothing | SOURCED (tested 2026-09-26); history depth UNVERIFIED |
| V24 | Nasdaq company announcements: fixture details | In the saved response (`test/fixtures/nasdaq-company-news.json`, 200 items, 24-26 Sep 2026): the market labels are "Main Market, Helsinki", "Main Market, Stockholm", "Main Market, Copenhagen", "First North Finland", "First North Sweden" and "First North Denmark" (177 items), plus Iceland and the Baltics (23 items). Items are ordered by release time, not by `disclosureId`: 11 of 199 neighbouring pairs have a higher ID below a lower one, so the poller detects overlap by ID membership, not by the highest ID. `showAttachments=false` still returns attachment metadata (136 items). `releaseTime` equalled `published` on all 200 items | COMPUTED (from the fixture, 2026-09-26) |
