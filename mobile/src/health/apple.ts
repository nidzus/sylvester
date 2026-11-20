// Apple Health: read-only. Sleep, HRV, resting heart rate and steps (for the recovery colour when there's no Oura
// or WHOOP), plus weight and blood pressure for the Coach. Polar, Garmin, Withings and most scales write into Apple
// Health, so their data arrives here too. Nothing is ever written to Apple Health.
//
// Apple Watch HRV is SDNN, Oura's is RMSSD: the numbers aren't comparable across sources, so each source's
// baseline is its own (the recovery rules compare a source only with itself).

import {
  CategoryValueSleepAnalysis,
  isHealthDataAvailable,
  queryCategorySamples,
  queryQuantitySamples,
  queryStatisticsCollectionForQuantity,
  requestAuthorization,
} from "@kingstinct/react-native-healthkit";
import type { QuantityTypeIdentifier } from "@kingstinct/react-native-healthkit";

import type { DailyRow } from "../engine/types.ts";
import { localToday } from "../engine/util.ts";

const READ = [
  "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
  "HKQuantityTypeIdentifierRestingHeartRate",
  "HKQuantityTypeIdentifierStepCount",
  "HKQuantityTypeIdentifierBodyMass",
  "HKQuantityTypeIdentifierBloodPressureSystolic",
  "HKQuantityTypeIdentifierBloodPressureDiastolic",
  "HKCategoryTypeIdentifierSleepAnalysis",
] as const;

export function available(): boolean {
  try { return isHealthDataAvailable(); } catch { return false; }
}

export async function connect(): Promise<boolean> {
  return requestAuthorization({ toRead: READ });
}

const dayOf = (d: Date) => localToday(d);
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

async function perDay(id: QuantityTypeIdentifier, stat: "cumulativeSum" | "discreteAverage", unit: string, from: Date, to: Date) {
  const out = new Map<string, number>();
  const rows = await queryStatisticsCollectionForQuantity(id, [stat], startOfDay(from), { day: 1 },
    { filter: { date: { startDate: from, endDate: to } }, unit } as never);
  for (const r of rows) {
    const q = stat === "cumulativeSum" ? r.sumQuantity : r.averageQuantity;
    if (r.startDate && q && Number.isFinite(q.quantity)) out.set(dayOf(r.startDate), q.quantity);
  }
  return out;
}

async function samplesPerDay(id: QuantityTypeIdentifier, unit: string, from: Date, to: Date) {
  const sums = new Map<string, [number, number]>();
  const xs = await queryQuantitySamples(id, { limit: -1, unit, filter: { date: { startDate: from, endDate: to } } } as never);
  for (const s of xs) {
    const k = dayOf(s.startDate), [t, n] = sums.get(k) || [0, 0];
    sums.set(k, [t + s.quantity, n + 1]);
  }
  return new Map([...sums].map(([k, [t, n]]) => [k, t / n]));
}

/** Nights of sleep, by the day they ended on: hours asleep, deep and REM. */
async function sleep(from: Date, to: Date) {
  const out = new Map<string, { total: number; deep: number; rem: number }>();
  const xs = await queryCategorySamples("HKCategoryTypeIdentifierSleepAnalysis", { limit: -1, filter: { date: { startDate: from, endDate: to } } } as never);
  // Several sources (a watch and a ring) can record the same night: keep the source with the most sleep.
  const bySource = new Map<string, Map<string, { total: number; deep: number; rem: number }>>();
  for (const s of xs as readonly { value: number; startDate: Date; endDate: Date; sourceRevision?: { source?: { bundleIdentifier?: string } } }[]) {
    const asleep = [CategoryValueSleepAnalysis.asleepUnspecified, CategoryValueSleepAnalysis.asleepCore,
      CategoryValueSleepAnalysis.asleepDeep, CategoryValueSleepAnalysis.asleepREM].includes(s.value);
    if (!asleep) continue;
    const src = s.sourceRevision?.source?.bundleIdentifier || "?";
    const h = (s.endDate.getTime() - s.startDate.getTime()) / 3600e3;
    const k = dayOf(s.endDate);
    const m = bySource.get(src) || new Map();
    const n = m.get(k) || { total: 0, deep: 0, rem: 0 };
    n.total += h;
    if (s.value === CategoryValueSleepAnalysis.asleepDeep) n.deep += h;
    if (s.value === CategoryValueSleepAnalysis.asleepREM) n.rem += h;
    m.set(k, n);
    bySource.set(src, m);
  }
  for (const m of bySource.values()) {
    for (const [k, n] of m) if (!out.has(k) || out.get(k)!.total < n.total) out.set(k, n);
  }
  return out;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export async function pull(days = 14): Promise<DailyRow[]> {
  const to = new Date(), from = startOfDay(new Date(Date.now() - days * 864e5));
  const [steps, rhr, hrv, weight, sys, dia, nights] = await Promise.all([
    perDay("HKQuantityTypeIdentifierStepCount", "cumulativeSum", "count", from, to),
    perDay("HKQuantityTypeIdentifierRestingHeartRate", "discreteAverage", "count/min", from, to),
    perDay("HKQuantityTypeIdentifierHeartRateVariabilitySDNN", "discreteAverage", "ms", from, to),
    perDay("HKQuantityTypeIdentifierBodyMass", "discreteAverage", "kg", from, to),
    samplesPerDay("HKQuantityTypeIdentifierBloodPressureSystolic", "mmHg", from, to),
    samplesPerDay("HKQuantityTypeIdentifierBloodPressureDiastolic", "mmHg", from, to),
    sleep(from, to),
  ]);
  const dates = new Set([...steps.keys(), ...rhr.keys(), ...hrv.keys(), ...weight.keys(), ...sys.keys(), ...nights.keys()]);
  return [...dates].sort().map(date => {
    const row: DailyRow = { date };
    if (steps.has(date)) row.steps = Math.round(steps.get(date)!);
    if (rhr.has(date)) row.lowest_hr = Math.round(rhr.get(date)!);
    if (hrv.has(date)) row.avg_hrv = Math.round(hrv.get(date)!);
    if (weight.has(date)) row.weight_kg = r2(weight.get(date)!);
    if (sys.has(date) && dia.has(date)) { row.bp_systolic = Math.round(sys.get(date)!); row.bp_diastolic = Math.round(dia.get(date)!); }
    const n = nights.get(date);
    if (n) { row.total_sleep_h = r2(n.total); row.deep_sleep_h = r2(n.deep); row.rem_sleep_h = r2(n.rem); }
    return row;
  });
}
