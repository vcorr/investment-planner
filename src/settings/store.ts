import { desc } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { settingsVersions } from "../db/schema.js";
import { hashSettings, settingsSchema, type Settings } from "./settings.js";

/**
 * Saves settings as a new version unless they equal the current (latest) version.
 * Reverting to an earlier set of settings therefore creates a new version, which becomes current.
 */
export async function saveSettings(db: Db, settings: Settings, note: string) {
  const valid = settingsSchema.parse(settings);
  const hash = hashSettings(valid);
  const current = await latestVersionRow(db);
  if (current?.hash === hash) return { id: current.id, hash, created: false };
  const [row] = await db.insert(settingsVersions).values({ hash, payload: valid, note }).returning();
  if (!row) throw new Error("Settings insert returned no row");
  return { id: row.id, hash, created: true };
}

export async function latestSettings(db: Db): Promise<{ id: number; hash: string; settings: Settings }> {
  const row = await latestVersionRow(db);
  if (!row) throw new Error("No settings saved yet. Run `pnpm job:seed-sample` first.");
  return { id: row.id, hash: row.hash, settings: settingsSchema.parse(row.payload) };
}

async function latestVersionRow(db: Db) {
  const [row] = await db.select().from(settingsVersions).orderBy(desc(settingsVersions.id)).limit(1);
  return row;
}
