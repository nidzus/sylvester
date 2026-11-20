// The daily check-in: the common scales plus the person's own warning signals. Saving rebuilds today's plan
// at once (a high pain or a signal level can make today easier or a recovery day).

import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";

import { BASE, personal } from "../engine/signals.ts";
import { addDays } from "../engine/util.ts";
import { saveCheckin } from "../store/model.ts";
import { update, useAppState, useToday } from "../store/store.ts";
import { Button, Card, Chip, Field, P, Row, Scale, Screen } from "../ui/kit.tsx";

export default function Checkin() {
  const state = useAppState();
  const today = useToday();
  const [date, setDate] = useState(today);
  const own = personal(state.profile.health_profile);
  const scales = [...BASE, ...own];
  const existing = (d: string) => state.checkins.find(c => c.date === d) || ({ date: d } as Record<string, unknown>);
  const fill = (d: string) => Object.fromEntries([...scales.map(s => s.key), "pain_where", "bp", "notes"].map(k => [k, String(existing(d)[k] ?? "")]));
  const [v, setV] = useState<Record<string, string>>(fill(today));
  const [err, setErr] = useState("");
  const set = (k: string) => (x: string) => setV(o => ({ ...o, [k]: x }));
  const pick = (d: string) => { setDate(d); setV(fill(d)); };

  const save = () => {
    const bp = (v.bp || "").replace(/\s/g, "");
    if (bp && !/^\d{2,3}\/\d{2,3}$/.test(bp)) { setErr("Blood pressure looks like 128/82."); return; }
    update(s => saveCheckin(s, { ...v, bp, date, saved_at: new Date().toISOString() }));
    router.back();
  };

  return (
    <Screen>
      <Row>
        <Chip label="Today" on={date === today} onPress={() => pick(today)} />
        <Chip label="Yesterday" on={date === addDays(today, -1)} onPress={() => pick(addDays(today, -1))} />
      </Row>
      <Card>
        {scales.map(s => (
          <View key={s.key} style={{ gap: 4 }}>
            <Scale label={s.label} hint={s.hint} lo={s.lo} hi={s.hi} value={v[s.key] || ""} onChange={set(s.key)} />
            {s.help ? <P muted small>{s.help}</P> : null}
          </View>
        ))}
      </Card>
      <Card>
        {Number(v.pain) > 0 ? <Field label="Where does it hurt?" value={v.pain_where} onChangeText={set("pain_where")} placeholder="e.g. lower back, left side" /> : null}
        <Field label="Blood pressure (optional)" value={v.bp} onChangeText={set("bp")} placeholder="128/82" keyboardType="numbers-and-punctuation" />
        <Field label="Notes" value={v.notes} onChangeText={set("notes")} multiline placeholder="Slept badly, travelling, anything the Coach should know" />
      </Card>
      {err ? <P style={{ color: "#B4432F" }}>{err}</P> : null}
      <Button title="Save" onPress={save} />
      <P muted small>Chest pain, fainting, sudden severe headache or new weakness on one side: don't train, get medical help now.</P>
    </Screen>
  );
}
