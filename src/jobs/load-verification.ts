import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { connect } from "../db/client.js";
import { verificationLog } from "../db/schema.js";
import { parseVerificationMarkdown } from "../verification/parse.js";

const SOURCE = "docs/verification.md";

const rows = parseVerificationMarkdown(readFileSync(SOURCE, "utf8"));
const { db, close } = connect();
try {
  for (const row of rows) {
    await db
      .insert(verificationLog)
      .values({ ...row, source: SOURCE })
      .onConflictDoUpdate({
        target: verificationLog.id,
        set: { item: row.item, finding: row.finding, status: row.status, source: SOURCE, loadedAt: sql`now()` },
      });
  }
  console.log(`Loaded ${rows.length} verification rows (${rows[0]?.id} to ${rows.at(-1)?.id})`);
} finally {
  await close();
}
