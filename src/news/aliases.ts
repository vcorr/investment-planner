import type { Exchange } from "./names.js";

// Names the normalisation rules cannot match. Keep this list small, and give every entry a reason.
// Each alias adds the listed share-list names (`fullName`, exactly as the screener writes them) to whatever
// the rules find. A test checks that every name here exists in the share lists.

export interface CompanyAlias {
  exchange: Exchange;
  /** The announcement's `company` field, exactly as the API writes it. */
  company: string;
  /** Share-list `fullName`s on the same exchange. */
  fullNames: readonly string[];
  why: string;
}

export const COMPANY_ALIASES: readonly CompanyAlias[] = [
  {
    exchange: "CPH",
    company: "NORDEN",
    fullNames: ["D/S Norden"],
    why: "The announcements use the short name; the share list uses the D/S (Dampskibsselskabet) form. In the fixture.",
  },
  {
    exchange: "CPH",
    company: "Copenhagen Capital A/S",
    fullNames: ["Copenhagen 40% Pref 2032"],
    why: "The preference share's list name drops 'Capital', so only the ordinary share ('Copenhagen Capital Stam') matches by rule. In the fixture.",
  },
  {
    exchange: "STO",
    company: "Investment AB Öresund",
    fullNames: ["Öresund"],
    why: "The legal form comes first ('Investment AB'); the share list keeps only 'Öresund'. Name seen in the live API on 2026-09-27.",
  },
  {
    exchange: "HEL",
    company: "Nokian Tyres plc",
    fullNames: ["Nokian Renkaat Oyj"],
    why: "The announcements use the English trading name; the share list uses the Finnish one. Name seen in the live API on 2026-09-27.",
  },
  {
    exchange: "STO",
    company: "Coor Service Management Holding AB",
    fullNames: ["Coor Service Management Hold."],
    why: "The share list abbreviates 'Holding' to 'Hold.'. Name seen in the live API on 2026-09-27.",
  },
];
