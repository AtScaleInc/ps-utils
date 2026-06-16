/** Low-level XML / OOXML utilities. */

/** Escape a string for use in an XML attribute value. */
export function xmlAttr(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Convert a 1-based column index to an Excel column letter (A, B, …, Z, AA, …).
 */
export function colLetter(n: number): string {
  let result = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

/**
 * Return the next available rId integer from an XML source string
 * (scans all Id="rIdN" occurrences).
 */
export function nextRid(xmlSrc: string): number {
  const ids = [...xmlSrc.matchAll(/Id="rId(\d+)"/g)].map(m => parseInt(m[1], 10));
  return (ids.length ? Math.max(...ids) : 0) + 1;
}

/**
 * Build a worksheet cell formula reference like `'Sheet Name'!$B$3:$B$12`.
 * Single-quotes the sheet name if it contains spaces or special chars.
 */
export function sheetCellRange(
  sheetTitle: string,
  col: number,
  startRow: number,
  endRow: number,
): string {
  const needsQuotes = /[\s\-&\(\)']/.test(sheetTitle);
  const sn = needsQuotes ? `'${sheetTitle}'` : sheetTitle;
  const c = colLetter(col);
  return `${sn}!$${c}$${startRow}:$${c}$${endRow}`;
}

export function sheetCell(sheetTitle: string, col: number, row: number): string {
  const needsQuotes = /[\s\-&\(\)']/.test(sheetTitle);
  const sn = needsQuotes ? `'${sheetTitle}'` : sheetTitle;
  return `${sn}!$${colLetter(col)}$${row}`;
}
