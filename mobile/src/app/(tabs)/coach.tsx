// The Coach: start a conversation (with a few ready questions) or pick up an earlier one.

import { router } from "expo-router";

import { sendMessage, startThread } from "../../coach/actions.ts";
import { useAppState, useThreads } from "../../store/store.ts";
import { Button, Card, H, P, Screen } from "../../ui/kit.tsx";

const STARTERS: { title: string; text: string; effort: "low" | "medium" | "high"; when?: (s: ReturnType<typeof useAppState>) => boolean }[] = [
  { title: "What should I do today?", text: "What should I do today? Look at my check-in, recovery and the plan.", effort: "medium" },
  { title: "Write my plan", text: "Write my plan: use my calibration results, limits, equipment and goals. Propose it as one new plan, with my way of doing each exercise.", effort: "high" },
  { title: "Read my calibration", text: "Read my calibration results. Tell me my strong areas, weak spots, left/right gaps and anything that disagrees with my profile, then propose the coaching focus and starting loads that follow from them.", effort: "high", when: s => s.assessments.length > 0 },
  { title: "Review the last two weeks", text: "Review the last two weeks against the plan: sessions planned vs logged, loads and reps, recovery against my usual, pain and signals, and how I'm doing overall. End with concrete changes.", effort: "high", when: s => !!s.plan },
  { title: "Show my adaptations", text: "List my adaptations (my way of doing each exercise), which ones are yours to confirm, and which exercises in my plan still have none.", effort: "medium" },
];

export default function Coach() {
  const state = useAppState();
  const threads = useThreads();
  const off = state.settings.claude.mode === "off";
  const open = (text: string, title: string, effort: "low" | "medium" | "high") => {
    const t = startThread(title);
    router.push({ pathname: "/thread/[id]", params: { id: t.id } });
    sendMessage(t.id, text, effort);
  };
  return (
    <Screen title="Coach" subtitle="Your training coach, powered by Claude">
      {off ? (
        <Card>
          <H size={16}>The Coach is off</H>
          <P>Turn it on in Settings with your own Anthropic API key or an invite code. The plan, logging and recovery work without it.</P>
          <Button title="Settings" onPress={() => router.navigate("/settings")} />
        </Card>
      ) : (
        <>
          <Card>
            <H size={16}>Ask</H>
            {STARTERS.filter(s => !s.when || s.when(state)).map(s => (
              <Button key={s.title} kind="plain" title={s.title} onPress={() => open(s.text, s.title, s.effort)} />
            ))}
            <Button title="New conversation" onPress={() => { const t = startThread(); router.push({ pathname: "/thread/[id]", params: { id: t.id } }); }} />
          </Card>
          {threads.length ? (
            <Card>
              <H size={16}>Earlier</H>
              {threads.map(t => (
                <Button key={t.id} kind="plain" title={`${t.title} · ${t.created.slice(5, 10)}`} onPress={() => router.push({ pathname: "/thread/[id]", params: { id: t.id } })} />
              ))}
            </Card>
          ) : null}
          <P muted small>The Coach can propose changes; nothing changes until you tap Apply, and anything that changes exercises or effort gets an independent safety review first. It is not a doctor.</P>
        </>
      )}
    </Screen>
  );
}
