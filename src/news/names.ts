// Company-name normalisation for linking announcements to listings (brief §8.3).
// The announcement API carries no ISIN (V23), only the company name and the market label.

export type Exchange = "HEL" | "STO" | "CPH";

/** Market labels exactly as the announcement API writes them (V24), mapped to our exchanges. */
const NEWS_MARKET_EXCHANGE: ReadonlyMap<string, { exchange: Exchange; segment: "MAIN_MARKET" | "FIRST_NORTH" }> = new Map([
  ["Main Market, Helsinki", { exchange: "HEL", segment: "MAIN_MARKET" }],
  ["Main Market, Stockholm", { exchange: "STO", segment: "MAIN_MARKET" }],
  ["Main Market, Copenhagen", { exchange: "CPH", segment: "MAIN_MARKET" }],
  ["First North Finland", { exchange: "HEL", segment: "FIRST_NORTH" }],
  ["First North Sweden", { exchange: "STO", segment: "FIRST_NORTH" }],
  ["First North Denmark", { exchange: "CPH", segment: "FIRST_NORTH" }],
] as const);

/** Exchange and segment for an announcement's market label, or null for markets outside scope (Baltic, Iceland). */
export function newsMarket(label: string): { exchange: Exchange; segment: "MAIN_MARKET" | "FIRST_NORTH" } | null {
  return NEWS_MARKET_EXCHANGE.get(label) ?? null;
}

/**
 * Legal-form words, removed from either end of a name. Finnish (Oyj, Oy, Abp, Ab), Swedish (AB, Aktiebolag, publ),
 * Danish and Norwegian (A/S, AS, ASA), and the foreign forms seen in the share lists and announcements.
 * "a s" is A/S after punctuation has become spaces.
 */
const LEGAL_FORMS: readonly (readonly string[])[] = [
  ["a", "s"],
  ["oyj"],
  ["oy"],
  ["abp"],
  ["ab"],
  ["aktiebolag"],
  ["publ"],
  ["asa"],
  ["as"],
  ["plc"],
  ["ltd"],
  ["inc"],
  ["corp"],
  ["se"],
  ["nv"],
  ["bv"],
  ["b", "v"],
  ["hf"],
];

/**
 * Share-class and instrument words, removed from the end only: class letters (Kesko Oyj A, Volvo B, Stora Enso R,
 * Byggmästare A J Ahlström H), preference and ordinary shares (Pref, Stam), depositary receipts (SDB, FDR),
 * "ser." (series) and "Vaihto-osake". Removing them gives every class of a company one key, so an announcement
 * links to all its classes.
 */
const CLASS_WORDS: readonly (readonly string[])[] = [
  ["a"],
  ["b"],
  ["c"],
  ["d"],
  ["h"],
  ["k"],
  ["r"],
  ["pref"],
  ["stam"],
  ["sdb"],
  ["fdr"],
  ["ser"],
  ["vaihto", "osake"],
];

/** Letters that Unicode decomposition does not fold to ASCII. */
const EXTRA_FOLDS: Readonly<Record<string, string>> = { ø: "o", æ: "ae", ß: "ss", ð: "d", þ: "th", ł: "l", đ: "d" };

/** Lower case, accents folded, every run of punctuation or spaces turned into one space. */
export function foldText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[øæßðþłđ]/g, (c) => EXTRA_FOLDS[c] ?? c)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Key used to compare an announcement's company with a listing's full name: folded text, then legal forms
 * removed from both ends and class words from the end, until nothing more changes. Never removes the last word,
 * so "AB" or "A" alone stays a key. Returns null for a name with no letters or digits.
 */
export function companyKey(name: string): string | null {
  const words = foldText(name).split(" ").filter((w) => w !== "");
  if (words.length === 0) return null;
  let changed = true;
  while (changed && words.length > 1) {
    changed = false;
    for (const suffix of [...LEGAL_FORMS, ...CLASS_WORDS]) {
      if (words.length > suffix.length && endsWith(words, suffix)) {
        words.splice(words.length - suffix.length, suffix.length);
        changed = true;
        break;
      }
    }
    if (changed) continue;
    for (const prefix of LEGAL_FORMS) {
      if (words.length > prefix.length && startsWith(words, prefix)) {
        words.splice(0, prefix.length);
        changed = true;
        break;
      }
    }
  }
  return words.join(" ");
}

function endsWith(words: readonly string[], suffix: readonly string[]): boolean {
  const offset = words.length - suffix.length;
  return suffix.every((w, i) => words[offset + i] === w);
}

function startsWith(words: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((w, i) => words[i] === w);
}
