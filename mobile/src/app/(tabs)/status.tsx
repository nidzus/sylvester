// Status: today's recovery colour and why, last night, the week against your usual with 14-day trends, training,
// and the latest weight and blood pressure from Apple Health.

import { useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";

import { STATUS_METRICS } from "../../../../shared/engine/recovery.ts";
import { status } from "../../../../shared/model.ts";
import { useAppState, useToday } from "../../store/store.ts";
import { refreshWearables } from "../../store/sync.ts";
import { Bullets, Card, H, P, Row } from "../../ui/kit.tsx";
import { space, statusColor, useTheme } from "../../ui/theme.ts";

const fmt = (v: number | null | undefined, d = 0) => (v === null || v === undefined ? "–" : v.toFixed(d));

function Bars({ values, color }: { values: (number | null)[]; color: string }) {
  const t = useTheme();
  const xs = values.filter((v): v is number => v !== null);
  if (!xs.length) return null;
  const lo = Math.min(...xs), hi = Math.max(...xs), span = hi - lo || 1;
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 3, height: 34 }} accessibilityElementsHidden>
      {values.map((v, i) => (
        <View key={i} style={{ flex: 1, height: v === null ? 2 : 6 + 28 * ((v - lo) / span), borderRadius: 2,
          backgroundColor: v === null ? t.line : i === values.length - 1 ? color : t.muted, opacity: v === null ? 1 : i === values.length - 1 ? 1 : 0.45 }} />
      ))}
    </View>
  );
}

export default function Status() {
  const t = useTheme();
  const state = useAppState();
  const today = useToday();
  const [refreshing, setRefreshing] = useState(false);
  const st = status(state, today);
  const r = st.recovery;
  const apple = state.daily["Apple Health"] || [];
  const lastWith = (k: string) => [...apple].reverse().find(x => x[k] !== undefined && x[k] !== null && x[k] !== "");
  const w = lastWith("weight_kg"), bp = lastWith("bp_systolic");

  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: space.l, gap: space.l, paddingBottom: 48 }}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await refreshWearables(); setRefreshing(false); }} />}>
      <Text style={{ fontSize: 30, fontWeight: "800", color: t.text }} accessibilityRole="header">Status</Text>
      {!r ? (
        <Card><H size={16}>No recovery data yet</H><P muted>Connect Apple Health or an Oura ring in Settings. With two weeks of data the colour below starts working, and hard days ease off by themselves.</P></Card>
      ) : (
        <>
          <Card>
            <Row>
              <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: statusColor(t, r.status) }} />
              <H size={22}>{r.status === "green" ? "Green" : r.status === "amber" ? "Amber" : "Red"}</H>
            </Row>
            <P>{r.status_meaning}</P>
            {r.status_why.length ? <P muted small>Why: {r.status_why.join("; ")}.</P> : null}
            <P muted small>From {r.source}, {r.latest_date}{r.readiness_today !== null ? ` · ${r.source === "WHOOP" ? "recovery" : "readiness"} ${r.readiness_today}` : ""}{r.temperature_deviation !== null ? ` · temperature ${r.temperature_deviation > 0 ? "+" : ""}${r.temperature_deviation} °C` : ""}</P>
            {r.flags.length ? <Bullets small items={r.flags} /> : null}
          </Card>
          {r.last_night ? (
            <Card>
              <H size={16}>Last night</H>
              <P>{[r.last_night.sleep_h && `${fmt(r.last_night.sleep_h, 1)} h asleep`, r.last_night.deep_h && `${fmt(r.last_night.deep_h, 1)} h deep`,
                r.last_night.rem_h && `${fmt(r.last_night.rem_h, 1)} h REM`, r.last_night.hrv && `HRV ${r.last_night.hrv} ms`,
                r.last_night.lowest_hr && `lowest HR ${r.last_night.lowest_hr}`].filter(Boolean).join(" · ")}</P>
            </Card>
          ) : null}
          <Card>
            <H size={16}>This week against your usual</H>
            <P muted small>7-day average against the 60 days before it; the bars are the last 14 days (today is the dark one).</P>
            {STATUS_METRICS.filter(([k]) => r.metrics[k]?.last_7d !== null).map(([k, better]) => {
              const m = r.metrics[k];
              const d = m.delta_pct;
              const good = d === null ? null : better === "up" ? d >= 0 : d <= 0;
              return (
                <View key={k} style={{ gap: 4, paddingVertical: 4 }}>
                  <Row>
                    <Text style={{ color: t.text, fontWeight: "600", flex: 1 }}>{m.label}</Text>
                    <Text style={{ color: t.text }}>{fmt(m.last_7d, k === "total_sleep_h" ? 1 : 0)}</Text>
                    <Text style={{ color: t.muted, fontSize: 12, width: 104, textAlign: "right" }}>
                      usual {fmt(m.baseline_60d, k === "total_sleep_h" ? 1 : 0)}{d !== null ? ` · ${d > 0 ? "+" : ""}${d}%` : ""}
                    </Text>
                  </Row>
                  <Bars values={st.days.map(x => x[k] as number | null)} color={good === false && Math.abs(d || 0) >= 5 ? t.amber : t.accent} />
                </View>
              );
            })}
          </Card>
        </>
      )}
      <Card>
        <H size={16}>Training</H>
        <P>{st.logged7d} session{st.logged7d === 1 ? "" : "s"} logged in the last 7 days · {st.checkin ? "checked in today" : "no check-in today"}</P>
      </Card>
      {w || bp ? (
        <Card>
          <H size={16}>From Apple Health</H>
          {w ? <P>Weight {String(w.weight_kg)} kg ({w.date})</P> : null}
          {bp ? <P>Blood pressure {String(bp.bp_systolic)}/{String(bp.bp_diastolic)} ({bp.date})</P> : null}
        </Card>
      ) : null}
    </ScrollView>
  );
}
