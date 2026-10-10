import { companyKey, foldText } from "./names.js";

// Near-duplicate flagging (brief §8.2). Items are flagged, never deleted: each group of duplicates keeps one
// primary, and the others point to it. Three pair rules, all within the same company (by `companyKey`):
//   translation   - different languages, released within `translationWindowSeconds` of each other
//                   (one release issued in Finnish and English under two disclosure IDs);
//   same_headline - near-identical headlines released within `sameHeadlineWindowSeconds`
//                   (one release posted twice, e.g. under two markets);
//   correction    - the later headline starts with a correction word and, without it, is near-identical to an
//                   earlier headline released up to `correctionWindowHours` before (a corrected reissue).
// A burst of same-company items in which one language carries two different headlines (two releases, each in
// two languages, at the same second) cannot be paired by language alone, so the translation rule skips it.
// The primary is the earliest item; ties go to the English item, then to the lower disclosure ID.

export interface DedupThresholds {
  translationWindowSeconds: number;
  sameHeadlineWindowSeconds: number;
  correctionWindowHours: number;
  /** Minimum Jaccard similarity of the two headlines' word sets. Numbers must also match exactly. */
  minHeadlineJaccard: number;
}

/**
 * ASSUMED. In the fixture every translation pair shares its release time to the second, and a company's
 * separate releases are at least 82 s apart (Copenhagen Capital's two "Storaktionærmeddelelse" notices), so
 * 60 s separates them. 0.9 rejects QPR Software's five "Managements' Transactions (<name>)" headlines
 * (similarity 0.71). 72 h is a guess at how long after an announcement a correction still appears.
 */
export const DEDUP_THRESHOLDS: DedupThresholds = {
  translationWindowSeconds: 60,
  sameHeadlineWindowSeconds: 60,
  correctionWindowHours: 72,
  minHeadlineJaccard: 0.9,
};

/** First words that mark a corrected reissue, folded: English, Finnish, Swedish, Danish. */
const CORRECTION_WORDS: ReadonlySet<string> = new Set([
  "correction",
  "corrected",
  "korjaus",
  "korjattu",
  "rattelse",
  "korrigering",
  "rettelse",
  "korrigeret",
]);

export interface DedupItem {
  disclosureId: number;
  company: string | null;
  headline: string;
  language: string | null;
  releasedAt: Date;
}

export type DuplicateReason = "translation" | "same_headline" | "correction";

export interface DedupResult {
  disclosureId: number;
  /** The primary's disclosure ID, or null if this item is a primary or has no duplicates. */
  duplicateOf: number | null;
  /** The rules that paired this item with another; empty when it has no duplicates. */
  reasons: DuplicateReason[];
}

interface Prepared {
  item: DedupItem;
  ms: number;
  key: string;
  isCorrection: boolean;
  words: Set<string>;
  numbers: string;
}

