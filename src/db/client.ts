import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { loadEnv } from "../config/env.js";
import * as schema from "./schema.js";

export function connect() {
  const { DATABASE_URL } = loadEnv();
  // Supabase session pooler: IPv4, TLS required.
  const sql = postgres(DATABASE_URL, { ssl: "require", max: 5, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  return { db, close: () => sql.end() };
}

export type Db = ReturnType<typeof connect>["db"];
