// An exercise's start and end positions, alternating slowly so it reads as a two-frame animation (tap to pause).
// Images load from their free sources and stay in the phone's image cache. Credit is always shown.

import { Image } from "expo-image";
import { useEffect, useState } from "react";
import { AccessibilityInfo, Pressable, Text, View } from "react-native";

import { pictures } from "../store/catalog.ts";
import { useTheme } from "./theme.ts";

export function ExercisePicture({ id, name }: { id?: string; name: string }) {
  const t = useTheme();
  const pic = id ? pictures[id] : undefined;
  const [end, setEnd] = useState(false);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null, alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then(reduce => {
      if (alive && !reduce && !paused && (pic?.images.length || 0) > 1) timer = setInterval(() => setEnd(e => !e), 1400);
    });
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, [pic, paused]);
  if (!pic || !pic.images.length) return null;
  const src = pic.images[end && pic.images[1] ? 1 : 0];
  return (
    <View style={{ gap: 4 }}>
      <Pressable onPress={() => setPaused(p => !p)} accessibilityRole="imagebutton"
        accessibilityLabel={`${name}, ${end ? "end" : "start"} position. Tap to ${paused ? "play" : "pause"}.`}>
        <View style={{ backgroundColor: "#FFFFFF", borderRadius: 12, overflow: "hidden" }}>
          <Image source={{ uri: src }} style={{ width: "100%", aspectRatio: 4 / 3 }} contentFit="contain" cachePolicy="disk" transition={150} />
          {pic.images.length > 1 ? (
            <Text style={{ position: "absolute", top: 8, left: 8, backgroundColor: "rgba(0,0,0,0.55)", color: "#fff", fontSize: 12,
              paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, overflow: "hidden" }}>{end ? "End" : "Start"}{paused ? " · paused" : ""}</Text>
          ) : null}
        </View>
      </Pressable>
      <Text style={{ color: t.muted, fontSize: 11 }}>Images: {pic.credit}</Text>
    </View>
  );
}
