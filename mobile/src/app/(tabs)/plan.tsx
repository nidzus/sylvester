// The plan: the next 14 days as laid out now, the calibration tests, every routine (to open by hand), and the
// plan's direction in words.

import { router } from "expo-router";
import { Fragment, useState } from "react";

import { sharedCatalogue } from "../../store/catalog.ts";
import { catalogue } from "../../store/model.ts";
import { useAppState, useSchedule, useToday } from "../../store/store.ts";
import { DayRow } from "../../ui/Day.tsx";
import { Button, Card, Divider, H, P, Rich, Screen } from "../../ui/kit.tsx";

export default function PlanTab() {
  const state = useAppState();
  const today = useToday();
  const { schedule } = useSchedule();
  const [showProgram, setShowProgram] = useState(false);
  const cat = catalogue(state, sharedCatalogue);
  const plan = state.plan;
  const ph = schedule?.phase;

  return (
    <Screen title="Plan" subtitle={plan ? `${plan.name}${ph?.name ? ` · ${ph.name}${ph.week ? `, week ${ph.week}` : ""}` : ""}` : "No plan yet"}>
      {schedule ? (
        <Card>
          <H size={16}>Next 14 days</H>
          <P muted small>Rebuilt whenever something changes: a check-in, a logged workout, new recovery data.</P>
          {schedule.days.map((d, i) => (
            <Fragment key={d.date}>{i ? <Divider /> : null}<DayRow d={d} today={today} /></Fragment>
          ))}
        </Card>
      ) : null}

      <Card>
        <H size={16}>Calibration</H>
        <P muted small>Your baseline: tests over a few short sessions on different days. Nothing goes to failure; each test stops at a set effort or a cap. Retest at the end of each phase.</P>
        {Object.entries(cat.batteries).map(([id, b]) => {
          const done = state.assessments.filter(a => a.battery === id).map(a => a.date).sort().pop();
          const planned = schedule?.days.find(d => d.session?.battery === id)?.date;
          return (
            <Button key={id} kind="plain" title={`${b.title}${done ? ` · done ${done}` : planned ? ` · ${planned}` : ""}`}
              onPress={() => router.push({ pathname: "/battery/[id]", params: { id, date: planned && planned >= today ? planned : today } })} />
          );
        })}
      </Card>

      {plan ? (
        <Card>
          <H size={16}>Routines</H>
          <P muted small>Open one by hand: an extra session, or your recovery routine on a recovery day.</P>
          {Object.entries(plan.routines).map(([key, r]) => (
            <Button key={key} kind="plain" title={r.title || key} onPress={() => router.push({ pathname: "/session/[id]", params: { id: `routine-${key}` } })} />
          ))}
        </Card>
      ) : null}

      {plan?.program ? (
        <Card>
          <H size={16}>The plan in words</H>
          {showProgram ? <Rich text={plan.program} /> : <P muted numberOfLines={3}>{plan.program.replace(/^#.*\n+/, "")}</P>}
          <Button small kind="plain" title={showProgram ? "Less" : "Read it all"} onPress={() => setShowProgram(!showProgram)} />
        </Card>
      ) : null}

      {state.changeLog.length ? (
        <Card>
          <H size={16}>Changes</H>
          {state.changeLog.slice(-8).reverse().map((c, i) => (
            <P key={i} small muted>{c.at.slice(0, 10)} · {c.summary}{c.verdict ? ` (${c.verdict})` : ""}</P>
          ))}
        </Card>
      ) : null}
    </Screen>
  );
}
