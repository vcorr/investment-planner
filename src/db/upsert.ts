import { getTableColumns, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

/**
 * `SET col = excluded.col` for every column except the conflict keys, so a batch insert
 * can update existing rows in a single statement.
 */
export function excludedSet<T extends PgTable>(table: T, keys: ReadonlyArray<string>): Record<string, SQL> {
  const set: Record<string, SQL> = {};
  for (const [property, column] of Object.entries(getTableColumns(table))) {
    if (keys.includes(property)) continue;
    set[property] = sql.raw(`excluded."${column.name}"`);
  }
  return set;
}
