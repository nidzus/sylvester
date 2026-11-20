// Welcome and setup, a step at a time: the disclaimer, you, a health check, aches, equipment, goals, and Apple
// Health. Or import everything from the desktop instead. Setup can run again later; it only replaces its own answers.

import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import * as apple from "../health/apple.ts";
import { lib } from "../store/catalog.ts";
import { fromExport } from "../store/model.ts";
import { CARDIO, DISCLAIMER, EXPERIENCE, GEAR, GOALS, INJURY_STATUS, SCREEN, SERIOUS, SPOTS, TRIGGERS, answersFrom, applySetup, blankAnswers } from "../store/setup.ts";
import type { Ache, SetupAnswers } from "../store/setup.ts";
import { getState, replace, update, useToday } from "../store/store.ts";
import { refreshWearables } from "../store/sync.ts";
import { Bullets, Button, Card, Chip, Field, H, P, Row, Scale, Screen } from "../ui/kit.tsx";
import { useTheme } from "../ui/theme.ts";

const STEPS = ["Welcome", "You", "Health check", "Aches", "Equipment", "Goals", "Apple Health"];
const EXP_LABEL: Record<string, string> = { "none": "New to training", "beginner (< 1 yr)": "Under a year", "returning after a long break": "Returning after a break",
  "intermediate (1–3 yrs)": "1–3 years", "advanced (3+ yrs)": "3+ years" };

