import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  // Core tables, plus one file per task under src/db/tables/.
  schema: ["./src/db/schema.ts", "./src/db/tables/*.ts"],
  out: "./migrations",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
