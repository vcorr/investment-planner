import { describe, expect, it } from "vitest";
import { canonicalJson, hashSettings, type Settings } from "../src/settings/settings.js";

const settings: Settings = {
  universe: { mode: "sample", listings: [{ market: "HEL", symbol: "NOKIA", orderbookId: "TX50063" }] },
};

describe("settings hash", () => {
  it("ignores key order", () => {
    const reordered = {
      universe: { listings: [{ orderbookId: "TX50063", symbol: "NOKIA", market: "HEL" }], mode: "sample" },
    } as Settings;
    expect(hashSettings(reordered)).toBe(hashSettings(settings));
  });

  it("changes when any value changes", () => {
    const changed: Settings = {
      universe: { mode: "sample", listings: [{ market: "HEL", symbol: "NOKIA", orderbookId: "TX50064" }] },
    };
    expect(hashSettings(changed)).not.toBe(hashSettings(settings));
  });

  it("keeps array order, which is meaningful", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });
});
