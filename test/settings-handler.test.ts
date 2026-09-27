import { describe, expect, it } from "vitest";
import {
  handleSettingsRequest,
  type SettingsContext,
  type SettingsStore,
  type StoredVersion,
  type VersionSummary,
} from "../supabase/functions/_shared/settings-handler.js";
import { DEFAULT_SCREEN, settingsHash, type ScoredMonth, type Settings } from "../supabase/functions/_shared/settings.js";

const VASCO = "0b6f1c9e-0000-4000-8000-000000000001";
const OTHER = "0b6f1c9e-0000-4000-8000-000000000002";

const settings: Settings = {
  universe: { mode: "sample", listings: [{ market: "HEL", symbol: "NOKIA", orderbookId: "TX50063" }] },
  screen: DEFAULT_SCREEN,
};

/** In-memory store with the same contract as the Postgres one: highest id is current, newest first. */
class FakeStore implements SettingsStore {
  rows: StoredVersion[] = [];
  months: ScoredMonth[] = [];
  atomicCalls = 0;

  async currentVersion() {
    return this.rows.at(-1) ?? null;
  }
  async listVersions(): Promise<VersionSummary[]> {
    return [...this.rows].reverse().map(({ payload: _p, ...v }) => v);
  }
  async scoredMonths() {
    return this.months;
  }
  async insertVersion({ hash, settings: s, note }: { hash: string; settings: Settings; note: string }) {
    const row: StoredVersion = {
      id: this.rows.length + 1,
      hash,
      note,
      createdAt: new Date(Date.UTC(2026, 8, 27, 9, this.rows.length)).toISOString(),
      payload: JSON.parse(JSON.stringify(s)),
    };
    this.rows.push(row);
    const { payload: _p, ...summary } = row;
    return summary;
  }
  async atomically<T>(fn: (store: SettingsStore) => Promise<T>): Promise<T> {
    this.atomicCalls += 1;
    return fn(this);
  }
}

async function seeded(): Promise<FakeStore> {
  const store = new FakeStore();
  await store.insertVersion({ hash: await settingsHash(settings), settings, note: "seed" });
  return store;
}

