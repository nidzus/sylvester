// Recovery status from the wearable's daily rows: port of recovery() in coach/snapshot.py, plus the
// 14-day trend the Status screen draws (trend_days in coach/phone.py).
//
// One addition the desktop doesn't have: Apple Health has no readiness score, so for that source the colour
// comes from the flags alone (HRV, night heart rate, sleep, temperature) once there are two weeks of baseline.

import type { DailyRow, Recovery } from "./types.ts";
import { addDays, daysBetween, g, num, pyRound } from "./util.ts";

// Daily score bands per ring/strap: (red below, green from). Oura readiness and WHOOP recovery differ.
export const BANDS: Record<string, [number, number]> = { Oura: [70, 80], WHOOP: [34, 67] };
export const MIN_REAL_SLEEP_H = 2.0; // shorter records are naps or a ring that came off
export const REST_MODE_BACK_DAYS = 28; // a Rest Mode that ended longer ago no longer shapes the return to training

/** Oura Rest Mode from the rest_mode column (snapshot.rest_mode): on (latest known day, today or yesterday) since
 *  the run's first day; else ended (the day after the last Rest Mode day) when that was within REST_MODE_BACK_DAYS. */
export function restMode(rows: DailyRow[], today: string): Recovery["rest_mode"] {
  const known = rows.filter(r => num(r.rest_mode) !== null);
  if (!known.length) return null;
  const last = known[known.length - 1];
  const on = num(last.rest_mode) === 1 && daysBetween(last.date, today) <= 1;
  let since: string | null = null, ended: string | null = null;
  if (on) {
    let i = known.length - 1;
    while (i > 0 && num(known[i - 1].rest_mode) === 1) i--;
    since = known[i].date;
  } else {
    const prev = [...known].reverse().find(r => num(r.rest_mode) === 1);
    if (prev && daysBetween(prev.date, today) <= REST_MODE_BACK_DAYS) ended = addDays(prev.date, 1);
  }
  return { on, since, ended };
}
const BASELINE_DAYS_NEEDED = 14;

/** A number as Python prints it: integers from the CSV stay integers, computed floats keep their ".0". */
interface PyNum { v: number; float: boolean }
const pn = (v: number, float: boolean): PyNum => ({ v, float });
const show = (x: PyNum) => (x.float && Number.isInteger(x.v) ? x.v.toFixed(1) : String(x.v));
const pyNum = (v: unknown): PyNum | null => {
  const f = num(v);
  return f === null ? null : pn(f, !Number.isInteger(f));
};

/** snapshot.avg: round(mean, 1); the mean of whole numbers stays whole when it divides evenly. */
function avg(rows: DailyRow[], key: string): PyNum | null {
  const vals = rows.map(r => pyNum(r[key])).filter((x): x is PyNum => x !== null);
  if (!vals.length) return null;
  const sum = vals.reduce((s, x) => s + x.v, 0);
  const mean = sum / vals.length;
  const float = vals.some(x => x.float) || !Number.isInteger(mean);
  return pn(pyRound(mean, 1), float);
}

/** The night's own sleep hours: total_sleep_h adds naps in (Oura since 2026-11); older rows only have the total. */
export const nightH = (r: DailyRow) => num(r.night_sleep_h) ?? num(r.total_sleep_h);
const sleepRows = (rows: DailyRow[]) => rows.filter(r => (nightH(r) ?? 0) >= MIN_REAL_SLEEP_H);

const METRICS: [string, string, boolean][] = [
  ["readiness_score", "", false],
  ["avg_hrv", "HRV (ms)", true],
  ["lowest_hr", "Lowest night HR (bpm)", true],
  ["total_sleep_h", "Sleep (h)", true],
  ["sleep_score", "Sleep score", false],
  ["steps", "Steps", false],
];

export const MEANING = {
  green: "Train as planned; a hard session is fine.",
  amber: "Train, but cap intensity (RPE ≤ 7) or trim volume ~20–30%.",
  red: "Recovery day: mobility, easy zone-2 walk/cycle, or rest.",
};

