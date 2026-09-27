import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as shared from "../supabase/functions/_shared/settings.js";
import {
  canonicalJson,
  DEFAULT_SCREEN,
  hashSettings,
  isValidIsin,
  settingsLocked,
  settingsSchema,
  type ScoredMonth,
  type Settings,
} from "../src/settings/settings.js";

const settings: Settings = {
  universe: { mode: "sample", listings: [{ market: "HEL", symbol: "NOKIA", orderbookId: "TX50063" }] },
  screen: DEFAULT_SCREEN,
};

/** A deep copy of `settings` that a test may change freely. */
const copy = (): any => structuredClone(settings);

/** The zod issue paths, joined with dots, when `value` is rejected. */
function rejectedPaths(value: unknown): string[] {
  const result = settingsSchema.safeParse(value);
  expect(result.success).toBe(false);
  return result.success ? [] : result.error.issues.map((i) => i.path.join("."));
}

describe("settings hash", () => {
  it("ignores key order", () => {
    const reordered = {
      screen: {
        overrides: [],
        borderline: "exclude_until_reviewed",
        rules: DEFAULT_SCREEN.rules.map((r) => Object.fromEntries(Object.entries(r).reverse())),
      },
      universe: { listings: [{ orderbookId: "TX50063", symbol: "NOKIA", market: "HEL" }], mode: "sample" },
    } as unknown as Settings;
    expect(canonicalJson(reordered)).toBe(canonicalJson(settings));
    expect(hashSettings(reordered)).toBe(hashSettings(settings));
  });

  it("changes when any value changes", () => {
    const listing = copy();
    listing.universe.listings[0].orderbookId = "TX50064";
    expect(hashSettings(listing)).not.toBe(hashSettings(settings));
    const rule = copy();
    rule.screen.rules[0].test = { kind: "revenue_share", maxPct: 5 };
    expect(hashSettings(rule)).not.toBe(hashSettings(settings));
  });

  it("keeps array order, which is meaningful", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it("is identical in Node and in the shared Web Crypto version used by the Edge Function and the page", async () => {
    const variants: Settings[] = [
      settings,
      {
        ...settings,
        screen: {
          rules: [
            { id: "natural-gas", activity: "Natural gas", description: "Ä, ö and € survive UTF-8", test: { kind: "role", roles: ["extracts", "consumes"] } },
            { id: "coal", activity: "Coal", description: "d", test: { kind: "revenue_share", maxPct: 5.5 } },
          ],
          borderline: "exclude_until_reviewed",
          overrides: [{ isin: "FI0009000681", verdict: "include", reason: "r", decidedOn: "2026-09-27" }],
        },
      },
    ];
    for (const v of variants) expect(await shared.settingsHash(v)).toBe(hashSettings(v));
    // A known value, so both could not drift together: SHA-256 of the canonical JSON, computed independently.
    const { createHash } = await import("node:crypto");
    expect(await shared.settingsHash(settings)).toBe(createHash("sha256").update(shared.canonicalJson(settings)).digest("hex"));
  });

  it("uses the shared schema and canonical JSON in Node (one definition)", () => {
    expect(settingsSchema).toBe(shared.settingsSchema);
    expect(canonicalJson).toBe(shared.canonicalJson);
  });
});

describe("settings schema: defaults", () => {
  it("has the brief's five excluded activities as unreviewed any-involvement placeholders", () => {
    expect(DEFAULT_SCREEN.rules.map((r) => r.activity)).toEqual([
      "Fossil fuels",
      "Weapons and defence",
      "Mining",
      "Pesticides",
      "Tobacco",
    ]);
    for (const rule of DEFAULT_SCREEN.rules) {
      expect(rule.test).toEqual({ kind: "any_involvement" });
      expect(rule.notes).toMatch(/Vasco has not reviewed/);
    }
    expect(DEFAULT_SCREEN.borderline).toBe("exclude_until_reviewed");
    expect(DEFAULT_SCREEN.overrides).toEqual([]);
  });

  it("has no rule for natural-gas consumers: Vasco decides that (D6)", () => {
    const text = JSON.stringify(DEFAULT_SCREEN).toLowerCase();
    expect(text).not.toContain("gas");
    expect(text).not.toContain("consumes");
  });

  it("parses the defaults with the sample universe unchanged", () => {
    expect(settingsSchema.parse(settings)).toEqual(settings);
  });

  it("rejects the stored version 2, which has no screen", () => {
    expect(rejectedPaths({ universe: settings.universe })).toContain("screen");
  });
});

describe("settings schema: rejections", () => {
  const withRule = (test: unknown, extra: Record<string, unknown> = {}) => {
    const s = copy();
    s.screen.rules[0] = { ...s.screen.rules[0], test, ...extra };
    return s;
  };

  it.each([
    ["an unknown kind", { kind: "sometimes" }, "screen.rules.0.test.kind"],
    ["any_involvement with an extra field", { kind: "any_involvement", maxPct: 5 }, "screen.rules.0.test"],
    ["revenue_share without maxPct", { kind: "revenue_share" }, "screen.rules.0.test.maxPct"],
    ["revenue_share with maxPct as a string", { kind: "revenue_share", maxPct: "5" }, "screen.rules.0.test.maxPct"],
    ["revenue_share with a negative maxPct", { kind: "revenue_share", maxPct: -1 }, "screen.rules.0.test.maxPct"],
    ["revenue_share with maxPct of 100", { kind: "revenue_share", maxPct: 100 }, "screen.rules.0.test.maxPct"],
    ["revenue_share with maxPct NaN", { kind: "revenue_share", maxPct: Number.NaN }, "screen.rules.0.test.maxPct"],
    ["revenue_share with roles", { kind: "revenue_share", maxPct: 5, roles: ["sells"] }, "screen.rules.0.test"],
    ["role without roles", { kind: "role" }, "screen.rules.0.test.roles"],
    ["role with no roles", { kind: "role", roles: [] }, "screen.rules.0.test.roles"],
    ["role with an unknown role", { kind: "role", roles: ["burns"] }, "screen.rules.0.test.roles.0"],
    ["role with a repeated role", { kind: "role", roles: ["sells", "sells"] }, "screen.rules.0.test.roles"],
  ])("rejects %s", (_name, test, path) => {
    expect(rejectedPaths(withRule(test))).toContain(path);
  });

  it.each([
    ["an empty id", { id: "" }, "screen.rules.0.id"],
    ["an id with capitals and spaces", { id: "Fossil fuels" }, "screen.rules.0.id"],
    ["a blank activity", { activity: "  " }, "screen.rules.0.activity"],
    ["an empty description", { description: "" }, "screen.rules.0.description"],
    ["empty notes", { notes: "" }, "screen.rules.0.notes"],
    ["an unknown field", { weight: 2 }, "screen.rules.0"],
  ])("rejects a rule with %s", (_name, extra, path) => {
    expect(rejectedPaths(withRule({ kind: "any_involvement" }, extra))).toContain(path);
  });

  it("accepts a rule without notes", () => {
    const s = copy();
    delete s.screen.rules[0].notes;
    expect(settingsSchema.safeParse(s).success).toBe(true);
  });

  it("rejects two rules with the same id", () => {
    const s = copy();
    s.screen.rules[1].id = s.screen.rules[0].id;
    expect(rejectedPaths(s)).toContain("screen.rules.1.id");
  });

  it("rejects any borderline handling other than exclude_until_reviewed", () => {
    const s = copy();
    s.screen.borderline = "include_until_reviewed";
    expect(rejectedPaths(s)).toContain("screen.borderline");
  });

  const override = { isin: "FI0009000681", verdict: "include", reason: "Reviewed", decidedOn: "2026-09-27" };
  const withOverride = (o: Record<string, unknown>) => {
    const s = copy();
    s.screen.overrides = [{ ...override, ...o }];
    return s;
  };

  it("accepts a valid override", () => {
    expect(settingsSchema.safeParse(withOverride({})).success).toBe(true);
  });

  it.each([
    ["a lower-case ISIN", { isin: "fi0009000681" }, "screen.overrides.0.isin"],
    ["a short ISIN", { isin: "FI000900068" }, "screen.overrides.0.isin"],
    ["a wrong check digit", { isin: "FI0009000682" }, "screen.overrides.0.isin"],
    ["an unknown verdict", { verdict: "maybe" }, "screen.overrides.0.verdict"],
    ["an empty reason", { reason: "" }, "screen.overrides.0.reason"],
    ["a date in another format", { decidedOn: "27.9.2026" }, "screen.overrides.0.decidedOn"],
    ["an impossible date", { decidedOn: "2026-02-30" }, "screen.overrides.0.decidedOn"],
  ])("rejects an override with %s", (_name, o, path) => {
    expect(rejectedPaths(withOverride(o))).toContain(path);
  });

  it("rejects two overrides for one ISIN", () => {
    const s = withOverride({});
    s.screen.overrides.push({ ...override, verdict: "exclude" });
    expect(rejectedPaths(s)).toContain("screen.overrides.1.isin");
  });
});

describe("ISIN check digit", () => {
  it("accepts every ISIN in Nasdaq's share lists (1,082 shares)", () => {
    const { shares } = JSON.parse(readFileSync("test/fixtures/nasdaq-share-lists.json", "utf8")) as { shares: { isin: string }[] };
    expect(shares.length).toBe(1082);
    expect(shares.filter((s) => !isValidIsin(s.isin)).map((s) => s.isin)).toEqual([]);
  });

  it("rejects each of those ISINs with its check digit changed", () => {
    const { shares } = JSON.parse(readFileSync("test/fixtures/nasdaq-share-lists.json", "utf8")) as { shares: { isin: string }[] };
    for (const { isin } of shares.slice(0, 50)) {
      const wrong = `${isin.slice(0, 11)}${(Number(isin[11]) + 1) % 10}`;
      expect(isValidIsin(wrong)).toBe(false);
    }
  });
});

describe("settingsLocked", () => {
  const november: ScoredMonth = { startsOn: "2026-11-01", endsOn: "2026-11-30", endedEarlyAt: null };

  it("locks nothing when there are no scored months", () => {
    expect(settingsLocked([], "2026-11-15")).toBe(false);
  });

  it.each([
    ["the day before", "2026-10-31", false],
    ["the first day", "2026-11-01", true],
    ["mid-month", "2026-11-15", true],
    ["the last day", "2026-11-30", true],
    ["the day after", "2026-12-01", false],
  ])("on %s of the month: %s", (_name, day, locked) => {
    expect(settingsLocked([november], day)).toBe(locked);
  });

  it("does not lock a month that was ended early", () => {
    expect(settingsLocked([{ ...november, endedEarlyAt: "2026-11-10T08:00:00Z" }], "2026-11-15")).toBe(false);
  });

  it("locks when any one of several months is running", () => {
    const october: ScoredMonth = { startsOn: "2026-10-01", endsOn: "2026-10-31", endedEarlyAt: "2026-10-05T08:00:00Z" };
    expect(settingsLocked([october, november], "2026-11-02")).toBe(true);
    expect(settingsLocked([october, november], "2026-10-20")).toBe(false);
  });

  it("throws on malformed dates rather than guessing", () => {
    expect(() => settingsLocked([november], "15.11.2026")).toThrow(/bad date/);
    expect(() => settingsLocked([{ ...november, endsOn: "2026-10-30" }], "2026-11-15")).toThrow(/bad scored month/);
  });

  it("uses the Helsinki calendar date: 23:30 UTC on 31 October is already 1 November in Helsinki", () => {
    const today = shared.helsinkiToday(new Date("2026-10-31T23:30:00Z"));
    expect(today).toBe("2026-11-01");
    expect(settingsLocked([november], today)).toBe(true);
  });
});
