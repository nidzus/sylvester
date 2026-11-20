// Today: the morning check-in, what today holds (and why), recovery at a glance, and what's next.

import { router } from "expo-router";
import { useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";

import { Alert } from "react-native";

import { applyChanges, checkPlan } from "../../coach/changes.ts";
import { needsClearance, recordClearance } from "../../store/clearance.ts";
import { lib } from "../../store/catalog.ts";
import { status, todayGate } from "../../store/model.ts";
import { starterPlan } from "../../store/starter.ts";
import { update, useAppState, useSchedule, useToday } from "../../store/store.ts";
import { refreshWearables } from "../../store/sync.ts";
import { DayRow, openDay } from "../../ui/Day.tsx";
import { Bullets, Button, Card, H, P, Row } from "../../ui/kit.tsx";
import { space, statusColor, useTheme } from "../../ui/theme.ts";

export default function Today() {
  const t = useTheme();
  const state = useAppState();
  const today = useToday();
  const { schedule, error } = useSchedule();
  const [refreshing, setRefreshing] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const st = status(state, today);
  const day = schedule?.days[0];
  const gate = todayGate(state, schedule, today);
  const checkin = st.checkin;
  const name = state.profile.health_profile.name;

  const refresh = async () => {
    setRefreshing(true);
    setProblems(await refreshWearables());
    setRefreshing(false);
  };

  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: space.l, gap: space.l, paddingBottom: 48 }}
      contentInsetAdjustmentBehavior="automatic" refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
      <View style={{ gap: 2 }}>
        <Text style={{ fontSize: 30, fontWeight: "800", color: t.text }} accessibilityRole="header">
          {new Date().getHours() < 12 ? "Good morning" : new Date().getHours() < 18 ? "Hello" : "Good evening"}{name ? `, ${name}` : ""}
        </Text>
        <Text style={{ color: t.muted }}>
          {new Date(today + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}
          {schedule?.phase?.name ? ` · ${schedule.phase.name}${schedule.phase.week ? `, week ${schedule.phase.week}` : ""}` : ""}
        </Text>
      </View>

      {problems.length ? <Card tone="warn"><Bullets small items={problems} /></Card> : null}

      {!checkin ? (
        <Card tone="soft">
          <H>Morning check-in</H>
          <P muted>Thirty seconds: how you slept, energy, pain and your own signals. Today's plan adjusts to it.</P>
          <Button title="Check in" onPress={() => router.push("/checkin")} />
        </Card>
      ) : (
        <Card>
          <Row>
            <H size={16}>Checked in</H>
            <View style={{ flex: 1 }} />
            <Button small kind="plain" title="Edit" onPress={() => router.push("/checkin")} />
          </Row>
          <P muted small>{["energy", "mood", "stress", "soreness", "pain"].filter(k => checkin[k] !== undefined && checkin[k] !== "")
            .map(k => `${k} ${checkin[k]}`).join(" · ")}</P>
        </Card>
      )}

      {error ? <Card tone="stop"><P>The plan couldn't be laid out: {error}</P></Card> : null}

      {needsClearance(state.profile.health_profile).length ? <Clearance /> : !state.plan ? <NoPlan /> : day ? (
        <Card tone={gate.recovery ? "warn" : undefined}>
          <P muted small>TODAY</P>
          <H size={22}>{day.title}</H>
          {day.reasons?.length ? <P muted>{(day.kind === "session" && day.intensity === "easy" ? "Easier today: " : "") + day.reasons.join("; ")}.</P> : null}
          {day.note ? <P>{day.note}</P> : null}
          {gate.stops.length ? <Card tone="stop"><P>{gate.stops.join(" ")}</P></Card> : null}
          {day.session && !(day.session.battery && gate.signal) ? (
            <Button title={day.session.battery ? "Open the calibration" : "Open today's session"} onPress={() => openDay(day)} />
          ) : null}
          {day.session?.battery && gate.signal ? <P>A warning signal is up today, so the calibration waits for a normal day: it would not be a fair baseline.</P> : null}
          {(day.kind === "recovery" || day.kind === "rest") && gate.recoveryRoutine && state.plan.routines[gate.recoveryRoutine] ? (
            <Button kind="plain" title={`Open ${state.plan.routines[gate.recoveryRoutine].title}`}
              onPress={() => router.push({ pathname: "/session/[id]", params: { id: `routine-${gate.recoveryRoutine}` } })} />
          ) : null}
        </Card>
      ) : null}

      <Card>
        <Row>
          <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: statusColor(t, st.recovery?.status) }} />
          <H size={16}>{st.recovery ? `Recovery: ${st.recovery.status}` : "Recovery: no wearable data yet"}</H>
        </Row>
        <P muted small>{st.recovery ? `${st.recovery.status_meaning} ${st.recovery.status_why.length ? "(" + st.recovery.status_why.join("; ") + ")" : ""}`
          : "Connect Apple Health or Oura in Settings, so hard days ease off by themselves."}</P>
        <Button small kind="plain" title="Status" onPress={() => router.navigate("/status")} />
      </Card>

      {schedule ? (
        <Card>
          <H size={16}>Coming up</H>
          {schedule.days.slice(1).filter(d => d.session).slice(0, 4).map(d => <DayRow key={d.date} d={d} today={today} />)}
          <Button small kind="plain" title="All 14 days" onPress={() => router.navigate("/plan")} />
        </Card>
      ) : null}
    </ScrollView>
  );
}

