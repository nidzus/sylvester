// One session: pictures, cues and the person's own way of doing each exercise, set-by-set logging, and the switches
// to the easier and the no-equipment versions. On a recovery day nothing but the recovery routine opens.
// Entries are kept as a draft on the phone until saved, so leaving the screen loses nothing.

import Storage from "expo-sqlite/kv-store";
import { Redirect, Stack, router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import type { Session } from "../../../../shared/engine/rolling.ts";
import type { Obj } from "../../../../shared/engine/types.ts";
import { lib, pictures } from "../../store/catalog.ts";
import { collapse, routine, saveWorkout, todayGate } from "../../../../shared/model.ts";
import { update, useAppState, useSchedule, useToday } from "../../store/store.ts";
import { ExercisePicture } from "../../ui/Picture.tsx";
import { Bullets, Button, Card, Chip, Field, H, P, Row, Screen } from "../../ui/kit.tsx";
import { useTheme } from "../../ui/theme.ts";

type SetRow = { reps: string; kg: string; done: boolean };
type Draft = { exercises: { sets: SetRow[]; rpe: string; pain: string; notes: string }[]; duration: string; notes: string };

const UNIT: Record<string, string> = { s: "Seconds", m: "Metres", min: "Minutes" };
const SUFFIX: Record<string, string> = { s: " s", m: " m", min: " min" };

function blank(s: { exercises: Obj[] }): Draft {
  return { exercises: s.exercises.map(e => ({ sets: Array.from({ length: Math.max(1, Number(e.sets) || 1) }, () => ({ reps: "", kg: "", done: false })),
    rpe: "", pain: "", notes: "" })), duration: "", notes: "" };
}

export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const state = useAppState();
  const today = useToday();
  const { schedule } = useSchedule();
  const [easy, setEasy] = useState<boolean | null>(null);
  const [anywhere, setAnywhere] = useState(false);

  const base: Session | null = useMemo(() => {
    if (id?.startsWith("day-")) return schedule?.days.find(d => d.date === id.slice(4))?.session || null;
    if (id?.startsWith("routine-")) return routine(state, lib, id.slice(8), today, pictures);
    return null;
  }, [id, schedule, state, today]);
  if (!base) return <Screen><P>This session isn't in the plan any more.</P></Screen>;
  if (base.battery) return <Redirect href={{ pathname: "/battery/[id]", params: { id: base.battery, date: base.date } }} />;

  const gate = todayGate(state, schedule, today);
  const recoveryKey = gate.recoveryRoutine;
  const isRecoveryRoutine = id === `routine-${recoveryKey}` || (!base.date || id?.startsWith("routine-")) && /back|mobility|recovery/i.test(base.title);
  if (gate.recovery && (base.date === today || id?.startsWith("routine-")) && !isRecoveryRoutine) {
    return <RecoveryCard reasons={gate.reasons} stops={gate.stops} recoveryKey={recoveryKey} title={base.title} />;
  }

  // The planned intensity unless the person switched; the engine already made today easier if the check-in said so.
  const useEasy = easy === null ? false : easy;
  let s: Obj = base;
  let variant = "";
  if (useEasy && base.easy) { s = { ...base, ...base.easy }; variant = "easy"; }
  if (anywhere) {
    const any = useEasy ? base.easy?.anywhere : base.anywhere;
    if (any) { s = { ...s, ...any }; variant += "-anywhere"; }
  }
  return <Logger key={`${id}${variant}`} session={s as Session} storageKey={`draft:${id}:${variant}:${today}`}
    switches={{ easy: base.intensity === "normal" && !!base.easy ? useEasy : null, setEasy, anywhere: base.anywhere || base.easy?.anywhere ? anywhere : null, setAnywhere }} />;
}

function RecoveryCard({ reasons, stops, recoveryKey, title }: { reasons: string[]; stops: string[]; recoveryKey: string | null; title: string }) {
  const state = useAppState();
  const r = recoveryKey ? state.plan?.routines[recoveryKey] : null;
  return (
    <Screen>
      <Stack.Screen options={{ title }} />
      <Card tone="warn">
        <H>Recovery day</H>
        <P>Today: {reasons.join("; ") || "your recovery data and check-in"}.</P>
        <P>No lifting today. Do your recovery routine and an easy 20–30 min walk, or rest.</P>
        {stops.length ? <Card tone="stop"><P>{stops.join(" ")}</P></Card> : null}
        {r ? <Button title={`Open ${r.title}`} onPress={() => router.replace({ pathname: "/session/[id]", params: { id: `routine-${recoveryKey}` } })} /> : null}
      </Card>
    </Screen>
  );
}

