import { useState } from "react";
import type { Issue, SettingsState, VersionSummary } from "../../supabase/functions/_shared/settings-handler.ts";
import {
  helsinkiToday,
  isValidIsin,
  ISIN_PATTERN,
  SCREEN_ROLES,
  settingsSchema,
  type ScreenOverride,
  type ScreenRole,
  type ScreenRule,
  type ScreenTest,
  type Settings,
} from "../../supabase/functions/_shared/settings.ts";
import type { SaveResponse } from "./api.ts";

// The settings form: universe (read-only), screen rules, overrides, change note and version history.
// Validation uses the same schema as the Edge Function; the function checks again on save.

interface Props {
  state: SettingsState;
  onSave: (settings: Settings, note: string) => Promise<SaveResponse>;
}

type Kind = ScreenTest["kind"];

const KIND_LABELS: Record<Kind, string> = {
  any_involvement: "Any involvement",
  revenue_share: "Revenue share above a limit",
  role: "Role in the activity",
};

/** A fresh test of the chosen kind. Numbers and roles start empty: Vasco fills them in. */
function blankTest(kind: Kind): ScreenTest {
  if (kind === "revenue_share") return { kind, maxPct: Number.NaN };
  if (kind === "role") return { kind, roles: [] };
  return { kind };
}

const pathKey = (path: readonly (string | number)[]) => path.join(".");

