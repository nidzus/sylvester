// One planned day, as a compact row (Plan tab) or a card (Today).

import { router } from "expo-router";
import { Pressable, Text, View } from "react-native";

import type { DayEntry } from "../../../shared/engine/rolling.ts";
import { space, useTheme } from "./theme.ts";

export const KIND: Record<string, string> = {
  session: "Train", optional: "Extra", rest: "Rest", recovery: "Recovery", done: "Done", review: "Review",
};

export function dayLabel(date: string, today: string): string {
  if (date === today) return "Today";
  const d = new Date(date + "T12:00:00");
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

export function openDay(d: DayEntry) {
  if (d.session?.battery) router.push({ pathname: "/battery/[id]", params: { id: d.session.battery, date: d.date } });
  else if (d.session) router.push({ pathname: "/session/[id]", params: { id: `day-${d.date}` } });
}

export function DayRow({ d, today }: { d: DayEntry; today: string }) {
  const t = useTheme();
  const training = !!d.session;
  const sub = [d.intensity && d.intensity !== "normal" ? d.intensity : "", ...(d.reasons || []), d.note || ""].filter(Boolean).join(" · ");
  return (
    <Pressable onPress={() => openDay(d)} disabled={!training} accessibilityRole={training ? "button" : "text"}
      style={({ pressed }) => ({ flexDirection: "row", gap: space.m, paddingVertical: 10, opacity: pressed ? 0.7 : 1 })}>
      <View style={{ width: 86 }}>
        <Text style={{ color: d.date === today ? t.accent : t.text, fontWeight: "700" }}>{dayLabel(d.date, today)}</Text>
        <Text style={{ color: t.muted, fontSize: 12 }}>{KIND[d.kind || ""] || d.kind}</Text>
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: training ? t.text : t.muted, fontWeight: training ? "600" : "400" }}>{d.title}</Text>
        {sub ? <Text style={{ color: t.muted, fontSize: 12 }} numberOfLines={2}>{sub}</Text> : null}
      </View>
      {training ? <Text style={{ color: t.muted, fontSize: 18 }}>›</Text> : null}
    </Pressable>
  );
}