function Clearance() {
  const state = useAppState();
  const today = useToday();
  const reasons = needsClearance(state.profile.health_profile);
  return (
    <Card tone="warn">
      <H>First, a doctor's go-ahead</H>
      <P>Because of {reasons.join(", ")}, please talk to your doctor before you start training. Sylvester makes no plan until then, so nothing here pushes you before it's safe.</P>
      <P muted small>Chest pain, fainting or sudden breathlessness right now: call emergency services.</P>
      <Button kind="plain" title="My doctor has cleared me to train" onPress={() => Alert.alert("Recorded with today's date",
        "Only tap this if a doctor (or your care provider) has told you that you can train. Anything they said to avoid, tell the Coach.", [
          { text: "Cancel", style: "cancel" },
          { text: "Yes, I'm cleared", onPress: () => update(s => ({ ...s, profile: { ...s.profile, health_profile: recordClearance(s.profile.health_profile, today, "the person, in the app") } })) },
        ])} />
    </Card>
  );
}

function NoPlan() {
  const state = useAppState();
  const today = useToday();
  const coachOn = state.settings.claude.mode !== "off";
  const [problem, setProblem] = useState("");
  const useStarter = () => {
    const plan = starterPlan(lib, state.profile.health_profile, state.profile.equipment, state.profile.goals, today);
    if (!plan) return;
    const next = applyChanges(state, [{ type: "new_plan", plan }]);
    const { blocking } = checkPlan(next, lib, today);
    if (blocking.length) { setProblem(`The starter plan doesn't fit your limits: ${blocking.join(" ")} Ask the Coach for a plan instead.`); return; }
    update(s => ({ ...applyChanges(s, [{ type: "new_plan", plan }]),
      changeLog: [...s.changeLog, { at: new Date().toISOString(), summary: "Starter plan", verdict: "built in, local checks passed", changes: ["New plan \"starter\""] }] }));
  };
  return (
    <Card>
      <H>No plan yet</H>
      <P>Three ways to start:</P>
      <Bullets items={[
        "Calibration: a broad baseline over a few short sessions, so the plan starts from your real numbers (recommended).",
        coachOn ? "Ask the Coach to write a plan for you." : "Turn on the Coach in Settings and ask it to write a plan for you.",
        "Start with the starter plan: general full-body sessions picked by your limits and equipment.",
      ]} />
      <Button title="Calibration" onPress={() => router.navigate("/plan")} />
      {coachOn ? <Button kind="plain" title="Ask the Coach" onPress={() => router.navigate("/coach")} /> : null}
      <Button kind="plain" title="Use the starter plan" onPress={useStarter} />
      {problem ? <P small>{problem}</P> : null}
    </Card>
  );
}
