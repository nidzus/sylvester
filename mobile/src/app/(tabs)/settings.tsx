// Settings: the Coach (off, own key, or invite code), Apple Health and Oura, your data (import from the desktop,
// backup, erase), setup again, and the small print.

import * as DocumentPicker from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import { router } from "expo-router";
import * as Sharing from "expo-sharing";
import { useEffect, useState } from "react";
import { Alert, Linking } from "react-native";

import { MODELS } from "../../coach/claude.ts";
import { BUILT_IN_SERVER, join, serverUrl, usage } from "../../coach/connection.ts";
import * as apple from "../../health/apple.ts";
import * as oura from "../../health/oura.ts";
import type { ClaudeMode } from "../../store/model.ts";
import { fromExport, toExport } from "../../store/model.ts";
import { getSecret, setSecret } from "../../store/secrets.ts";
import { AI_NOTICE, DISCLAIMER } from "../../store/setup.ts";
import { eraseEverything, getState, replace, update, useAppState } from "../../store/store.ts";
import { refreshWearables } from "../../store/sync.ts";
import { Bullets, Button, Card, Chip, Field, H, P, Row, Screen } from "../../ui/kit.tsx";

const MODES: [ClaudeMode, string][] = [["off", "Off"], ["own_key", "My API key"], ["hosted", "Invite code"]];

