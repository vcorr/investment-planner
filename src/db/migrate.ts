import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connect } from "./client.js";

const { db, close } = connect();
try {
  await migrate(db, { migrationsFolder: "./migrations" });
  console.log("Migrations applied");
} finally {
  await close();
}
