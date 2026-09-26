import { existsSync } from "node:fs";
import { z } from "zod";

// Locally the values come from .env; in Cloud Run they are injected as environment variables.
if (existsSync(".env")) process.loadEnvFile(".env");

const envSchema = z.object({
  DATABASE_URL: z.string().startsWith("postgresql://"),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Missing or invalid environment variables: ${fields}`);
  }
  return parsed.data;
}
