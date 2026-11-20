// The five tabs. Until setup is done, everything goes to the welcome screens.

import { Redirect } from "expo-router";
import { NativeTabs } from "expo-router/native-tabs";

import { isOnboarded } from "../../store/model.ts";
import { useAppState } from "../../store/store.ts";

export default function Tabs() {
  const state = useAppState();
  if (!isOnboarded(state)) return <Redirect href="/welcome" />;
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon sf="figure.strengthtraining.traditional" />
        <NativeTabs.Trigger.Label>Today</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="plan">
        <NativeTabs.Trigger.Icon sf="calendar" />
        <NativeTabs.Trigger.Label>Plan</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="status">
        <NativeTabs.Trigger.Icon sf="waveform.path.ecg" />
        <NativeTabs.Trigger.Label>Status</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="coach">
        <NativeTabs.Trigger.Icon sf="bubble.left.and.text.bubble.right" />
        <NativeTabs.Trigger.Label>Coach</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Icon sf="gearshape" />
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
