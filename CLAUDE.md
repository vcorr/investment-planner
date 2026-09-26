# CLAUDE.md — start here

This file carries a planning conversation held in a Claude Code web session on 2026-09-26 into any later session. Read it first, then the files it points to.

## The project in one paragraph

**Nordic Paper Trader.** A one-month, forward-only paper experiment. A simulated 5,000 € portfolio of Nordic shares (Helsinki, Stockholm, Copenhagen, Oslo, including First North) is managed every weekday by Claude, reading company news and deterministic market signals, within fixed rules and Nordnet's real Taso 4 costs. No real money and no broker. The primary verdict comes from the prediction log (market-adjusted 1- and 5-day directional calls against baselines), not from portfolio P&L.

## Files, in order of authority

1. `docs/decisions.md` — decisions and amendments agreed with Vasco. **Wins over the brief** wherever they differ.
2. `docs/PLAN.md` — the full plan: how it works, milestones with dates, verdict rules, costs, risks, open items.
3. `docs/verification.md` — Milestone 0 findings (V1–V21), each with its source and status.
4. `BRIEF.md` — the original build brief, verbatim. Background and detail; read it through the amendments.

## Working agreement (from the brief, §0)

- **Plan before code**, and wait for approval. A proposal is pending (PLAN.md §3) that approving PLAN.md approves M1–M6; Vasco has **not yet** confirmed it.
- **Never invent data.** Every figure comes from a named source, config or code. If unknown, stop and ask.
- **Label provenance:** `SOURCED` (URL + access date), `COMPUTED`, `ASSUMED`, `UNVERIFIED`.
- **Push back** plainly when something is wrong or statistically naive.
- Code and identifiers in English; **documentation and reports in British English**.
- Do not put model identifiers in commits, PRs or code comments.

## About Vasco (how to talk to him)

Preferences stated for this work:
- Reply in Finnish when written to in Finnish. In English, reply in refined, concise British English; gently correct grammar slips.
- Check the web for anything recent. State every figure with its basis. Compute decisive numbers rather than recalling them, and name the figure a conclusion depends on most.
- Vasco wants Claude to **work as independently as possible**, stopping only for real decisions.

## Status at handover (2026-09-26)

**Done:** M0 verification. Brief, decisions, verification log and plan committed on branch `claude/wizardly-goodall-0d01y8` of `vcorr/investment-planner`. No code yet.

**Decisions already made** (details in `docs/decisions.md`):
- Nordnet tier **Taso 4** (0.20 %, minimum 9 €), fixed for the whole simulation.
- **First North included.**
- Start the scored month **as soon as possible**. Target November 2026; fallback December or January.
- **Vasco sets the ethical screen rules**, including natural-gas consumers.
- All amendments A1–A11 accepted. Headlines: code computes stops, sizes and the cost hurdle; overlap-robust inference; majority-direction baseline; FX fee 0.25 % (SOURCED); settings versioned in the database.
- **Web interface: build it in M6** (split into M6b, after the shakedown starts). Pages: performance, predictions, today's report, settings. Google sign-in, Vasco only. Settings are editable from the page and lock during the scored month.

**Architecture agreed in discussion:**
- The experiment runs as **deterministic code on Cloud Run** (job at 08:30 Helsinki). Claude is called only through the API, with a frozen packet and no web access.
- **Claude sessions, Routines and Cowork scheduled tasks must not run the experiment itself,** because they can browse (leakage) and are not reproducible. They may sit around it as an interface: for example, a Cowork scheduled task that summarises the daily report for Vasco and takes instructions. Whether Cowork can read this private repo is UNVERIFIED.
- Any settings change during the scored month voids the month. The job must refuse to run on changed settings in that month unless Vasco explicitly ends the month.

## Waiting on Vasco

| # | Item | Needed for |
|---|---|---|
| 1 | Network access to data hosts. The web container blocked them; **running locally in iTerm should not have this problem** | M1 |
| 2 | Keys: EODHD, Neon, Anthropic API, GCP project (as `.env`, never committed) | M1 |
| 3 | Nordnet Taso 4 fees for Sweden, Denmark, Norway (logged-in price list, Välityspalkkiot) | M4 |
| 4 | Approve the EODHD fundamentals plan for **one month** (€59.99) to snapshot sector data | M1 |
| 5 | Confirm the Oslo Newsweb reading: private use only, so titles and links in reports | M3 |
| 6 | Confirm the LLM spend alert at $5 per day (estimate ≈ $1.44 per day) | M6a |
| 7 | Screen rules, including natural-gas consumers; later, the borderline review | M2 |
| 8 | Report delivery channel (web interface, possibly plus a Cowork summary) | M6 |
| 9 | Optional: a Claude Design mock-up for the web interface | M6b |
| 10 | Confirm that approving PLAN.md approves M1–M6 | now |

## Next step

M1 — Data foundation (PLAN.md §3). When the keys are available and Vasco says "go":
1. Scaffold the repo: TypeScript strict, pnpm, vitest, zod, Drizzle with migrations, `.env.example`, `.gitignore`.
2. Write the full schema (brief §17 plus versioned settings and `verification_log`); load `docs/verification.md` rows into `verification_log`.
3. Build the EODHD loader (codes HE, ST, CO, OL; bulk endpoint) and the ECB loader.
4. Backfill at least 260 trading days.
5. Load exchange calendars; build the universe and liquidity filter.
6. Start the Nasdaq RSS collector (main markets and First North, poll no faster than every 30 s).
7. Resolve with the first API calls: EODHD sector data, holidays and First North coverage; whether the EOD `open` is the official open; bar arrival time; whether RSS items carry ISINs.

## Useful facts

- Build window 28 Sep – 23 Oct 2026 is 20 working days, with no slack (COMPUTED).
- Taso 4 hurdle: 4.20 % for Helsinki, 5.70 % for SEK/NOK/DKK names, at 1,500 € with ASSUMED 10 bps slippage per side (COMPUTED).
- November 2026 has 21 decision days and no exchange closures (SOURCED, Nasdaq and Euronext calendars).
- Nasdaq's Nordic auction migration (INET): Helsinki 28 Sep, Copenhagen and Stockholm 5 Oct 2026. Recheck opening times before the shakedown.
