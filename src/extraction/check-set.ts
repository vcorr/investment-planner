// Twenty announcements from test/fixtures/nasdaq-company-news.json for the live extraction check, linked to
// their shares by hand (the company-linking step is a separate task). Chosen to cover inside information, a
// profit warning, M&A seen from both sides, orders, a licence deal with a large partner, multi-class shares,
// Swedish-language text and routine items that should come back as "other". test/extraction.test.ts checks
// that every disclosure ID and ISIN exists in the fixtures.

export const CHECK_SET_SOURCE = {
  news: "test/fixtures/nasdaq-company-news.json",
  shares: "test/fixtures/nasdaq-share-lists.json",
} as const;

export const CHECK_SET: ReadonlyArray<{ disclosureId: number; linkedIsins: readonly string[]; note: string }> = [
  { disclosureId: 1465331, linkedIsins: ["FI4000092556"], note: "Pihlajalinna: inside information, acquisition talks" },
  { disclosureId: 1465303, linkedIsins: ["SE0008294953"], note: "Paradox Interactive sells Playrion to Trophy Games" },
  { disclosureId: 1465278, linkedIsins: ["DK0061537206"], note: "Trophy Games buys Playrion, raises guidance" },
  { disclosureId: 1465293, linkedIsins: ["FI0009007132"], note: "Fortum: tender offer acceptance condition met" },
  { disclosureId: 1465200, linkedIsins: ["FI0009005870"], note: "Konecranes: inside information, targets raised" },
  { disclosureId: 1465169, linkedIsins: ["FI4000390943"], note: "Netum: profit warning" },
  { disclosureId: 1465208, linkedIsins: ["SE0007074166"], note: "Nanexa: licence deal with Novo" },
  { disclosureId: 1465270, linkedIsins: ["SE0008241558"], note: "Cereno Scientific: positive topline results" },
  { disclosureId: 1465267, linkedIsins: ["SE0000118952", "SE0000117970"], note: "NCC: power-line contract; A and B shares" },
  { disclosureId: 1465247, linkedIsins: ["FI4000552500"], note: "Sampo: impairment" },
  { disclosureId: 1465223, linkedIsins: ["SE0000113250"], note: "Skanska: property divestment" },
  { disclosureId: 1465218, linkedIsins: ["FI0009800643"], note: "YIT: data-centre contract" },
  { disclosureId: 1465193, linkedIsins: ["FI0009007900", "FI0009000202"], note: "Kesko: EU approval of acquisition; A and B shares" },
  { disclosureId: 1465172, linkedIsins: ["SE0002478776"], note: "Senzime: US hospital contract" },
  { disclosureId: 1465164, linkedIsins: ["FI0009800551"], note: "Saga Furs: inside information, in Swedish" },
  { disclosureId: 1465348, linkedIsins: ["SE0021921269"], note: "Saab: Canada GlobalEye step" },
  { disclosureId: 1465405, linkedIsins: ["FI4000595756"], note: "Framery: buy-back report, routine" },
  { disclosureId: 1465350, linkedIsins: ["FI4000115464"], note: "Detection Technology: nomination board, routine" },
  { disclosureId: 1465288, linkedIsins: ["SE0015245535"], note: "Nelly: CFO resigns" },
  { disclosureId: 1465142, linkedIsins: ["SE0016101521"], note: "Gigasun: order in China" },
];
