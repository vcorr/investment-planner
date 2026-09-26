import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseVerificationMarkdown } from "../src/verification/parse.js";

describe("parseVerificationMarkdown", () => {
  it("reads id, item, finding and status", () => {
    const rows = parseVerificationMarkdown("| # | Item | Finding | Status |\n|---|---|---|---|\n| V1 | Fees | 0.20 % | SOURCED |\n");
    expect(rows).toEqual([{ id: "V1", item: "Fees", finding: "0.20 %", status: "SOURCED" }]);
  });

  it("keeps escaped pipes inside a cell", () => {
    const [row] = parseVerificationMarkdown("| V2 | a \\| b | c | d |");
    expect(row?.item).toBe("a | b");
  });

  it("rejects a row with extra columns", () => {
    expect(() => parseVerificationMarkdown("| V3 | a | b | c | d |")).toThrow(/4 columns/);
  });

  it("parses the real log with unique ids", () => {
    const rows = parseVerificationMarkdown(readFileSync("docs/verification.md", "utf8"));
    expect(rows.length).toBeGreaterThanOrEqual(22);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });
});
