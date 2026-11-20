// The root: loads the phone's data once, refreshes wearables whenever the app comes to the front, and stacks the
// detail screens (a session, a calibration battery, the check-in, a Coach conversation) over the tabs.

import "react-native-url-polyfill/auto"; // full URL / URLSearchParams for the Anthropic SDK and the Oura sign-in

import { Stack } from "expo-router";
import { useEffect } from "react";
import { AppState as RNAppState, View } from "react-native";

import { load, useLoaded } from "../store/store.ts";
import { refreshWearables } from "../store/sync.ts";
import { useTheme } from "../ui/theme.ts";

export default function Root() {
  const loaded = useLoaded();
  const t = useTheme();
  useEffect(() => {
    load().then(() => refreshWearables());
    const sub = RNAppState.addEventListener("change", s => { if (s === "active") refreshWearables(); });
    return () => sub.remove();
  }, []);
  if (!loaded) return <View style={{ flex: 1, backgroundColor: t.bg }} />;
  return (
    <Stack screenOptions={{ headerTintColor: t.accent, headerStyle: { backgroundColor: t.bg }, headerTitleStyle: { color: t.text },
      contentStyle: { backgroundColor: t.bg }, headerBackButtonDisplayMode: "minimal" }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="welcome" options={{ headerShown: false, gestureEnabled: false }} />
      <Stack.Screen name="session/[id]" options={{ title: "" }} />
      <Stack.Screen name="battery/[id]" options={{ title: "Calibration" }} />
      <Stack.Screen name="checkin" options={{ title: "Check-in", presentation: "modal" }} />
      <Stack.Screen name="thread/[id]" options={{ title: "Coach" }} />
    </Stack>
  );
}