export function SettingsForm({ state, onSave }: Props) {
  const current = state.current;
  const [draft, setDraft] = useState<Settings | null>(current ? structuredClone(current.settings) : null);
  const [note, setNote] = useState("");
  const [issues, setIssues] = useState<Issue[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!current || !draft) {
    return <p>No settings are stored yet. Run <code>pnpm job:seed-sample</code> first.</p>;
  }

  const locked = state.locked;
  const issueFor = (...path: (string | number)[]) => issues.find((i) => pathKey(i.path) === pathKey(path))?.message;

  const setRules = (rules: ScreenRule[]) => setDraft({ ...draft, screen: { ...draft.screen, rules } });
  const setOverrides = (overrides: ScreenOverride[]) => setDraft({ ...draft, screen: { ...draft.screen, overrides } });
  const updateRule = (i: number, rule: ScreenRule) => setRules(draft.screen.rules.map((r, j) => (j === i ? rule : r)));

  async function save() {
    setMessage(null);
    const body = { settings: draft, note };
    const parsed = settingsSchema.safeParse(body.settings);
    const local: Issue[] = parsed.success
      ? []
      : parsed.error.issues.map((i) => ({ path: ["settings", ...i.path.map((p) => (typeof p === "number" ? p : String(p)))], message: i.message }));
    if (!/\S/.test(note)) local.push({ path: ["note"], message: "A change note is required" });
    setIssues(local);
    if (local.length > 0 || !parsed.success) {
      setMessage("Not saved: please correct the fields marked below.");
      return;
    }
    setSaving(true);
    try {
      const response = await onSave(parsed.data, note);
      if (response.ok) {
        const { created, version } = response.result;
        setMessage(created ? `Saved as version ${version.id}.` : `No change: identical to version ${version.id}, so nothing was saved.`);
        if (created) setNote("");
      } else {
        setIssues(response.error.issues ?? []);
        setMessage(`Not saved (HTTP ${response.status}): ${response.error.error}`);
      }
    } catch (error) {
      setMessage(`Not saved: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <p>
        Current version <strong>{current.id}</strong>, saved {formatTime(current.createdAt)}, hash{" "}
        <code>{current.hash.slice(0, 12)}</code>
        {current.note ? <> ({current.note})</> : null}.
      </p>
      {locked ? (
        <p role="status" className="locked">
          Settings are locked: a scored month is running, and any change would void it. The form is read-only.
        </p>
      ) : null}

      <h2>Universe</h2>
      <p>Mode: {draft.universe.mode}. Read-only here.</p>
      <table>
        <thead>
          <tr>
            <th>Market</th>
            <th>Symbol</th>
            <th>Order book</th>
          </tr>
        </thead>
        <tbody>
          {draft.universe.listings.map((l) => (
            <tr key={l.orderbookId}>
              <td>{l.market}</td>
              <td>{l.symbol}</td>
              <td>{l.orderbookId}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <fieldset disabled={locked || saving}>
        <legend>Ethical screen</legend>
        <p>
          Borderline cases: <strong>excluded until reviewed</strong> (brief §7.2). Overrides always win over the rules.
        </p>

        <h2>Rules</h2>
        {draft.screen.rules.length === 0 ? <p>No rules: every company passes the screen.</p> : null}
        {draft.screen.rules.map((rule, i) => (
          <RuleEditor
            key={i}
            index={i}
            rule={rule}
            issueFor={issueFor}
            onChange={(r) => updateRule(i, r)}
            onRemove={() => setRules(draft.screen.rules.filter((_, j) => j !== i))}
          />
        ))}
        <button
          type="button"
          onClick={() => setRules([...draft.screen.rules, { id: "", activity: "", description: "", test: { kind: "any_involvement" } }])}
        >
          Add rule
        </button>

        <h2>Overrides</h2>
        <OverridesEditor
          overrides={draft.screen.overrides}
          issueFor={issueFor}
          onChange={setOverrides}
        />

        <h2>Save</h2>
        <label>
          Change note (required)
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
        </label>
        <FieldError text={issueFor("note")} />
        <button type="button" onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </button>
      </fieldset>

      {message ? <p role="alert">{message}</p> : null}
      {issues.length > 0 ? (
        <ul className="issues">
          {issues.map((i, n) => (
            <li key={n}>
              <code>{pathKey(i.path) || "(body)"}</code>: {i.message}
            </li>
          ))}
        </ul>
      ) : null}

      <h2>Version history</h2>
      <VersionTable versions={state.versions} />
    </div>
  );
}

type IssueFor = (...path: (string | number)[]) => string | undefined;

function RuleEditor(props: {
  index: number;
  rule: ScreenRule;
  issueFor: IssueFor;
  onChange: (rule: ScreenRule) => void;
  onRemove: () => void;
}) {
  const { index, rule, issueFor, onChange } = props;
  const at = (...rest: (string | number)[]) => issueFor("settings", "screen", "rules", index, ...rest);
  const test = rule.test;

  return (
    <div className="rule" data-testid={`rule-${index}`}>
      <label>
        Id
        <input value={rule.id} onChange={(e) => onChange({ ...rule, id: e.target.value })} placeholder="e.g. natural-gas" />
      </label>
      <FieldError text={at("id")} />
      <label>
        Activity
        <input value={rule.activity} onChange={(e) => onChange({ ...rule, activity: e.target.value })} />
      </label>
      <FieldError text={at("activity")} />
      <label>
        Description
        <textarea value={rule.description} rows={2} onChange={(e) => onChange({ ...rule, description: e.target.value })} />
      </label>
      <FieldError text={at("description")} />
      <label>
        Test
        <select value={test.kind} onChange={(e) => onChange({ ...rule, test: blankTest(e.target.value as Kind) })}>
          {(Object.keys(KIND_LABELS) as Kind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </label>
      {test.kind === "revenue_share" ? (
        <>
          <label>
            Excluded above this share of revenue (%)
            <input
              type="number"
              min={0}
              max={100}
              step="any"
              value={Number.isNaN(test.maxPct) ? "" : test.maxPct}
              onChange={(e) => onChange({ ...rule, test: { kind: "revenue_share", maxPct: e.target.value === "" ? Number.NaN : Number(e.target.value) } })}
            />
          </label>
          <FieldError text={at("test", "maxPct")} />
        </>
      ) : null}
      {test.kind === "role" ? (
        <>
          <div>
            Excluded when the company:{" "}
            {SCREEN_ROLES.map((role) => (
              <label key={role} className="inline">
                <input
                  type="checkbox"
                  checked={test.roles.includes(role)}
                  onChange={(e) => {
                    const roles: ScreenRole[] = e.target.checked
                      ? SCREEN_ROLES.filter((r) => r === role || test.roles.includes(r))
                      : test.roles.filter((r) => r !== role);
                    onChange({ ...rule, test: { kind: "role", roles } });
                  }}
                />
                {role}
              </label>
            ))}
          </div>
          <FieldError text={at("test", "roles")} />
        </>
      ) : null}
      <label>
        Notes (optional)
        <textarea
          value={rule.notes ?? ""}
          rows={2}
          onChange={(e) => {
            const { notes: _old, ...rest } = rule;
            onChange(e.target.value === "" ? rest : { ...rest, notes: e.target.value });
          }}
        />
      </label>
      <FieldError text={at("notes")} />
      <button type="button" onClick={props.onRemove}>
        Remove rule
      </button>
    </div>
  );
}

function OverridesEditor(props: {
  overrides: ScreenOverride[];
  issueFor: IssueFor;
  onChange: (overrides: ScreenOverride[]) => void;
}) {
  const { overrides, issueFor, onChange } = props;
  const [isin, setIsin] = useState("");
  const [verdict, setVerdict] = useState<ScreenOverride["verdict"]>("exclude");
  const [reason, setReason] = useState("");
  const [decidedOn, setDecidedOn] = useState(helsinkiToday());

  const isinError =
    isin === "" ? undefined : !ISIN_PATTERN.test(isin) ? "Not an ISIN: 2 letters, 9 letters or digits, 1 digit" : !isValidIsin(isin) ? "ISIN check digit is wrong" : overrides.some((o) => o.isin === isin) ? "This ISIN already has an override" : undefined;
  const canAdd = isin !== "" && !isinError && /\S/.test(reason) && decidedOn !== "";

  return (
    <div>
      {overrides.length === 0 ? <p>No overrides.</p> : null}
      {overrides.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>ISIN</th>
              <th>Verdict</th>
              <th>Reason</th>
              <th>Decided on</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {overrides.map((o, i) => (
              <tr key={o.isin}>
                <td>
                  {o.isin}
                  <FieldError text={issueFor("settings", "screen", "overrides", i, "isin")} />
                </td>
                <td>{o.verdict}</td>
                <td>{o.reason}</td>
                <td>{o.decidedOn}</td>
                <td>
                  <button type="button" onClick={() => onChange(overrides.filter((_, j) => j !== i))}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <div className="add-override">
        <label>
          ISIN
          <input value={isin} onChange={(e) => setIsin(e.target.value.trim().toUpperCase())} placeholder="FI0009000681" />
        </label>
        <FieldError text={isinError} />
        <label>
          Verdict
          <select value={verdict} onChange={(e) => setVerdict(e.target.value as ScreenOverride["verdict"])}>
            <option value="exclude">exclude</option>
            <option value="include">include</option>
          </select>
        </label>
        <label>
          Reason
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <label>
          Decided on
          <input type="date" value={decidedOn} onChange={(e) => setDecidedOn(e.target.value)} />
        </label>
        <button
          type="button"
          disabled={!canAdd}
          onClick={() => {
            onChange([...overrides, { isin, verdict, reason, decidedOn }]);
            setIsin("");
            setReason("");
          }}
        >
          Add override
        </button>
      </div>
    </div>
  );
}

function VersionTable({ versions }: { versions: VersionSummary[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Version</th>
          <th>Saved</th>
          <th>Note</th>
          <th>Hash</th>
        </tr>
      </thead>
      <tbody>
        {versions.map((v) => (
          <tr key={v.id}>
            <td>{v.id}</td>
            <td>{formatTime(v.createdAt)}</td>
            <td>{v.note ?? ""}</td>
            <td>
              <code title={v.hash}>{v.hash.slice(0, 12)}</code>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FieldError({ text }: { text: string | undefined }) {
  return text ? <span className="field-error">{text}</span> : null;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { timeZone: "Europe/Helsinki", dateStyle: "medium", timeStyle: "short" });
}
