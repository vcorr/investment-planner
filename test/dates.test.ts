import { describe, expect, it } from "vitest";
import { helsinkiDate } from "../src/util/dates.js";

describe("helsinkiDate", () => {
  it("uses the Helsinki calendar day, not UTC", () => {
    // 22:30 UTC on 1 Oct is 01:30 on 2 Oct in Helsinki (EEST, UTC+3).
    expect(helsinkiDate(0, new Date("2026-10-01T22:30:00Z"))).toBe("2026-10-02");
  });

  it("gives yesterday across the spring daylight-saving change", () => {
    // 00:30 EEST on Mon 29 Mar 2027; clocks moved forward on Sun 28 Mar.
    expect(helsinkiDate(-1, new Date("2027-03-28T21:30:00Z"))).toBe("2027-03-28");
  });

  it("gives yesterday across the autumn daylight-saving change", () => {
    // 23:30 EET on Sun 25 Oct 2026; clocks moved back that morning.
    expect(helsinkiDate(-1, new Date("2026-10-25T21:30:00Z"))).toBe("2026-10-24");
  });

  it("crosses month and year ends", () => {
    expect(helsinkiDate(-1, new Date("2027-01-01T10:00:00Z"))).toBe("2026-12-31");
  });
});
