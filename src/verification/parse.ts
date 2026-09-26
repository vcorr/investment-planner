export interface VerificationRow {
  id: string;
  item: string;
  finding: string;
  status: string;
}

/** Splits a markdown table row on unescaped pipes. */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replaceAll("\\|", "|"));
}

/** Rows of the form `| V12 | item | finding | status |` from docs/verification.md. Later rows win on duplicate ids. */
export function parseVerificationMarkdown(markdown: string): VerificationRow[] {
  const byId = new Map<string, VerificationRow>();
  for (const line of markdown.split("\n")) {
    if (!/^\|\s*V\d+\s*\|/.test(line)) continue;
    const [id, item, finding, status, ...rest] = cells(line);
    if (!id || item === undefined || finding === undefined || status === undefined || rest.length > 0) {
      throw new Error(`Verification row does not have 4 columns: ${line.slice(0, 80)}`);
    }
    byId.set(id, { id, item, finding, status });
  }
  return [...byId.values()];
}