const ctx: SettingsContext = { allowedUserId: VASCO, todayHelsinki: "2026-10-15" };
const post = (body: unknown, userId: string | null = VASCO) => ({
  method: "POST",
  userId,
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const get = (userId: string | null = VASCO) => ({ method: "GET", userId, body: "" });

const changed = (): Settings => ({
  ...settings,
  screen: {
    ...settings.screen,
    rules: [
      ...settings.screen.rules,
      { id: "natural-gas", activity: "Natural gas", description: "Gas", test: { kind: "role", roles: ["extracts", "sells"] } },
    ],
  },
});

describe("settings handler: access", () => {
  it.each([
    ["another user", OTHER],
    ["no user", null],
  ])("refuses %s with 403, for GET and POST, without touching the store", async (_name, userId) => {
    const store = await seeded();
    expect((await handleSettingsRequest(get(userId), store, ctx)).status).toBe(403);
    expect((await handleSettingsRequest(post({ settings: changed(), note: "x" }, userId), store, ctx)).status).toBe(403);
    expect(store.rows).toHaveLength(1);
    expect(store.atomicCalls).toBe(0);
  });

  it("fails closed with 500 when ALLOWED_USER_ID is not set", async () => {
    const store = await seeded();
    for (const allowedUserId of [undefined, ""]) {
      const result = await handleSettingsRequest(get(VASCO), store, { ...ctx, allowedUserId });
      expect(result.status).toBe(500);
    }
  });

  it("refuses other methods with 405", async () => {
    expect((await handleSettingsRequest({ method: "DELETE", userId: VASCO, body: "" }, await seeded(), ctx)).status).toBe(405);
  });
});

describe("settings handler: GET", () => {
  it("returns the current version, the lock state and the history", async () => {
    const store = await seeded();
    await store.insertVersion({ hash: await settingsHash(changed()), settings: changed(), note: "second" });
    const result = await handleSettingsRequest(get(), store, ctx);
    expect(result.status).toBe(200);
    const body = result.body as any;
    expect(body.current).toMatchObject({ id: 2, note: "second", hash: await settingsHash(changed()) });
    expect(body.current.settings).toEqual(changed());
    expect(body.current.payload).toBeUndefined();
    expect(body.locked).toBe(false);
    expect(body.versions.map((v: VersionSummary) => v.id)).toEqual([2, 1]);
  });

  it("reports the lock during a scored month", async () => {
    const store = await seeded();
    store.months = [{ startsOn: "2026-10-01", endsOn: "2026-10-31", endedEarlyAt: null }];
    expect(((await handleSettingsRequest(get(), store, ctx)).body as any).locked).toBe(true);
  });

  it("returns current null when nothing is stored", async () => {
    const body = (await handleSettingsRequest(get(), new FakeStore(), ctx)).body as any;
    expect(body).toEqual({ current: null, locked: false, versions: [] });
  });

  it("throws on a stored version the schema rejects (e.g. version 2, without a screen)", async () => {
    const store = new FakeStore();
    store.rows.push({ id: 2, hash: "h", note: null, createdAt: "2026-09-26T10:00:00.000Z", payload: { universe: settings.universe } });
    await expect(handleSettingsRequest(get(), store, ctx)).rejects.toThrow(/version 2 does not match/);
  });
});

describe("settings handler: POST", () => {
  it("stores a new version with its hash and note (201)", async () => {
    const store = await seeded();
    const result = await handleSettingsRequest(post({ settings: changed(), note: "Add natural gas" }), store, ctx);
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ created: true, version: { id: 2, note: "Add natural gas", hash: await settingsHash(changed()) } });
    expect(store.rows).toHaveLength(2);
    expect(store.rows[1]?.payload).toEqual(changed());
    expect(store.atomicCalls).toBe(1);
  });

  it("is a no-op on settings identical to the current version (200), even with keys in another order", async () => {
    const store = await seeded();
    const reordered = { screen: settings.screen, universe: settings.universe };
    const result = await handleSettingsRequest(post({ note: "again", settings: reordered }), store, ctx);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ created: false, version: { id: 1, hash: store.rows[0]?.hash, note: "seed", createdAt: store.rows[0]?.createdAt } });
    expect(store.rows).toHaveLength(1);
  });

  it("stores a revert to earlier settings as a new version", async () => {
    const store = await seeded();
    await handleSettingsRequest(post({ settings: changed(), note: "change" }), store, ctx);
    const result = await handleSettingsRequest(post({ settings, note: "revert" }), store, ctx);
    expect(result.status).toBe(201);
    expect(store.rows.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(store.rows[2]?.hash).toBe(store.rows[0]?.hash);
  });

  it("refuses to save during a scored month (409), and stores nothing", async () => {
    const store = await seeded();
    store.months = [{ startsOn: "2026-10-01", endsOn: "2026-10-31", endedEarlyAt: null }];
    const result = await handleSettingsRequest(post({ settings: changed(), note: "x" }), store, ctx);
    expect(result.status).toBe(409);
    expect((result.body as any).error).toMatch(/locked/);
    expect(store.rows).toHaveLength(1);
  });

  it("saves again once the month has been ended early", async () => {
    const store = await seeded();
    store.months = [{ startsOn: "2026-10-01", endsOn: "2026-10-31", endedEarlyAt: "2026-10-10T07:00:00Z" }];
    expect((await handleSettingsRequest(post({ settings: changed(), note: "x" }), store, ctx)).status).toBe(201);
  });

  it("refuses a body that is not JSON (400)", async () => {
    const result = await handleSettingsRequest(post("{not json"), await seeded(), ctx);
    expect(result).toEqual({ status: 400, body: { error: "Body is not JSON" } });
  });

  it.each([
    ["an empty note", { note: "" }, "note"],
    ["a blank note", { note: "   " }, "note"],
    ["no note", { note: undefined }, "note"],
  ])("refuses %s (400)", async (_name, extra, path) => {
    const store = await seeded();
    const result = await handleSettingsRequest(post({ settings: changed(), ...extra }), store, ctx);
    expect(result.status).toBe(400);
    expect((result.body as any).issues.map((i: any) => i.path.join("."))).toContain(path);
    expect(store.rows).toHaveLength(1);
  });

  it("returns zod issues with paths the page can map to fields (400)", async () => {
    const bad = changed() as any;
    bad.screen.rules[5].test = { kind: "revenue_share", maxPct: 150 };
    bad.screen.overrides = [{ isin: "FI0009000682", verdict: "include", reason: "r", decidedOn: "2026-10-01" }];
    const store = await seeded();
    const result = await handleSettingsRequest(post({ settings: bad, note: "x" }), store, ctx);
    expect(result.status).toBe(400);
    const body = result.body as any;
    expect(body.error).toBe("Settings are not valid");
    expect(body.issues).toEqual(
      expect.arrayContaining([
        { path: ["settings", "screen", "rules", 5, "test", "maxPct"], message: "Must be below 100" },
        { path: ["settings", "screen", "overrides", 0, "isin"], message: "ISIN check digit is wrong" },
      ]),
    );
    expect(store.rows).toHaveLength(1);
  });

  it("refuses unknown fields in the body (400)", async () => {
    const result = await handleSettingsRequest(post({ settings, note: "x", force: true }), await seeded(), ctx);
    expect(result.status).toBe(400);
  });
});
