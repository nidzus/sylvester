// A calibration battery: one card per test, one row per side, with its stop rule. Results are saved per date and
// battery (saving again replaces them). Postponed on a recovery day or when a warning signal is up: a baseline
// needs a normal day.

import Storage from "expo-sqlite/kv-store";
import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";

import type { AssessmentResult } from "../../engine/calibration.ts";
import type { Obj } from "../../engine/types.ts";
import { sharedCatalogue } from "../../store/catalog.ts";
import { needsClearance } from "../../store/clearance.ts";
import { battery, saveAssessment, todayGate } from "../../store/model.ts";
import { update, useAppState, useSchedule, useToday } from "../../store/store.ts";
import { ExercisePicture } from "../../ui/Picture.tsx";
import { Bullets, Button, Card, Chip, Field, H, P, Row, Screen } from "../../ui/kit.tsx";
import { useTheme } from "../../ui/theme.ts";

type Cell = { value: string; rpe: string; pain: string; flags: string[]; load_kg: string };

export default function Battery() {
  const { id, date: dateParam } = useLocalSearchParams<{ id: string; date?: string }>();
  const state = useAppState();
  const today = useToday();
  const { schedule } = useSchedule();
  const t = useTheme();
  const date = dateParam || today;
  const doc = battery(state, sharedCatalogue, id, date);
  const key = `assess:${id}:${date}`;
  const [draft, setDraft] = useState<{ r: Record<string, Cell | string>; notes: string }>(() => {
    try { const raw = Storage.getItemSync(key); if (raw) return JSON.parse(raw); } catch { /* fresh */ }
    return { r: {}, notes: "" };
  });
  const [msg, setMsg] = useState("");
  const [goAnyway, setGoAnyway] = useState(false);
  useEffect(() => { Storage.setItem(key, JSON.stringify(draft)).catch(() => undefined); }, [draft, key]);
  if (!doc) return <Screen><P>There's no calibration called {id}.</P></Screen>;

  const gate = todayGate(state, schedule, today);
  const clearance = needsClearance(state.profile.health_profile);
  if (clearance.length) {
    return (
      <Screen>
        <Stack.Screen options={{ title: doc.title }} />
        <Card tone="warn"><H>First, a doctor's go-ahead</H><P>Because of {clearance.join(", ")}, the calibration waits until your doctor has cleared you to train (record it on the Today screen).</P></Card>
      </Screen>
    );
  }
  if (date === today && (gate.recovery || gate.signal) && !goAnyway) {
    return (
      <Screen>
        <Stack.Screen options={{ title: doc.title }} />
        <Card tone="warn">
          <H>Postpone today's calibration</H>
          <P>Today: {gate.reasons.join("; ") || "a warning signal in your check-in"}.</P>
          <P>Move it to the next good day; calibration needs a normal day to be a fair baseline.</P>
          {gate.stops.length ? <Card tone="stop"><P>{gate.stops.join(" ")}</P></Card> : null}
          <Button small kind="plain" title="Only the tape measurements and blood pressure" onPress={() => setGoAnyway(true)} />
        </Card>
      </Screen>
    );
  }

  const cell = (tid: string, side: string, load: unknown): Cell => {
    const c = draft.r[`${tid}|${side}`];
    return typeof c === "object" && c ? c : { value: "", rpe: "", pain: "", flags: [], load_kg: load !== undefined && load !== null ? String(load) : "" };
  };
  const setCell = (tid: string, side: string, load: unknown, f: (c: Cell) => void) => setDraft(d => {
    const c = JSON.parse(JSON.stringify(cell(tid, side, load)));
    f(c);
    return { ...d, r: { ...d.r, [`${tid}|${side}`]: c } };
  });

  const save = () => {
    const results: AssessmentResult[] = [];
    for (const tst of doc.tests as Obj[]) {
      const sides: string[] = tst.sides?.length ? tst.sides : [""];
      const note = String(draft.r[`${tst.id}|note`] || "");
      for (const side of sides) {
        const c = cell(tst.id, side, tst.load_kg);
        if (c.value === "" && !c.flags.length && !(side === sides[0] && note)) continue;
        results.push({ test: tst.id, name: tst.name, side, value: c.value, unit: tst.measure === "score" ? "score" : (tst.unit || ""),
          load_kg: tst.load_kg !== undefined ? c.load_kg : "", rpe: c.rpe, pain: c.pain, flags: c.flags, note: side === sides[0] ? note : "" });
      }
    }
    if (results.find(r => r.unit === "mmHg" && r.value && !/^\d{2,3}\s*\/\s*\d{2,3}$/.test(r.value))) { setMsg("Blood pressure looks like 128/82."); return; }
    if (!results.length) { setMsg("Enter at least one result before saving."); return; }
    update(s => saveAssessment(s, { date, battery: id, title: doc.title, notes: draft.notes, results }));
    setMsg(`Saved ${results.length} results. Ask the Coach to read them when the calibration is done.`);
  };

  let lastCat = "";
  return (
    <Screen>
      <Stack.Screen options={{ title: doc.title }} />
      <View style={{ gap: 4 }}>
        <Text style={{ fontSize: 24, fontWeight: "800", color: t.text }}>{doc.title}</Text>
        <P muted>{[doc.duration && `≈ ${doc.duration}`, `${doc.tests.length} tests`, date].filter(Boolean).join(" · ")}</P>
      </View>
      {doc.coach_note ? <Card tone="soft"><P>{doc.coach_note}</P></Card> : null}
      {doc.warmup?.length ? <Card><H size={16}>Warm-up</H><Bullets items={doc.warmup} /></Card> : null}
      {(doc.tests as Obj[]).map((tst, i) => {
        const head = tst.category && tst.category !== lastCat ? <P key={`c${i}`} muted small style={{ fontWeight: "700", textTransform: "uppercase" }}>{tst.category}</P> : null;
        lastCat = tst.category || lastCat;
        const sides: string[] = tst.sides?.length ? tst.sides : [""];
        const cap = tst.cap ? `${tst.cap}${tst.unit === "s" ? " s" : tst.unit === "reps" ? " reps" : ""}` : "";
        const rx = [tst.load_kg !== undefined ? `${tst.load_kg} kg` : "", tst.rpe && cap ? `stop at RPE 8 or ${cap}` : cap ? `stop at ${cap}` : ""].filter(Boolean).join(" · ");
        const unit = tst.measure === "score" ? "Result" : tst.unit === "reps" ? "Reps" : tst.unit === "s" ? "Seconds" : tst.unit || "Value";
        return (
          <View key={tst.id} style={{ gap: 8 }}>
            {head}
            <Card>
              <ExercisePicture id={tst.lib} name={tst.name} />
              <Row><H>{tst.name}</H><View style={{ flex: 1 }} /><P muted small>{i + 1}/{doc.tests.length}</P></Row>
              {rx ? <P style={{ fontWeight: "600" }}>{rx}</P> : null}
              {tst.gate ? <P muted>{tst.gate}</P> : null}
              {tst.how?.length ? <Bullets items={tst.how} /> : null}
              {tst.cues?.length ? <Bullets small items={tst.cues} /> : null}
              {tst.stop ? <Card tone="stop"><P small>{tst.stop}</P></Card> : null}
              {sides.map(side => {
                const c = cell(tst.id, side, tst.load_kg);
                return (
                  <View key={side} style={{ gap: 6 }}>
                    {side ? <P style={{ fontWeight: "700" }}>{side}</P> : null}
                    {tst.measure === "score" ? (
                      <Row wrap gap={6}>{(tst.options as string[]).map((o, k) => {
                        const v = String(tst.options.length - k);
                        return <Chip key={o} label={o} on={c.value === v} onPress={() => setCell(tst.id, side, tst.load_kg, x => { x.value = x.value === v ? "" : v; })} />;
                      })}</Row>
                    ) : (
                      <Field label={unit} value={c.value} onChangeText={x => setCell(tst.id, side, tst.load_kg, y => { y.value = x.trim(); })}
                        placeholder={tst.measure === "bp" ? "128/82" : tst.cap ? `≤ ${tst.cap}` : ""}
                        keyboardType={tst.measure === "bp" ? "numbers-and-punctuation" : "decimal-pad"} />
                    )}
                    {tst.rpe ? <Row wrap gap={6}><P muted small>RPE</P>{["5", "6", "7", "8", "9", "10"].map(v => (
                      <Chip key={v} label={v} on={c.rpe === v} onPress={() => setCell(tst.id, side, tst.load_kg, x => { x.rpe = x.rpe === v ? "" : v; })} />))}</Row> : null}
                    {tst.pain || (tst.flags || []).some((f: string) => /pain/i.test(f)) ? <Row wrap gap={6}><P muted small>Pain</P>{["0", "1", "2", "3", "4", "5", "6"].map(v => (
                      <Chip key={v} label={v} on={c.pain === v} onPress={() => setCell(tst.id, side, tst.load_kg, x => { x.pain = x.pain === v ? "" : v; })} />))}</Row> : null}
                    {tst.flags?.length ? <Row wrap gap={6}>{(tst.flags as string[]).map(f => (
                      <Chip key={f} label={f} on={c.flags.includes(f)} onPress={() => setCell(tst.id, side, tst.load_kg, x => {
                        x.flags = x.flags.includes(f) ? x.flags.filter(y => y !== f) : [...x.flags, f]; })} />))}</Row> : null}
                  </View>
                );
              })}
              {tst.load_kg !== undefined ? <Field label="Load used (kg)" value={cell(tst.id, sides[0], tst.load_kg).load_kg} keyboardType="decimal-pad"
                onChangeText={x => { for (const sd of sides) setCell(tst.id, sd, tst.load_kg, y => { y.load_kg = x.trim(); }); }} /> : null}
              <Field placeholder="Note (optional)" value={String(draft.r[`${tst.id}|note`] || "")}
                onChangeText={x => setDraft(d => ({ ...d, r: { ...d.r, [`${tst.id}|note`]: x } }))} />
              {tst.why ? <P muted small>Why: {tst.why}</P> : null}
            </Card>
          </View>
        );
      })}
      <Card>
        <H size={16}>Finish</H>
        <Field label="Notes" multiline value={draft.notes} onChangeText={x => setDraft(d => ({ ...d, notes: x }))} placeholder="How did it go? Anything that felt off?" />
        <P muted small>You can save part-way and again later today; the latest save replaces the earlier one.</P>
        <Button title="Save results" onPress={save} />
        {msg ? <Pressable><P>{msg}</P></Pressable> : null}
      </Card>
    </Screen>
  );
}