/** One result per input item, in input order. Items with no company are never paired. */
export function flagDuplicates(items: readonly DedupItem[], thresholds: DedupThresholds = DEDUP_THRESHOLDS): DedupResult[] {
  const ids = new Set<number>();
  const byCompany = new Map<string, Prepared[]>();
  for (const item of items) {
    if (ids.has(item.disclosureId)) throw new Error(`Dedup: disclosureId ${item.disclosureId} appears twice`);
    ids.add(item.disclosureId);
    const ms = item.releasedAt instanceof Date ? item.releasedAt.getTime() : Number.NaN;
    if (Number.isNaN(ms)) throw new Error(`Dedup: disclosureId ${item.disclosureId} has an invalid releasedAt`);
    const key = item.company === null ? null : companyKey(item.company);
    if (key === null) continue;
    const words = foldText(item.headline).split(" ").filter((w) => w !== "");
    const isCorrection = words.length > 1 && CORRECTION_WORDS.has(words[0]!);
    const body = isCorrection ? words.slice(1) : words;
    const prepared = { item, ms, key, isCorrection, words: new Set(body), numbers: body.filter((w) => /^\d+$/.test(w)).sort().join(" ") };
    const list = byCompany.get(key);
    if (list === undefined) byCompany.set(key, [prepared]);
    else list.push(prepared);
  }

  const parent = new Map<number, number>();
  const find = (id: number): number => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  const reasons = new Map<number, Set<DuplicateReason>>();
  const join = (a: Prepared, b: Prepared, reason: DuplicateReason): void => {
    for (const p of [a, b]) {
      if (!parent.has(p.item.disclosureId)) parent.set(p.item.disclosureId, p.item.disclosureId);
      const set = reasons.get(p.item.disclosureId) ?? new Set();
      set.add(reason);
      reasons.set(p.item.disclosureId, set);
    }
    parent.set(find(a.item.disclosureId), find(b.item.disclosureId));
  };

  const translationMs = thresholds.translationWindowSeconds * 1000;
  const sameMs = thresholds.sameHeadlineWindowSeconds * 1000;
  const correctionMs = thresholds.correctionWindowHours * 3_600_000;

  for (const list of byCompany.values()) {
    list.sort((a, b) => a.ms - b.ms || a.item.disclosureId - b.item.disclosureId);
    for (const [i, a] of list.entries()) {
      for (const b of list.slice(i + 1)) {
        const gap = b.ms - a.ms;
        if (gap > Math.max(sameMs, correctionMs)) break;
        const similar = nearIdentical(a, b, thresholds.minHeadlineJaccard);
        if (gap <= sameMs && similar && a.isCorrection === b.isCorrection) join(a, b, "same_headline");
        else if (similar && b.isCorrection && !a.isCorrection && gap <= correctionMs) join(a, b, "correction");
      }
    }
    for (const burst of bursts(list, translationMs)) {
      if (!unambiguousLanguages(burst, thresholds.minHeadlineJaccard)) continue;
      for (const [i, a] of burst.entries()) {
        for (const b of burst.slice(i + 1)) {
          if (a.item.language !== null && b.item.language !== null && a.item.language !== b.item.language) join(a, b, "translation");
        }
      }
    }
  }

  const byId = new Map(items.map((i) => [i.disclosureId, i]));
  const groups = new Map<number, DedupItem[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    const group = groups.get(root) ?? [];
    group.push(byId.get(id)!);
    groups.set(root, group);
  }
  const primaryOf = new Map<number, number>();
  for (const group of groups.values()) {
    const primary = [...group].sort(primaryOrder)[0]!;
    for (const item of group) primaryOf.set(item.disclosureId, primary.disclosureId);
  }

  return items.map((item) => {
    const primary = primaryOf.get(item.disclosureId);
    return {
      disclosureId: item.disclosureId,
      duplicateOf: primary === undefined || primary === item.disclosureId ? null : primary,
      reasons: [...(reasons.get(item.disclosureId) ?? [])].sort(),
    };
  });
}

function nearIdentical(a: Prepared, b: Prepared, minJaccard: number): boolean {
  if (a.numbers !== b.numbers) return false;
  let shared = 0;
  for (const w of a.words) if (b.words.has(w)) shared += 1;
  const union = a.words.size + b.words.size - shared;
  return union > 0 && shared / union >= minJaccard;
}

/** Runs of items (sorted by time) where each is within `windowMs` of the previous one. */
function bursts(sorted: readonly Prepared[], windowMs: number): Prepared[][] {
  const out: Prepared[][] = [];
  for (const p of sorted) {
    const last = out.at(-1);
    if (last !== undefined && p.ms - last.at(-1)!.ms <= windowMs) last.push(p);
    else out.push([p]);
  }
  return out.filter((b) => b.length > 1);
}

/** True when, within each language, all of the burst's headlines are near-identical (one release per language). */
function unambiguousLanguages(burst: readonly Prepared[], minJaccard: number): boolean {
  const byLanguage = new Map<string, Prepared[]>();
  for (const p of burst) {
    if (p.item.language === null) continue;
    const list = byLanguage.get(p.item.language) ?? [];
    list.push(p);
    byLanguage.set(p.item.language, list);
  }
  for (const list of byLanguage.values()) {
    for (const other of list.slice(1)) if (!nearIdentical(list[0]!, other, minJaccard)) return false;
  }
  return byLanguage.size > 1;
}

function primaryOrder(a: DedupItem, b: DedupItem): number {
  const t = a.releasedAt.getTime() - b.releasedAt.getTime();
  if (t !== 0) return t;
  const english = Number(b.language === "en") - Number(a.language === "en");
  if (english !== 0) return english;
  return a.disclosureId - b.disclosureId;
}
