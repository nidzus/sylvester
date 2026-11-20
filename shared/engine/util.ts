// Small helpers that make the TypeScript engine behave exactly like the Python one
// (coach/rolling.py, coach/library.py): number parsing, rounding, "%g" formatting, tuple ordering, ISO dates.

export type Row = Record<string, unknown>;

/** Python float(v), or null when it isn't a number. */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/** '10/10/9' or '10, 9' or '10' -> [10, 10, 9]. */
export function nums(v: unknown): number[] {
  return (String(v ?? "").match(/\d+(?:\.\d+)?/g) || []).map(Number);
}

/** '8–12' -> [8, 12]; '10–15 / side' -> [10, 15]; '12' -> [12, 12]; '30 m / side' -> null. */
export function repRange(reps: unknown): [number, number] | null {
  const s = String(reps ?? "");
  if (/\d\s*m\b/.test(s)) return null;
  const xs = nums(s.split("/")[0]);
  if (!xs.length) return null;
  return [xs[0], xs.length > 1 ? xs[1] : xs[0]];
}

/** Move n steps (+ up, - down) along the allowed loads from the nearest step at or below load. */
export function step(load: number | null, steps: number[], n: number): number | null {
  if (!steps.length || load === null) return load;
  let i = -1;
  steps.forEach((s, k) => { if (s <= load + 1e-9) i = k; });
  if (i < 0) i = 0;
  return steps[Math.max(0, Math.min(steps.length - 1, i + n))];
}

/** Python round(x, n): the nearest value from x's exact binary expansion, ties (exact ones only) to even. */
export function pyRound(x: number, n = 0): number {
  const exact = Math.abs(x).toFixed(Math.min(100, n + 30));
  const tail = exact.slice(exact.indexOf(".") + 1 + n);
  if (/^50*$/.test(tail)) {
    const lo = Math.floor(Math.abs(x) * 10 ** n);
    const even = lo % 2 === 0 ? lo : lo + 1;
    return Math.sign(x) * even / 10 ** n;
  }
  return Number(x.toFixed(n));
}

/** Python f"{x:g}" for the values the plan prints (loads, RPE, pain, temperatures). */
export function g(x: number): string {
  if (Number.isInteger(x)) return String(x);
  return String(Number(x.toPrecision(6)));
}

/** Compare two key tuples the way Python sorts them (numbers, booleans, strings). */
export function cmpKeys(a: readonly unknown[], b: readonly unknown[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;
    let x = a[i] as unknown, y = b[i] as unknown;
    if (typeof x === "boolean") x = x ? 1 : 0;
    if (typeof y === "boolean") y = y ? 1 : 0;
    if (x === y) continue;
    return (x as number | string) < (y as number | string) ? -1 : 1;
  }
  return 0;
}

export function sortBy<T>(items: T[], key: (t: T) => unknown[]): T[] {
  return items.map(t => [key(t), t] as const).sort((p, q) => cmpKeys(p[0], q[0])).map(p => p[1]);
}

/** The first item with the smallest key (Python min(..., key=...)). */
export function minBy<T>(items: T[], key: (t: T) => unknown[]): T | undefined {
  let best: T | undefined, bk: unknown[] = [];
  for (const t of items) {
    const k = key(t);
    if (best === undefined || cmpKeys(k, bk) < 0) { best = t; bk = k; }
  }
  return best;
}

/** The first item with the largest key (Python max(..., key=...)). */
export function maxBy<T>(items: T[], key: (t: T) => unknown[]): T | undefined {
  let best: T | undefined, bk: unknown[] = [];
  for (const t of items) {
    const k = key(t);
    if (best === undefined || cmpKeys(k, bk) > 0) { best = t; bk = k; }
  }
  return best;
}

export function sortedStrings(xs: Iterable<string>): string[] {
  return [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]));
  }
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every(k => deepEqual((a as Row)[k], (b as Row)[k]));
}

// ---------- dates: ISO "YYYY-MM-DD" strings, calendar arithmetic in UTC ----------

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function toUtc(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export function addDays(day: string, n: number): string {
  return new Date(toUtc(day) + n * 864e5).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / 864e5);
}

/** Monday = 0, as in Python's date.weekday(). */
export function weekday(day: string): number {
  return (new Date(toUtc(day)).getUTCDay() + 6) % 7;
}

/** Today in the phone's own time zone. */
export function localToday(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}
