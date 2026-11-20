// CSV as Python's csv module reads and writes it (records/*.csv and sources/*.csv are shared with the desktop's
// Python): a header row, double-quoted fields where needed, CRLF line ends on write.

export type Row = Record<string, string>;

export function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, i = 0;
  text = text.replace(/^﻿/, "");
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { quoted = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r" || c === "\n") {
      row.push(field); field = "";
      rows.push(row); row = [];
      i += c === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += c; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter(r => !(r.length === 1 && r[0] === ""));
  if (!header) return [];
  return body.map(r => Object.fromEntries(header.map((h, j) => [h, r[j] ?? ""])));
}

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function writeCsv(fields: string[], rows: Record<string, unknown>[]): string {
  return [fields.map(cell).join(","), ...rows.map(r => fields.map(f => cell(r[f])).join(","))].join("\r\n") + "\r\n";
}
