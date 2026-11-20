// Oura API v2 responses -> the daily rows the recovery rules read (the same columns as the desktop's
// sources/oura_daily.csv, built the same way as ingest/oura_pull.py). Pure, so it's tested under Node.

import type { DailyRow, Obj } from "../../../shared/engine/types.ts";

const byDay = (xs: Obj[] | null | undefined) => new Map((xs || []).map(d => [d.day as string, d]));
const hours = (s: unknown) => (typeof s === "number" && s ? Math.round(s / 3600 * 100) / 100 : null);
const minutes = (s: unknown) => (typeof s === "number" ? Math.round(s / 60) : null);
const SLEEP_TYPES = ["long_sleep", "sleep", "late_nap"]; // "rest" is a rest period, not sleep; "deleted" is gone

// Readiness parts besides hrv_balance and resting_heart_rate (older columns); sleep parts by column. As in oura_pull.py.
export const READINESS_PARTS = ["activity_balance", "body_temperature", "previous_day_activity", "previous_night",
  "recovery_index", "sleep_balance", "sleep_regularity"];
export const SLEEP_PARTS: Record<string, string> = {
  deep_sleep: "sleep_deep_contrib", efficiency: "sleep_efficiency_contrib", latency: "sleep_latency_contrib",
  rem_sleep: "sleep_rem_contrib", restfulness: "sleep_restfulness_contrib", timing: "sleep_timing_contrib",
  total_sleep: "sleep_total_contrib",
};
export const REST_MODE_LOOKBACK_DAYS = 60; // Rest Mode periods are listed by start day: look back for one still running

export interface OuraPull {
  daily_readiness?: Obj[]; daily_sleep?: Obj[]; daily_activity?: Obj[]; daily_stress?: Obj[]; daily_resilience?: Obj[]; sleep?: Obj[];
  daily_spo2?: Obj[]; vO2_max?: Obj[]; daily_cardiovascular_age?: Obj[];
  /** null: the endpoint wasn't available, so rest_mode is left out (an empty list means no Rest Mode at all). */
  rest_mode_period?: Obj[] | null;
}

/** Oura's local timestamp ('2026-11-18T23:41:12+01:00') to minutes: '2026-11-18T23:41'. */
const clock = (ts: unknown) => (typeof ts === "string" && ts ? ts.slice(0, 16) : null);

/** 1 on a day in a Rest Mode period, else 0. The day it was switched off doesn't count, unless it began that day too. */
export function restModeOn(periods: Obj[], day: string): number {
  for (const p of periods) {
    const s = p.start_day as string | undefined, e = p.end_day as string | undefined;
    if (s && s <= day && (!e || day < e || day === s)) return 1;
  }
  return 0;
}

/** Every sleep session of each day, the night first: Oura's "long_sleep", else the longest. */
export function sleepByDay(records: Obj[] | null | undefined): Map<string, Obj[]> {
  const rank = (s: Obj) => (s.type === "long_sleep" ? 1e9 : 0) + ((s.total_sleep_duration as number) || 0);
  const out = new Map<string, Obj[]>();
  for (const s of records || []) if (SLEEP_TYPES.includes(s.type as string)) (out.get(s.day as string) || out.set(s.day as string, []).get(s.day as string)!).push(s);
  for (const v of out.values()) v.sort((a, b) => rank(b) - rank(a));
  return out;
}

/** A day's sleep columns: hours add up over all sessions; heart rate, HRV, breathing and the rest describe the night. */
export function sleepFields(sessions: Obj[] | undefined): Obj {
  if (!sessions || !sessions.length) return {};
  const night = sessions[0];
  const add = (k: string) => sessions.reduce((t, s) => t + ((s[k] as number) || 0), 0);
  const total = add("total_sleep_duration"), nightS = (night.total_sleep_duration as number) || 0;
  return {
    total_sleep_h: hours(total), deep_sleep_h: hours(add("deep_sleep_duration")), rem_sleep_h: hours(add("rem_sleep_duration")),
    night_sleep_h: hours(nightS), nap_sleep_h: hours(total - nightS), sleep_sessions: sessions.length,
    efficiency: night.efficiency ?? null, avg_hrv: night.average_hrv ?? null, lowest_hr: night.lowest_heart_rate ?? null,
    avg_breath: night.average_breath ?? null, avg_hr_night: night.average_heart_rate ?? null,
    latency_min: minutes(night.latency), awake_h: hours(night.awake_time), time_in_bed_h: hours(night.time_in_bed),
    restless_periods: night.restless_periods ?? null,
    bedtime_start: clock(night.bedtime_start), bedtime_end: clock(night.bedtime_end),
  };
}

export function ouraRows(p: OuraPull): DailyRow[] {
  const readiness = byDay(p.daily_readiness), sleepDaily = byDay(p.daily_sleep), activity = byDay(p.daily_activity);
  const stress = byDay(p.daily_stress), resil = byDay(p.daily_resilience), spo2 = byDay(p.daily_spo2);
  const vo2 = byDay(p.vO2_max), cva = byDay(p.daily_cardiovascular_age);
  const sessions = sleepByDay(p.sleep);
  const days = [...new Set([...readiness.keys(), ...sleepDaily.keys(), ...activity.keys(), ...sessions.keys()])].sort();
  return days.map(day => {
    const rd = readiness.get(day) || {}, sd = sleepDaily.get(day) || {}, ac = activity.get(day) || {};
    const c = rd.contributors || {};
    const st = stress.get(day) || {}, sp = spo2.get(day) || {}, cv = cva.get(day) || {};
    const row: DailyRow = {
      date: day,
      readiness_score: rd.score ?? null,
      temperature_deviation: rd.temperature_deviation ?? null,
      hrv_balance: c.hrv_balance ?? null,
      resting_hr_contrib: c.resting_heart_rate ?? null,
      sleep_score: sd.score ?? null,
      activity_score: ac.score ?? null,
      steps: ac.steps ?? null,
      active_calories: ac.active_calories ?? null,
      stress_high_min: minutes(st.stress_high),
      stress_summary: st.day_summary ?? null,
      resilience_level: resil.get(day)?.level ?? null,
      temperature_trend_deviation: rd.temperature_trend_deviation ?? null,
      spo2_avg: sp.spo2_percentage?.average ?? null,
      breathing_disturbance_index: sp.breathing_disturbance_index ?? null,
      recovery_high_min: minutes(st.recovery_high),
      high_activity_min: minutes(ac.high_activity_time),
      medium_activity_min: minutes(ac.medium_activity_time),
      low_activity_min: minutes(ac.low_activity_time),
      sedentary_h: hours(ac.sedentary_time),
      non_wear_h: hours(ac.non_wear_time),
      total_calories: ac.total_calories ?? null,
      vo2_max: vo2.get(day)?.vo2_max ?? null,
      cardiovascular_age: cv.vascular_age ?? null,
      pulse_wave_velocity: cv.pulse_wave_velocity ?? null,
      ...Object.fromEntries(READINESS_PARTS.map(k => [`${k}_contrib`, c[k] ?? null])),
      ...Object.fromEntries(Object.entries(SLEEP_PARTS).map(([k, col]) => [col, (sd.contributors || {})[k] ?? null])),
      rest_mode: p.rest_mode_period == null ? null : restModeOn(p.rest_mode_period, day),
      ...sleepFields(sessions.get(day)),
    };
    // Drop empty fields, so a later pull doesn't erase what an earlier one had.
    for (const k of Object.keys(row)) if (row[k] === null || row[k] === undefined) delete row[k];
    return row;
  });
}