export function recovery(allRows: DailyRow[], source: string, today: string): Recovery | null {
  const rows = [...allRows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (!rows.length) return null;
  const bands = BANDS[source] || null;
  const byDate = new Map(rows.map(r => [r.date, r]));
  const pickDays = (from: number, to: number) => {
    const out: DailyRow[] = [];
    for (let i = from; i < to; i++) { const r = byDate.get(addDays(today, -i)); if (r) out.push(r); }
    return out;
  };
  const last7 = pickDays(0, 7), base = pickDays(7, 67);
  const latest = [...rows].reverse().find(r => num(r.readiness_score) !== null) || rows[rows.length - 1];
  const lastNight = [...rows].reverse().find(r => (nightH(r) ?? 0) >= MIN_REAL_SLEEP_H) || null;

  const scoreLabel = source === "Oura" ? "Readiness" : source === "WHOOP" ? "Recovery" : "Readiness";
  const metrics: Recovery["metrics"] = {};
  const raw: Record<string, { m7: PyNum | null; m60: PyNum | null; delta: PyNum | null }> = {};
  for (const [key, label, sleep] of METRICS) {
    const [a, b] = sleep ? [sleepRows(last7), sleepRows(base)] : [last7, base];
    const m7 = avg(a, key), m60 = avg(b, key);
    const delta = m7 && m60 && m60.v ? pn(pyRound((m7.v - m60.v) / m60.v * 100, 1), true) : null;
    raw[key] = { m7, m60, delta };
    metrics[key] = { label: label || scoreLabel, last_7d: m7?.v ?? null, baseline_60d: m60?.v ?? null, delta_pct: delta?.v ?? null };
  }

  const flags: string[] = [];
  const hrv = raw.avg_hrv;
  if (hrv.delta && hrv.delta.v <= -10) flags.push(`HRV ${show(pn(Math.abs(hrv.delta.v), true))}% below your baseline this week`);
  const rhr = raw.lowest_hr;
  if (rhr.m7 && rhr.m60 && rhr.m7.v - rhr.m60.v >= 3) {
    const float = rhr.m7.float || rhr.m60.float;
    flags.push(`Night resting HR up ${show(pn(pyRound(rhr.m7.v - rhr.m60.v, 1), float))} bpm vs baseline`);
  }
  const sl = avg(last7.map(r => ({ date: r.date, night: nightH(r) })), "night"); // the nights alone: naps don't make up for short nights here
  if (sl && sl.v < 6.5) flags.push(`Averaging ${show(sl)} h of night sleep this week (under 6.5 h)`);
  const temp = pyNum(latest.temperature_deviation);
  if (temp && temp.v >= 0.5) flags.push(`Body temperature +${show(temp)} °C — possible illness, don't train hard`);
  const shortNights = last7.filter(r => { const h = nightH(r) ?? 0; return (h > 0 && h < MIN_REAL_SLEEP_H) || !nightH(r); }).length;
  if (shortNights >= 3) flags.push(`${shortNights} of the last 7 nights have missing or partial sleep data — trends less reliable`);

  const score = num(latest.readiness_score);
  const hard = flags.filter(f => !f.includes("data"));
  const hot = temp !== null && temp.v >= 0.5;
  const rm = restMode(rows, today);
  const resting = !!(rm && rm.on);
  let status: Recovery["status"];
  if (bands) {
    const [redBelow, greenFrom] = bands;
    if (resting || hot || (score !== null && score < redBelow) || hard.length >= 2) status = "red";
    else if (score !== null && score >= greenFrom && !hard.length) status = "green";
    else status = "amber";
  } else {
    const baseNights = sleepRows(base).length;
    if (resting || hot || hard.length >= 2) status = "red";
    else if (!hard.length && baseNights >= BASELINE_DAYS_NEEDED) status = "green";
    else status = "amber";
  }
  // Why, in the words the phone shows: the score against its bands, then what the flags add.
  const name = scoreLabel.toLowerCase();
  const why: string[] = [];
  if (resting) why.push(`Oura rest mode on since ${rm!.since}`);
  if (hot) why.push(`temperature +${show(temp!)} °C`);
  if (bands && score !== null) {
    const [redBelow, greenFrom] = bands;
    why.push(score < redBelow ? `${name} ${g(score)} is under ${redBelow}` : score < greenFrom ? `${name} ${g(score)} (green from ${greenFrom})` : `${name} ${g(score)}`);
  }
  if (!bands && status === "amber" && !hard.length) why.push("still learning your usual HRV, heart rate and sleep");
  why.push(...hard.filter(f => !f.startsWith("Body temperature")).map(f => f[0].toLowerCase() + f.slice(1)));

  return {
    status,
    status_why: why,
    status_meaning: MEANING[status],
    source,
    latest_date: latest.date,
    readiness_today: score,
    temperature_deviation: temp?.v ?? null,
    resilience: (latest.resilience_level as string) || null,
    stress: (latest.stress_summary as string) || null,
    last_night: lastNight ? {
      date: lastNight.date,
      sleep_h: num(lastNight.total_sleep_h),
      deep_h: num(lastNight.deep_sleep_h),
      rem_h: num(lastNight.rem_sleep_h),
      efficiency: num(lastNight.efficiency),
      hrv: num(lastNight.avg_hrv),
      lowest_hr: num(lastNight.lowest_hr),
    } : null,
    metrics,
    flags,
    rest_mode: rm,
  };
}

// The Status screen's rows: metric, which way is better.
export const STATUS_METRICS: [string, "up" | "down"][] = [
  ["readiness_score", "up"], ["avg_hrv", "up"], ["lowest_hr", "down"], ["total_sleep_h", "up"], ["steps", "up"],
];
const SLEEP_COLUMNS = new Set(["avg_hrv", "lowest_hr", "total_sleep_h"]); // only meaningful on nights with real sleep

/** The last n days, one row per calendar day (null where nothing was recorded). */
export function trendDays(rows: DailyRow[], today: string, n = 14): Record<string, number | string | null>[] {
  const byDate = new Map(rows.map(r => [r.date, r]));
  const out: Record<string, number | string | null>[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = addDays(today, -i);
    const r = byDate.get(d) || ({ date: d } as DailyRow);
    const real = (nightH(r) ?? 0) >= MIN_REAL_SLEEP_H;
    const row: Record<string, number | string | null> = { date: d };
    for (const [k] of STATUS_METRICS) {
      const v = num(r[k]);
      row[k] = real || !SLEEP_COLUMNS.has(k) ? (v === null ? null : pyRound(v, 1)) : null;
    }
    out.push(row);
  }
  return out;
}
