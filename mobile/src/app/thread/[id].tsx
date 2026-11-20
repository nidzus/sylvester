// One conversation with the Coach, with its proposals as cards: Apply runs the safety review first when the change
// touches exercises or effort; a blocked proposal can go back to the Coach with the findings.

import { Stack, router, useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { transcript } from "../../coach/agent.ts";
import { applyProposal, askToFix, confirmProposal, declineProposal, sendMessage, useBusy } from "../../coach/actions.ts";
import type { Proposal } from "../../coach/tools.ts";
import { deleteThread, useThreads } from "../../store/store.ts";
import { Bullets, Button, Card, H, P, Rich, Row } from "../../ui/kit.tsx";
import { space, useTheme } from "../../ui/theme.ts";

// Rough cost from the token counts (Opus 5.5 list prices; cache reads at a tenth). For orientation only.
const PRICE: Record<string, [number, number]> = { "claude-opus-5-5": [4, 20], "claude-sonnet-5-5": [2, 10], "claude-haiku-5-5": [0.1, 0.5] };

export default function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const thread = useThreads().find(x => x.id === id);
  const busy = useBusy().get(id || "");
  const [text, setText] = useState("");
  const scroll = useRef<{ scrollToEnd(o?: { animated?: boolean }): void } | null>(null);
  if (!thread) return <View style={{ flex: 1, backgroundColor: t.bg }} />;
  const lines = transcript(thread);
  const [pin, pout] = PRICE[thread.model] || PRICE["claude-opus-5-5"];
  const cost = (thread.usage.input * pin + thread.usage.cache_write * pin * 1.25 + thread.usage.cache_read * pin * 0.1 + thread.usage.output * pout) / 1e6;

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={90}>
      <Stack.Screen options={{ title: thread.title.length > 28 ? thread.title.slice(0, 28) + "…" : thread.title,
        headerRight: () => <Button small kind="plain" title="Delete" onPress={() => { router.back(); deleteThread(thread.id); }} /> }} />
      <ScrollView ref={scroll as never} contentContainerStyle={{ padding: space.l, gap: space.m, paddingBottom: 24 }}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}>
        {lines.map((l, i) => l.role === "tool" ? (
          <Text key={i} style={{ color: t.muted, fontSize: 12, fontStyle: "italic" }}>{l.text}</Text>
        ) : (
          <View key={i} style={{ alignSelf: l.role === "user" ? "flex-end" : "stretch", maxWidth: l.role === "user" ? "85%" : "100%",
            backgroundColor: l.role === "user" ? t.accent : t.card, borderRadius: 14, padding: 12 }}>
            {l.role === "user" ? <Text style={{ color: t.accentText, fontSize: 15 }}>{l.text}</Text> : <Rich text={l.text} />}
          </View>
        ))}
        {thread.proposals.map(p => <ProposalCard key={p.id} threadId={thread.id} p={p} busy={!!busy} />)}
        {busy ? <Row><ActivityIndicator /><P muted>{busy}</P></Row> : null}
        {thread.notice ? <Card tone="warn"><P>{thread.notice}</P></Card> : null}
        {thread.usage.output ? <P muted small>≈ ${cost.toFixed(2)} so far in this conversation</P> : null}
      </ScrollView>
      <View style={{ flexDirection: "row", gap: 8, padding: space.m, borderTopWidth: 1, borderColor: t.line, backgroundColor: t.card }}>
        <TextInput value={text} onChangeText={setText} placeholder="Ask the Coach…" placeholderTextColor={t.muted} multiline
          style={{ flex: 1, color: t.text, backgroundColor: t.input, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, maxHeight: 140 }} />
        <Button small title="Send" disabled={!text.trim() || !!busy} onPress={() => { const m = text.trim(); setText(""); sendMessage(thread.id, m); }} />
      </View>
    </KeyboardAvoidingView>
  );
}

function ProposalCard({ threadId, p, busy }: { threadId: string; p: Proposal; busy: boolean }) {
  const v = p.verdict;
  const tone = p.status === "blocked" ? "stop" : p.status === "applied" ? "soft" : undefined;
  return (
    <Card tone={tone}>
      <P muted small>{p.status === "applied" ? "APPLIED" : p.status === "declined" ? "DECLINED" : p.status === "blocked" ? "BLOCKED BY THE SAFETY REVIEW" : "PROPOSED CHANGE"}</P>
      <H size={17}>{p.summary}</H>
      {p.why ? <P>{p.why}</P> : null}
      <Bullets small items={p.lines} />
      {p.local.warnings.length && p.status === "pending" ? <><P muted small>Worth knowing:</P><Bullets small items={p.local.warnings} /></> : null}
      {v ? (
        <>
          <P small style={{ fontWeight: "700" }}>Safety review: {v.verdict}</P>
          {v.blocking.length ? <Bullets small items={v.blocking} /> : null}
          {v.warnings.length ? <><P muted small>Warnings:</P><Bullets small items={v.warnings} /></> : null}
          {v.missing_information.length ? <><P muted small>Questions:</P><Bullets small items={v.missing_information} /></> : null}
        </>
      ) : null}
      {p.error ? <P small>{p.error}</P> : null}
      {p.status === "pending" && p.confirm?.length ? (
        <Card tone="warn">
          <P small style={{ fontWeight: "700" }}>This loosens your limits:</P>
          <Bullets small items={p.confirm} />
          <Pressable onPress={() => confirmProposal(threadId, p.id, !p.confirmed)} accessibilityRole="checkbox" accessibilityState={{ checked: !!p.confirmed }}
            style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
            <Text style={{ fontSize: 20 }}>{p.confirmed ? "☑" : "☐"}</Text>
            <P small style={{ flex: 1 }}>I've decided this myself (with my doctor or physio where it's medical).</P>
          </Pressable>
        </Card>
      ) : null}
      {p.status === "pending" ? (
        <Row>
          <View style={{ flex: 1 }}><Button title={p.review ? "Review and apply" : "Apply"} disabled={busy || (!!p.confirm?.length && !p.confirmed)} onPress={() => applyProposal(threadId, p.id)} /></View>
          <View style={{ flex: 1 }}><Button kind="plain" title="Decline" disabled={busy} onPress={() => declineProposal(threadId, p.id)} /></View>
        </Row>
      ) : null}
      {p.status === "reviewing" ? <Row><ActivityIndicator /><P muted>Safety review…</P></Row> : null}
      {p.status === "blocked" || (p.status === "applied" && v && (v.warnings.length || v.missing_information.length)) ? (
        <Button kind="plain" title="Send this to the Coach" disabled={busy} onPress={() => askToFix(threadId, p)} />
      ) : null}
    </Card>
  );
}
