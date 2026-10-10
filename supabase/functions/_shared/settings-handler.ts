// Request logic of the `settings` Edge Function, kept free of Deno, Postgres and HTTP so Node tests can run it
// against a fake store. The function's index.ts supplies the signed-in user, the store and today's date.

import { z } from "zod";
import { settingsHash, settingsLocked, settingsSchema, type ScoredMonth, type Settings } from "./settings.ts";

export interface VersionSummary {
  id: number;
  hash: string;
  /** ISO 8601, UTC. */
  createdAt: string;
  note: string | null;
}

export interface StoredVersion extends VersionSummary {
  /** Raw JSON from the database; validated here before it is returned. */
  payload: unknown;
}

export interface SettingsStore {
  /** The highest id, or null when nothing has been saved yet. */
  currentVersion(): Promise<StoredVersion | null>;
  /** Every version, newest first. */
  listVersions(): Promise<VersionSummary[]>;
  scoredMonths(): Promise<ScoredMonth[]>;
  insertVersion(version: { hash: string; settings: Settings; note: string }): Promise<VersionSummary>;
  /**
   * Runs `fn` so that no other save can interleave with it (the real store: one transaction under an
   * advisory lock). The lock check, the comparison with the current version and the insert all run inside.
   */
  atomically<T>(fn: (store: SettingsStore) => Promise<T>): Promise<T>;
}

export interface SettingsRequest {
  method: string;
  /** From the verified JWT; null when there is none. */
  userId: string | null;
  /** Raw request body; only read for POST. */
  body: string;
}

export interface SettingsContext {
  /** The only user allowed in (ALLOWED_USER_ID). Empty or missing is a configuration error, never "allow all". */
  allowedUserId: string | undefined;
  /** Helsinki calendar date, YYYY-MM-DD. */
  todayHelsinki: string;
}

export interface Issue {
  path: (string | number)[];
  message: string;
}

export interface HandlerResult {
  status: number;
  body: unknown;
}

/** GET response. */
export interface SettingsState {
  current: (VersionSummary & { settings: Settings }) | null;
  locked: boolean;
  versions: VersionSummary[];
}

/** POST response (200 when unchanged, 201 when a new version was stored). */
export interface SaveResult {
  created: boolean;
  version: VersionSummary;
}

/** Error body. `issues` is present for validation errors (400). */
export interface ErrorBody {
  error: string;
  issues?: Issue[];
}

const saveBodySchema = z.strictObject({
  settings: settingsSchema,
  note: z.string().regex(/\S/, "A change note is required"),
});

export function toIssues(error: z.ZodError): Issue[] {
  return error.issues.map((i) => ({
    path: i.path.map((p) => (typeof p === "number" ? p : String(p))),
    message: i.message,
  }));
}

const fail = (status: number, error: string, issues?: Issue[]): HandlerResult => ({
  status,
  body: issues ? { error, issues } : { error },
});

export async function handleSettingsRequest(
  req: SettingsRequest,
  store: SettingsStore,
  ctx: SettingsContext,
): Promise<HandlerResult> {
  if (!ctx.allowedUserId) return fail(500, "ALLOWED_USER_ID is not set");
  if (req.userId === null || req.userId !== ctx.allowedUserId) return fail(403, "This user may not use the settings");

  if (req.method === "GET") return { status: 200, body: await readState(store, ctx.todayHelsinki) };
  if (req.method !== "POST") return fail(405, `Method ${req.method} is not allowed`);
  return store.atomically((tx) => save(req.body, tx, ctx.todayHelsinki));
}

async function save(body: string, store: SettingsStore, todayHelsinki: string): Promise<HandlerResult> {
  // Checked first: during a scored month no save is accepted, whatever it contains (brief §11).
  if (settingsLocked(await store.scoredMonths(), todayHelsinki)) {
    return fail(409, "Settings are locked: a scored month is running. Any change would void it.");
  }

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return fail(400, "Body is not JSON");
  }
  const parsed = saveBodySchema.safeParse(json);
  if (!parsed.success) return fail(400, "Settings are not valid", toIssues(parsed.error));
  const { settings, note } = parsed.data;

  const hash = await settingsHash(settings);
  const current = await store.currentVersion();
  if (current?.hash === hash) {
    const { payload: _payload, ...version } = current;
    return { status: 200, body: { created: false, version } satisfies SaveResult };
  }
  const version = await store.insertVersion({ hash, settings, note });
  return { status: 201, body: { created: true, version } satisfies SaveResult };
}

async function readState(store: SettingsStore, todayHelsinki: string): Promise<SettingsState> {
  const [current, versions, months] = await Promise.all([store.currentVersion(), store.listVersions(), store.scoredMonths()]);
  let currentState: SettingsState["current"] = null;
  if (current) {
    const parsed = settingsSchema.safeParse(current.payload);
    // A stored version the schema rejects is a data problem to fix, not something to paper over.
    if (!parsed.success) {
      throw new Error(`Settings version ${current.id} does not match the schema: ${z.prettifyError(parsed.error)}`);
    }
    const { payload: _payload, ...summary } = current;
    currentState = { ...summary, settings: parsed.data };
  }
  return { current: currentState, locked: settingsLocked(months, todayHelsinki), versions };
}
