import { createHash } from "node:crypto";
import { canonicalJson, type Settings } from "../../supabase/functions/_shared/settings.js";

// Settings live in the database as versioned, hashed snapshots (amendment A11).
// The schema is defined once in supabase/functions/_shared/settings.ts, so the Edge Function,
// the web page and Node use the same definition; this module re-exports it for Node.

export {
  canonicalJson,
  DEFAULT_SCREEN,
  isValidIsin,
  settingsLocked,
  settingsSchema,
  type ListingRef,
  type Screen,
  type ScreenOverride,
  type ScreenRule,
  type ScreenTest,
  type ScoredMonth,
  type Settings,
} from "../../supabase/functions/_shared/settings.js";

/** SHA-256 of the canonical JSON, hex. Same result as the shared, asynchronous `settingsHash` (tested). */
export function hashSettings(settings: Settings): string {
  return createHash("sha256").update(canonicalJson(settings)).digest("hex");
}
