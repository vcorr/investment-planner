import { readFileSync } from "node:fs";
import { connect } from "../db/client.js";

// Stores the news-poller URL and key in Supabase Vault, then applies supabase/sql/schedule-news-poller.sql.
// The key is read from NEWS_POLLER_KEY and never printed. Usage:
//   NEWS_POLLER_KEY="$(supabase projects api-keys --project-ref <ref> --reveal -o json | ...)" pnpm job:schedule-news-poller

const PROJECT_URL = "https://mzuapexiltbhuebgyowe.supabase.co";
const key = process.env.NEWS_POLLER_KEY;
if (!key?.startsWith("sb_secret_")) throw new Error("NEWS_POLLER_KEY must hold the project's default secret key (sb_secret_...)");

const secrets = { news_poller_url: `${PROJECT_URL}/functions/v1/news-poller`, news_poller_key: key };

const { db, close } = connect();
const sql = db.$client;
try {
  for (const [name, value] of Object.entries(secrets)) {
    const [existing] = await sql<{ id: string }[]>`select id from vault.secrets where name = ${name}`;
    if (existing) await sql`select vault.update_secret(${existing.id}::uuid, ${value})`;
    else await sql`select vault.create_secret(${value}, ${name})`;
    console.log(`Vault secret ${name}: ${existing ? "updated" : "created"}`);
  }
  await sql.unsafe(readFileSync("supabase/sql/schedule-news-poller.sql", "utf8"));
  const jobs = await sql<{ jobname: string; schedule: string; active: boolean }[]>`
    select jobname, schedule, active from cron.job where jobname = 'news-poller'`;
  console.log("Cron job:", jobs);
} finally {
  await close();
}