export default function Welcome() {
  const t = useTheme();
  const today = useToday();
  const { again } = useLocalSearchParams<{ again?: string }>();
  const [step, setStep] = useState(again ? 1 : 0);
  const [a, setA] = useState<SetupAnswers>(() => (again ? answersFrom(getState()) : blankAnswers()));
  const [accepted, setAccepted] = useState(!!getState().settings.consent.disclaimer);
  const [msg, setMsg] = useState("");
  const set = <K extends keyof SetupAnswers>(k: K, v: SetupAnswers[K]) => setA(o => ({ ...o, [k]: v }));
  const toggle = (k: "conditions" | "gear" | "cardio" | "goals", v: string, max = 99) =>
    setA(o => ({ ...o, [k]: o[k].includes(v) ? o[k].filter(x => x !== v) : o[k].length < max ? [...o[k], v] : o[k] }));

  const importFile = async () => {
    const res = await DocumentPicker.getDocumentAsync({ type: ["application/json", "public.json", "*/*"], copyToCacheDirectory: true });
    if (res.canceled) return;
    try {
      const next = fromExport(JSON.parse(await new File(res.assets[0].uri).text()), getState());
      const done = { ...next, settings: { ...next.settings, consent: { ...next.settings.consent, disclaimer: next.settings.consent.disclaimer || today } } };
      done.profile.health_profile.onboarding = { ...(done.profile.health_profile.onboarding || {}), completed: done.profile.health_profile.onboarding?.completed || today };
      replace(done);
      router.replace("/");
    } catch (e) { setMsg((e as Error).message); }
  };

  const finish = () => {
    update(s => applySetup({ ...s, settings: { ...s.settings, consent: { ...s.settings.consent, disclaimer: s.settings.consent.disclaimer || today } } }, a, lib.data, today));
    router.replace("/");
  };

  const serious = SERIOUS.filter(k => a.screening[k] === "yes");
  const canNext = step !== 0 || accepted;
  const body = (() => {
    switch (step) {
      case 0: return (
        <>
          <Text style={{ fontSize: 34, fontWeight: "800", color: t.text }}>Sylvester</Text>
          <P>A training coach that plans around your body, your equipment and how you slept, and keeps everything on this iPhone.</P>
          <Card tone="warn">
            <P><Text style={{ fontWeight: "700" }}>Heads-up: </Text>{DISCLAIMER}</P>
            <Pressable onPress={() => setAccepted(!accepted)} accessibilityRole="checkbox" accessibilityState={{ checked: accepted }}
              style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
              <View style={{ width: 26, height: 26, borderRadius: 7, borderWidth: 2, borderColor: t.accent, backgroundColor: accepted ? t.accent : "transparent",
                alignItems: "center", justifyContent: "center" }}>{accepted ? <Text style={{ color: t.accentText, fontWeight: "800" }}>✓</Text> : null}</View>
              <P style={{ flex: 1 }}>I understand</P>
            </Pressable>
          </Card>
          <Card>
            <H size={16}>Already use Sylvester on a computer?</H>
            <P muted small>Run `python sylvester.py export` there, AirDrop the file to this iPhone, and import it: your profile, plan, calibration and logs move over.</P>
            <Button kind="plain" title="Import from the desktop" disabled={!accepted} onPress={importFile} />
            {msg ? <P small>{msg}</P> : null}
          </Card>
        </>
      );
      case 1: return (
        <>
          <Field label="What should the Coach call you?" value={a.name} onChangeText={v => set("name", v)} placeholder="First name (optional)" />
          <Row>
            <Field label="Weight (kg)" value={a.weight_kg} onChangeText={v => set("weight_kg", v)} keyboardType="decimal-pad" />
            <Field label="Height (cm)" value={a.height_cm} onChangeText={v => set("height_cm", v)} keyboardType="decimal-pad" />
          </Row>
          <P muted small>How long have you trained regularly?</P>
          <Row wrap>{EXPERIENCE.map(x => <Chip key={x} label={EXP_LABEL[x]} on={a.experience === x} onPress={() => set("experience", x)} />)}</Row>
          <P muted small>Sessions a week</P>
          <Row wrap>{[2, 3, 4].map(n => <Chip key={n} label={String(n)} on={a.days_per_week === n} onPress={() => set("days_per_week", n)} />)}</Row>
          <P muted small>Minutes a session</P>
          <Row wrap>{[30, 45, 60, 75].map(n => <Chip key={n} label={String(n)} on={a.session_minutes === n} onPress={() => set("session_minutes", n)} />)}</Row>
        </>
      );
      case 2: return (
        <>
          {SCREEN.map(([k, q]) => (
            <Card key={k}>
              <P>{q}</P>
              <Row>{(["no", "yes"] as const).map(v => <Chip key={v} label={v === "yes" ? "Yes" : "No"} on={a.screening[k] === v} onPress={() => set("screening", { ...a.screening, [k]: v })} />)}</Row>
            </Card>
          ))}
          {serious.length ? <Card tone="stop"><P><Text style={{ fontWeight: "700" }}>Please talk to your doctor before you start. </Text>Chest pain, dizziness or fainting, or a doctor's advice to train only under supervision, need a doctor's go-ahead first. Sylvester makes no training plan until you've had that conversation and recorded the go-ahead.</P></Card> : null}
          {a.screening.heart === "yes" && !serious.length ? <Card tone="warn"><P>A heart condition needs a doctor's go-ahead before training. If it's high blood pressure only, tick it below.</P></Card> : null}
          <P muted small>Anything you've been diagnosed with (the plan works around these):</P>
          <Row wrap>{Object.entries(lib.data.conditions).map(([id, c]) => <Chip key={id} label={(c.label || id).replace(/\s*\(.*\)$/, "")} on={a.conditions.includes(id)} onPress={() => toggle("conditions", id)} />)}</Row>
          <Field label="Anything else" value={a.other_conditions} onChangeText={v => set("other_conditions", v)} placeholder="e.g. asthma, migraine" />
          <Field label="Medicines you take regularly" value={a.medications} onChangeText={v => set("medications", v)} placeholder="e.g. a blood-pressure tablet" hint="Some change heart rate or balance; the Coach plans around them." />
        </>
      );
      case 3: return <Aches aches={a.aches} onChange={v => set("aches", v)} />;
      case 4: return (
        <>
          <P muted small>What can you use at home or at your gym? Nothing at all is fine too: a wall, a chair and a backpack go a long way.</P>
          <Row wrap>{GEAR.map(([k, label]) => <Chip key={k} label={label} on={a.gear.includes(k)} onPress={() => toggle("gear", k)} />)}</Row>
          <Row wrap>{CARDIO.map(c => <Chip key={c} label={c} on={a.cardio.includes(c)} onPress={() => toggle("cardio", c)} />)}</Row>
          {a.gear.includes("dumbbells") ? (
            <Row>
              <Field label="Heaviest dumbbell (kg)" value={a.dumbbell_max_kg} onChangeText={v => set("dumbbell_max_kg", v)} keyboardType="decimal-pad" />
              <Field label="Steps of (kg)" value={a.dumbbell_step_kg} onChangeText={v => set("dumbbell_step_kg", v)} keyboardType="decimal-pad" />
            </Row>
          ) : null}
          {a.gear.includes("barbell") ? (
            <Row>
              <Field label="Bar (kg)" value={a.barbell_bar_kg} onChangeText={v => set("barbell_bar_kg", v)} keyboardType="decimal-pad" />
              <Field label="Heaviest total (kg)" value={a.barbell_max_kg} onChangeText={v => set("barbell_max_kg", v)} keyboardType="decimal-pad" />
            </Row>
          ) : null}
        </>
      );
      case 5: return (
        <>
          <P muted small>Up to three, most important first.</P>
          <Row wrap>{GOALS.map(([k, label]) => <Chip key={k} label={a.goals.includes(k) ? `${a.goals.indexOf(k) + 1}. ${label}` : label} on={a.goals.includes(k)} onPress={() => toggle("goals", k, 3)} />)}</Row>
          {a.goals.map(g => <Field key={g} label={`${GOALS.find(x => x[0] === g)![1]}: a target (optional)`} value={a.goal_targets[g] || ""}
            onChangeText={v => set("goal_targets", { ...a.goal_targets, [g]: v })} placeholder="e.g. 10 strict push-ups by June" />)}
        </>
      );
      default: return (
        <>
          <P>Apple Health lets Sylvester see your sleep, HRV, resting heart rate and steps, so hard days ease off by themselves. It also reads weight and blood pressure from any app that writes them. Nothing is written back.</P>
          <Button title="Connect Apple Health" disabled={!apple.available()} onPress={async () => {
            try { await apple.connect(); update(s => ({ ...s, settings: { ...s.settings, sources: { ...s.settings.sources, apple_health: true } } })); refreshWearables(); setMsg("Connected."); }
            catch (e) { setMsg((e as Error).message); }
          }} />
          {msg ? <P small>{msg}</P> : null}
          <Card tone="soft">
            <H size={16}>Next</H>
            <Bullets items={["Calibration (Plan tab): a broad baseline over a few short sessions.", "The Coach (Settings): your own Anthropic API key or an invite code; it writes a plan around your baseline.", "Or the starter plan, right away."]} />
          </Card>
        </>
      );
    }
  })();

  return (
    <Screen title={step ? STEPS[step] : undefined} subtitle={step ? `Step ${step} of ${STEPS.length - 1}` : undefined}>
      {body}
      <Row>
        {step > 0 ? <View style={{ flex: 1 }}><Button kind="plain" title="Back" onPress={() => setStep(step - 1)} /></View> : null}
        <View style={{ flex: 2 }}>
          {step < STEPS.length - 1 ? <Button title={step === 0 ? "Set up on this iPhone" : "Next"} disabled={!canNext || (step === 1 && !a.experience)} onPress={() => setStep(step + 1)} />
            : <Button title="Finish" onPress={finish} />}
        </View>
      </Row>
    </Screen>
  );
}

function Aches({ aches, onChange }: { aches: Ache[]; onChange: (a: Ache[]) => void }) {
  const [draft, setDraft] = useState<Ache | null>(null);
  const d = draft;
  return (
    <>
      <P muted small>Anywhere that hurts now, or has hurt and still limits you. Each one tells the plan which movements to leave out or treat with care.</P>
      {aches.map((x, i) => (
        <Card key={i}>
          <Row><H size={16}>{x.spot}{x.side ? ` (${x.side})` : ""}</H><View style={{ flex: 1 }} /><Button small kind="plain" title="Remove" onPress={() => onChange(aches.filter((_, k) => k !== i))} /></Row>
          <P muted small>{[INJURY_STATUS.find(s => s[0] === x.status)?.[1], x.pain ? `pain ${x.pain}/10` : "", x.triggers.join(", ")].filter(Boolean).join(" · ")}</P>
        </Card>
      ))}
      {d ? (
        <Card>
          <Row wrap>{SPOTS.map(s => <Chip key={s} label={s} on={d.spot === s} onPress={() => setDraft({ ...d, spot: s })} />)}</Row>
          <Row wrap>{["left", "right", "both", ""].map(s => <Chip key={s || "none"} label={s || "Middle"} on={d.side === s} onPress={() => setDraft({ ...d, side: s })} />)}</Row>
          <Row wrap>{INJURY_STATUS.map(([v, l]) => <Chip key={v} label={l} on={d.status === v} onPress={() => setDraft({ ...d, status: v })} />)}</Row>
          <Scale label="Pain today" hint="0 none · 10 worst" lo={0} hi={10} value={d.pain} onChange={v => setDraft({ ...d, pain: v })} />
          <P muted small>What makes it worse?</P>
          <Row wrap>{TRIGGERS.map(tr => <Chip key={tr} label={tr} on={d.triggers.includes(tr)}
            onPress={() => setDraft({ ...d, triggers: d.triggers.includes(tr) ? d.triggers.filter(x => x !== tr) : [...d.triggers, tr] })} />)}</Row>
          <Field label="Notes" value={d.notes} onChangeText={v => setDraft({ ...d, notes: v })} placeholder="What a doctor or physio said; what's fine" />
          <Row>
            <Button small title="Add" disabled={!d.spot || !d.status} onPress={() => { onChange([...aches, d]); setDraft(null); }} />
            <Button small kind="plain" title="Cancel" onPress={() => setDraft(null)} />
          </Row>
        </Card>
      ) : (
        <Button kind="plain" title={aches.length ? "Add another" : "Add an ache or injury"} onPress={() => setDraft({ spot: "", side: "", status: "", pain: "", triggers: [], notes: "" })} />
      )}
    </>
  );
}