function Logger({ session: s, storageKey, switches }: { session: Session; storageKey: string;
  switches: { easy: boolean | null; setEasy: (b: boolean) => void; anywhere: boolean | null; setAnywhere: (b: boolean) => void } }) {
  const t = useTheme();
  const today = useToday();
  const state = useAppState();
  const [draft, setDraft] = useState<Draft>(() => {
    try { const raw = Storage.getItemSync(storageKey); if (raw) return JSON.parse(raw); } catch { /* a fresh draft */ }
    return blank(s);
  });
  const [msg, setMsg] = useState("");
  useEffect(() => { Storage.setItem(storageKey, JSON.stringify(draft)).catch(() => undefined); }, [draft, storageKey]);
  const date = s.date || today;
  const saved = state.workouts.find(w => w.date === date && w.session === s.title);

  const change = (i: number, f: (x: Draft["exercises"][number]) => void) => setDraft(d => {
    const n: Draft = JSON.parse(JSON.stringify(d));
    n.exercises[i] ||= { sets: [{ reps: "", kg: "", done: false }], rpe: "", pain: "", notes: "" };
    f(n.exercises[i]);
    return n;
  });

  const save = () => {
    const exercises = s.exercises.map((e, i) => {
      const d = draft.exercises[i] || { sets: [], rpe: "", pain: "", notes: "" };
      const done = d.sets.filter(x => x.done || x.reps);
      return { exercise: e.name, planned: e.sets && e.reps ? `${e.sets} × ${typeof e.reps === "object" ? "" : e.reps}` : "",
        sets: done.length ? String(done.length) : "", reps: collapse(done.map(x => x.reps)), load_kg: collapse(done.map(x => x.kg)),
        rpe: d.rpe, pain: d.pain, notes: d.notes, set_detail: d.sets };
    }).filter(x => x.sets);
    if (!exercises.length) { setMsg("Tick at least one set before saving."); return; }
    update(st => saveWorkout(st, { date, session: s.title, session_id: s.id, duration_min: draft.duration, notes: draft.notes, exercises }));
    Storage.removeItem(storageKey).catch(() => undefined);
    setMsg("Saved. The next sessions adjust to it.");
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: s.title }} />
      <View style={{ gap: 4 }}>
        <Text style={{ fontSize: 26, fontWeight: "800", color: t.text }}>{s.title}</Text>
        <P muted>{[s.date ? new Date(s.date + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }) : "Routine",
          s.duration && `≈ ${s.duration}`, s.focus, s.rpe_cap && s.rpe_cap < 10 ? `effort ≤ ${s.rpe_cap}/10` : ""].filter(Boolean).join(" · ")}</P>
      </View>
      {switches.easy !== null || switches.anywhere !== null ? (
        <Row wrap>
          {switches.easy !== null ? <Chip label={switches.easy ? "Easier version ✓" : "Easier version"} on={switches.easy} onPress={() => switches.setEasy(!switches.easy)} /> : null}
          {switches.anywhere !== null ? <Chip label={switches.anywhere ? "No equipment ✓" : "No equipment"} on={switches.anywhere} onPress={() => switches.setAnywhere(!switches.anywhere)} /> : null}
        </Row>
      ) : null}
      {s.coach_note ? <Card tone="soft"><P>{s.coach_note}</P></Card> : null}
      {s.warmup?.length ? <Card><H size={16}>Warm-up</H><Bullets items={s.warmup} /></Card> : null}

      {s.exercises.map((e, i) => {
        const d = draft.exercises[i] || { sets: [{ reps: "", kg: "", done: false }], rpe: "", pain: "", notes: "" };
        const reps = typeof e.reps === "object" ? Object.values(e.reps)[0] : e.reps;
        const rx = [e.sets && reps ? `${e.sets} × ${reps}${SUFFIX[e.unit] || ""}` : reps, e.load_kg !== undefined ? `${e.load_kg} kg` : "", e.rest ? `rest ${e.rest}` : ""].filter(Boolean).join(" · ");
        const steps = e.instructions === false ? [] : pictures[e.lib || ""]?.instructions || [];
        return (
          <Card key={`${i}-${e.name}`}>
            <ExercisePicture id={e.lib} name={e.name} />
            <Row><H>{e.name}</H><View style={{ flex: 1 }} /><P muted small>{i + 1}/{s.exercises.length}</P></Row>
            {rx ? <P style={{ fontWeight: "600" }}>{rx}</P> : null}
            {e.cues?.length ? <Bullets items={e.cues} /> : null}
            {e.note ? <P muted small>{e.note}</P> : null}
            {steps.length ? <Steps items={steps} /> : null}
            <View style={{ gap: 6 }}>
              <Row>
                <Text style={{ width: 34, color: t.muted, fontSize: 12 }}>Set</Text>
                <Text style={{ flex: 1, color: t.muted, fontSize: 12 }}>{UNIT[e.unit] || "Reps"}</Text>
                <Text style={{ flex: 1, color: t.muted, fontSize: 12 }}>kg</Text>
                <View style={{ width: 44 }} />
              </Row>
              {d.sets.map((st, k) => (
                <Row key={k}>
                  <Text style={{ width: 34, color: t.text, fontWeight: "700" }}>{k + 1}</Text>
                  <TextInput value={st.reps} onChangeText={x => change(i, ex => { ex.sets[k].reps = x; })} placeholder={String(reps || "")}
                    keyboardType="decimal-pad" placeholderTextColor={t.muted} accessibilityLabel={`Set ${k + 1} ${(UNIT[e.unit] || "reps").toLowerCase()}`}
                    style={{ flex: 1, backgroundColor: t.input, color: t.text, borderRadius: 8, padding: 8, fontSize: 16 }} />
                  <TextInput value={st.kg} onChangeText={x => change(i, ex => { ex.sets[k].kg = x; })} placeholder={e.load_kg !== undefined ? String(e.load_kg) : "–"}
                    keyboardType="decimal-pad" placeholderTextColor={t.muted} accessibilityLabel={`Set ${k + 1} kg`}
                    style={{ flex: 1, backgroundColor: t.input, color: t.text, borderRadius: 8, padding: 8, fontSize: 16 }} />
                  <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: st.done }} accessibilityLabel={`Set ${k + 1} done`}
                    onPress={() => change(i, ex => {
                      const r = ex.sets[k];
                      r.done = !r.done;
                      if (r.done && !r.reps) r.reps = String(reps || "").split(/[–\-/ ]/)[0];
                      if (r.done && !r.kg && e.load_kg !== undefined) r.kg = String(e.load_kg);
                    })}
                    style={{ width: 44, height: 40, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: st.done ? t.accent : t.input }}>
                    <Text style={{ color: st.done ? t.accentText : t.muted, fontSize: 18, fontWeight: "800" }}>✓</Text>
                  </Pressable>
                </Row>
              ))}
              <Button small kind="plain" title="+ Add set" onPress={() => change(i, ex => { ex.sets.push({ reps: "", kg: "", done: false }); })} />
            </View>
            <Pick label="Effort (RPE)" values={["5", "6", "7", "8", "9", "10"]} value={d.rpe} onChange={x => change(i, ex => { ex.rpe = x; })} />
            <Pick label="Pain (0–10)" values={["0", "1", "2", "3", "4", "5", "6", "7", "8"]} value={d.pain} onChange={x => change(i, ex => { ex.pain = x; })} />
            {Number(d.pain) >= 3 ? <P small style={{ color: t.red }}>Pain 3 or more: stop this exercise today. Next time it starts a step lighter.</P> : null}
          </Card>
        );
      })}

      <Card>
        <H size={16}>Finish</H>
        <Field label="Minutes" value={draft.duration} onChangeText={x => setDraft(d => ({ ...d, duration: x }))} keyboardType="number-pad" placeholder="e.g. 40" />
        <Field label="Notes" value={draft.notes} onChangeText={x => setDraft(d => ({ ...d, notes: x }))} multiline placeholder="How did it feel? Anything that ached or felt off?" />
        <Button title="Save workout" onPress={save} />
        {msg ? <P>{msg}</P> : saved ? <P muted small>Saved {saved.saved_at.slice(11, 16)}. Saving again replaces it.</P> : null}
      </Card>
      <Card tone="stop">
        <P small><Text style={{ fontWeight: "700" }}>Stop and get help </Text>for chest pain or pressure, dizziness or fainting, breathlessness out of proportion, palpitations, a sudden severe headache, weakness on one side, or calf pain with swelling. Stop an exercise that sends symptoms down an arm or leg.</P>
      </Card>
    </Screen>
  );
}

function Pick({ label, values, value, onChange }: { label: string; values: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <View style={{ gap: 6 }}>
      <P muted small>{label}</P>
      <Row wrap gap={6}>{values.map(v => <Chip key={v} label={v} on={value === v} onPress={() => onChange(value === v ? "" : v)} />)}</Row>
    </View>
  );
}

function Steps({ items }: { items: string[] }) {
  const [open, setOpen] = useState(false);
  return open ? <View style={{ gap: 4 }}><Bullets small items={items} /><Button small kind="plain" title="Hide steps" onPress={() => setOpen(false)} /></View>
    : <Button small kind="plain" title="Step by step" onPress={() => setOpen(true)} />;
}