export default function Settings() {
  const state = useAppState();
  const c = state.settings.claude;
  const [keyText, setKeyText] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [hasToken, setHasToken] = useState(false);
  const [invite, setInvite] = useState("");
  const [server, setServer] = useState(c.proxyUrl);
  const [advanced, setAdvanced] = useState(false);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [ouraOn, setOuraOn] = useState(false);
  const [used, setUsed] = useState<string>("");
  const say = (k: string, m: string) => setMsg(o => ({ ...o, [k]: m }));

  useEffect(() => {
    getSecret("anthropic_api_key").then(k => setHasKey(!!k));
    getSecret("hosted_token").then(k => setHasToken(!!k));
    oura.isConnected().then(setOuraOn);
  }, []);
  useEffect(() => {
    if (c.mode !== "hosted" || !hasToken) return;
    usage(serverUrl(state)).then(u => setUsed(u ? `This month: $${u.used_usd.toFixed(2)} of $${u.monthly_usd.toFixed(2)}` : "")).catch(() => undefined);
  }, [c.mode, hasToken]);

  const setClaude = (patch: Partial<typeof c>) => update(s => ({ ...s, settings: { ...s.settings, claude: { ...s.settings.claude, ...patch } } }));
  const setSources = (patch: Partial<typeof state.settings.sources>) => update(s => ({ ...s, settings: { ...s.settings, sources: { ...s.settings.sources, ...patch } } }));

  const chooseMode = (m: ClaudeMode) => {
    if (m !== "off" && !state.settings.consent.ai) {
      Alert.alert("What the Coach sees", AI_NOTICE, [
        { text: "Not now", style: "cancel" },
        { text: "I agree", onPress: () => update(s => ({ ...s, settings: { ...s.settings, claude: { ...s.settings.claude, mode: m },
          consent: { ...s.settings.consent, ai: new Date().toISOString().slice(0, 10) } } })) },
      ]);
      return;
    }
    setClaude({ mode: m });
  };

  const saveKey = async () => {
    const k = keyText.trim();
    if (!/^sk-ant-/.test(k)) { say("key", "That doesn't look like an Anthropic API key (they start with sk-ant-)."); return; }
    await setSecret("anthropic_api_key", k);
    setKeyText(""); setHasKey(true); say("key", "Saved in the iPhone Keychain.");
  };

  const doJoin = async () => {
    setBusy("join");
    try {
      const url = (server || BUILT_IN_SERVER).replace(/\/+$/, "");
      setClaude({ proxyUrl: server.trim() });
      const r = await join(url, invite);
      setHasToken(true); setInvite("");
      say("join", `You're in. Your monthly Coach allowance is $${r.monthly_usd}.`);
    } catch (e) { say("join", (e as Error).message); } finally { setBusy(""); }
  };

  const connectApple = async () => {
    if (!apple.available()) { say("apple", "Apple Health isn't available on this device."); return; }
    setBusy("apple");
    try {
      await apple.connect();
      setSources({ apple_health: true });
      const p = await refreshWearables();
      say("apple", p.length ? p.join(" ") : "Connected. If some numbers stay empty, allow them in the Health app: Sharing > Apps > Sylvester.");
    } catch (e) { say("apple", (e as Error).message); } finally { setBusy(""); }
  };

  const connectOura = async () => {
    setBusy("oura");
    try {
      await oura.connect(serverUrl(getState()));
      setSources({ oura: true }); setOuraOn(true);
      const p = await refreshWearables();
      say("oura", p.length ? p.join(" ") : "Connected. Your ring's last 90 days are in.");
    } catch (e) { say("oura", (e as Error).message); } finally { setBusy(""); }
  };

  const importFile = async () => {
    const res = await DocumentPicker.getDocumentAsync({ type: ["application/json", "public.json", "*/*"], copyToCacheDirectory: true });
    if (res.canceled) return;
    try {
      const doc = JSON.parse(await new File(res.assets[0].uri).text());
      const next = fromExport(doc, getState());
      Alert.alert("Replace this phone's data?", `This replaces the profile, plan and logs on this iPhone with the ones in ${res.assets[0].name}. Your Coach settings and connections stay.`, [
        { text: "Cancel", style: "cancel" },
        { text: "Replace", style: "destructive", onPress: () => { replace(next); say("data", "Imported. Delete the file from where you saved it: it holds your health profile."); } },
      ]);
    } catch (e) { say("data", (e as Error).message); }
  };

  const exportFile = async () => {
    try {
      const f = new File(Paths.cache, `sylvester-backup-${new Date().toISOString().slice(0, 10)}.json`);
      if (f.exists) f.delete();
      f.create();
      f.write(JSON.stringify(toExport(getState())));
      await Sharing.shareAsync(f.uri, { mimeType: "application/json", dialogTitle: "Save your Sylvester backup", UTI: "public.json" });
    } catch (e) { say("data", (e as Error).message); }
  };

  return (
    <Screen title="Settings">
      <Card>
        <H size={16}>Coach</H>
        <Row wrap>{MODES.map(([m, label]) => <Chip key={m} label={label} on={c.mode === m} onPress={() => chooseMode(m)} />)}</Row>
        {c.mode === "own_key" ? (
          <>
            <P muted small>Use your own Anthropic API key: you pay Anthropic directly for what you use. A Claude Pro or Max subscription can't be used by other apps; an API key is separate (console.anthropic.com).</P>
            <Field label={hasKey ? "Replace the saved key" : "API key"} value={keyText} onChangeText={setKeyText} secureTextEntry autoCapitalize="none" autoCorrect={false} placeholder="sk-ant-…" />
            <Row>
              <Button small title="Save key" onPress={saveKey} disabled={!keyText.trim()} />
              {hasKey ? <Button small kind="plain" title="Remove key" onPress={async () => { await setSecret("anthropic_api_key", null); setHasKey(false); say("key", "Removed."); }} /> : null}
              <Button small kind="plain" title="Get a key" onPress={() => Linking.openURL("https://console.anthropic.com/settings/keys")} />
            </Row>
            {msg.key ? <P small>{msg.key}</P> : hasKey ? <P small muted>A key is saved.</P> : null}
          </>
        ) : null}
        {c.mode === "hosted" ? (
          <>
            <P muted small>With an invite code, the Coach runs on the Sylvester owner's account, with a monthly allowance. Your requests pass through the Sylvester server, which forwards them and keeps nothing.</P>
            {hasToken ? <P small>{used || "You're connected."}</P> : null}
            <Field label={hasToken ? "Another invite code" : "Invite code"} value={invite} onChangeText={setInvite} autoCapitalize="none" autoCorrect={false} />
            {advanced || !BUILT_IN_SERVER ? <Field label="Sylvester server" value={server} onChangeText={setServer} autoCapitalize="none" autoCorrect={false}
              placeholder={BUILT_IN_SERVER || "https://…"} keyboardType="url" /> : null}
            <Row>
              <Button small title="Join" onPress={doJoin} busy={busy === "join"} disabled={!invite.trim()} />
              {BUILT_IN_SERVER && !advanced ? <Button small kind="plain" title="Advanced" onPress={() => setAdvanced(true)} /> : null}
              {hasToken ? <Button small kind="plain" title="Leave" onPress={async () => { await setSecret("hosted_token", null); setHasToken(false); }} /> : null}
            </Row>
            {msg.join ? <P small>{msg.join}</P> : null}
          </>
        ) : null}
        {c.mode !== "off" ? (
          <>
            <P muted small>Model</P>
            <Row wrap>{MODELS.map(m => <Chip key={m.id} label={m.label} on={c.model === m.id} onPress={() => setClaude({ model: m.id })} />)}</Row>
            <P muted small>{MODELS.find(m => m.id === c.model)?.note}</P>
            <P muted small>{AI_NOTICE}</P>
          </>
        ) : null}
      </Card>

      <Card>
        <H size={16}>Wearables</H>
        <P muted small>Apple Health brings sleep, HRV, resting heart rate, steps, weight and blood pressure (from any app or device that writes to it: Apple Watch, Polar, Garmin, Withings…). Oura adds its readiness score and temperature.</P>
        <Button kind={state.settings.sources.apple_health ? "plain" : "primary"} busy={busy === "apple"}
          title={state.settings.sources.apple_health ? "Apple Health: connected · ask again" : "Connect Apple Health"} onPress={connectApple} />
        {msg.apple ? <P small>{msg.apple}</P> : null}
        {ouraOn ? (
          <Button kind="plain" title="Oura: connected · disconnect" onPress={async () => { await oura.disconnect(); setOuraOn(false); setSources({ oura: false }); }} />
        ) : (
          <Button kind="plain" busy={busy === "oura"} title="Connect Oura" onPress={connectOura} disabled={!serverUrl(state)} />
        )}
        {!serverUrl(state) ? <P muted small>Oura needs a Sylvester server (it holds the Oura app secret); this build has none.</P> : null}
        {msg.oura ? <P small>{msg.oura}</P> : null}
      </Card>

      <Card>
        <H size={16}>Your data</H>
        <P muted small>Everything lives on this iPhone. Moving from the desktop: run `python sylvester.py export` there, AirDrop the file here, then import it.</P>
        <Button kind="plain" title="Import from the desktop or a backup" onPress={importFile} />
        <Button kind="plain" title="Export a backup" onPress={exportFile} />
        <Button kind="plain" title="Run setup again" onPress={() => router.push({ pathname: "/welcome", params: { again: "1" } })} />
        <Button kind="danger" title="Erase everything on this phone" onPress={() => Alert.alert("Erase everything?",
          "Your profile, plan, logs and conversations on this iPhone are deleted. Export a backup first if you want to keep them.", [
            { text: "Cancel", style: "cancel" },
            { text: "Erase", style: "destructive", onPress: async () => {
              await Promise.all([setSecret("anthropic_api_key", null), setSecret("hosted_token", null), oura.disconnect()]);
              await eraseEverything();
            } },
          ])} />
        {msg.data ? <P small>{msg.data}</P> : null}
      </Card>

      <Card>
        <H size={16}>About</H>
        <P small>{DISCLAIMER}</P>
        <Bullets small items={[
          "Exercise drawings: Everkinetic, CC BY-SA 4.0. Photos: free-exercise-db, public domain.",
          "Sylvester is open source (MIT): github.com/nidzus/sylvester.",
        ]} />
      </Card>
    </Screen>
  );
}
