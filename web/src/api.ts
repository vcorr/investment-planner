import type { ErrorBody, SaveResult, SettingsState } from "../../supabase/functions/_shared/settings-handler.ts";
import type { Settings } from "../../supabase/functions/_shared/settings.ts";

// Calls the `settings` Edge Function with the signed-in user's access token.

export type SaveResponse =
  | { ok: true; result: SaveResult }
  | { ok: false; status: number; error: ErrorBody };

export interface SettingsApi {
  load(): Promise<SettingsState>;
  save(settings: Settings, note: string): Promise<SaveResponse>;
}

export function createSettingsApi(opts: {
  supabaseUrl: string;
  publishableKey: string;
  accessToken: () => Promise<string>;
  fetchFn?: typeof fetch;
}): SettingsApi {
  const url = `${opts.supabaseUrl.replace(/\/$/, "")}/functions/v1/settings`;
  const doFetch = opts.fetchFn ?? fetch;

  async function call(init: RequestInit): Promise<Response> {
    return doFetch(url, {
      ...init,
      headers: {
        apikey: opts.publishableKey,
        Authorization: `Bearer ${await opts.accessToken()}`,
        "Content-Type": "application/json",
      },
    });
  }

  return {
    async load() {
      const response = await call({ method: "GET" });
      const body = await readJson(response);
      if (!response.ok) throw new Error(errorText(response.status, body));
      return body as SettingsState;
    },
    async save(settings, note) {
      const response = await call({ method: "POST", body: JSON.stringify({ settings, note }) });
      const body = await readJson(response);
      if (response.ok) return { ok: true, result: body as SaveResult };
      return { ok: false, status: response.status, error: isErrorBody(body) ? body : { error: errorText(response.status, body) } };
    },
  };
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function isErrorBody(body: unknown): body is ErrorBody {
  return typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string";
}

function errorText(status: number, body: unknown): string {
  if (isErrorBody(body)) return `HTTP ${status}: ${body.error}`;
  // withSupabase's own auth errors use `message`.
  const message = typeof body === "object" && body !== null ? (body as { message?: unknown }).message : undefined;
  return `HTTP ${status}${typeof message === "string" ? `: ${message}` : ""}`;
}
