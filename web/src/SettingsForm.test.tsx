// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsState } from "../../supabase/functions/_shared/settings-handler.ts";
import { DEFAULT_SCREEN, type Settings } from "../../supabase/functions/_shared/settings.ts";
import type { SaveResponse } from "./api.ts";
import { SettingsForm } from "./SettingsForm.tsx";

const settings: Settings = {
  universe: {
    mode: "sample",
    listings: [
      { market: "HEL", symbol: "NOKIA", orderbookId: "TX50063" },
      { market: "STO", symbol: "ERIC B", orderbookId: "TX69" },
    ],
  },
  screen: DEFAULT_SCREEN,
};

const state = (locked: boolean): SettingsState => ({
  current: { id: 3, hash: "a".repeat(64), createdAt: "2026-09-27T09:00:00.000Z", note: "seed", settings },
  locked,
  versions: [
    { id: 3, hash: "a".repeat(64), createdAt: "2026-09-27T09:00:00.000Z", note: "seed" },
    { id: 2, hash: "b".repeat(64), createdAt: "2026-09-26T09:00:00.000Z", note: "sample" },
  ],
});

afterEach(cleanup);

describe("SettingsForm", () => {
  it("renders the universe, rules and history, validates, and saves a new rule with a note", async () => {
    const onSave = vi.fn(
      async (): Promise<SaveResponse> => ({
        ok: true,
        result: { created: true, version: { id: 4, hash: "c".repeat(64), createdAt: "2026-09-27T10:00:00.000Z", note: "n" } },
      }),
    );
    render(<SettingsForm state={state(false)} onSave={onSave} />);

    // Universe (read-only), the five default rules and the version history.
    expect(screen.getByText("ERIC B")).toBeTruthy();
    expect(screen.getAllByLabelText("Activity").map((i) => (i as HTMLInputElement).value)).toEqual([
      "Fossil fuels",
      "Weapons and defence",
      "Mining",
      "Pesticides",
      "Tobacco",
    ]);
    expect(screen.getByText("sample")).toBeTruthy();

    // Add a rule for natural gas with a role test; saving without a note is refused locally.
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    const rule = within(screen.getByTestId("rule-5"));
    fireEvent.change(rule.getByLabelText("Id"), { target: { value: "natural-gas" } });
    fireEvent.change(rule.getByLabelText("Activity"), { target: { value: "Natural gas" } });
    fireEvent.change(rule.getByLabelText("Description"), { target: { value: "Extraction and sale of natural gas" } });
    fireEvent.change(rule.getByLabelText("Test"), { target: { value: "role" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Choose at least one role")).toBeTruthy();
    expect(screen.getAllByText("A change note is required").length).toBeGreaterThan(0);
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.click(rule.getByLabelText("extracts"));
    fireEvent.change(screen.getByLabelText("Change note (required)"), { target: { value: "Add natural gas" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved as version 4.")).toBeTruthy();
    expect(onSave).toHaveBeenCalledTimes(1);
    const [saved, note] = onSave.mock.calls[0] as unknown as [Settings, string];
    expect(note).toBe("Add natural gas");
    expect(saved.screen.rules.at(-1)).toEqual({
      id: "natural-gas",
      activity: "Natural gas",
      description: "Extraction and sale of natural gas",
      test: { kind: "role", roles: ["extracts"] },
    });
  });

  it("checks the ISIN format before an override can be added", () => {
    render(<SettingsForm state={state(false)} onSave={vi.fn()} />);
    const isin = screen.getByLabelText("ISIN");
    fireEvent.change(isin, { target: { value: "FI0009000682" } });
    expect(screen.getByText("ISIN check digit is wrong")).toBeTruthy();
    fireEvent.change(isin, { target: { value: "fi000900068" } });
    expect(screen.getByText(/Not an ISIN/)).toBeTruthy();
    fireEvent.change(isin, { target: { value: "FI0009000681" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Reviewed" } });
    fireEvent.click(screen.getByRole("button", { name: "Add override" }));
    expect(screen.getByText("FI0009000681")).toBeTruthy();
  });

  it("is read-only while a scored month runs", () => {
    render(<SettingsForm state={state(true)} onSave={vi.fn()} />);
    expect(screen.getByText(/Settings are locked/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }).closest("fieldset") as HTMLFieldSetElement).disabled).toBe(true);
  });
});
