// Small building blocks every screen uses.

import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { StyleProp, TextInputProps, TextStyle, ViewStyle } from "react-native";

import { radius, space, useTheme } from "./theme.ts";

export function Screen({ children, title, subtitle }: { children: ReactNode; title?: string; subtitle?: string }) {
  const t = useTheme();
  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: space.l, gap: space.l, paddingBottom: 48 }}
      keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="automatic">
      {title ? (
        <View style={{ gap: 2 }}>
          <Text style={{ fontSize: 30, fontWeight: "800", color: t.text }} accessibilityRole="header">{title}</Text>
          {subtitle ? <Text style={{ color: t.muted, fontSize: 15 }}>{subtitle}</Text> : null}
        </View>
      ) : null}
      {children}
    </ScrollView>
  );
}

export function Card({ children, style, tone }: { children: ReactNode; style?: StyleProp<ViewStyle>; tone?: "warn" | "stop" | "soft" }) {
  const t = useTheme();
  const bg = tone === "warn" ? t.warnBg : tone === "stop" ? t.stopBg : tone === "soft" ? t.soft : t.card;
  return <View style={[{ backgroundColor: bg, borderRadius: radius, padding: space.l, gap: space.s, borderWidth: StyleSheet.hairlineWidth, borderColor: t.line }, style]}>{children}</View>;
}

export function H({ children, size = 18 }: { children: ReactNode; size?: number }) {
  const t = useTheme();
  return <Text style={{ fontSize: size, fontWeight: "700", color: t.text }} accessibilityRole="header">{children}</Text>;
}

export function P({ children, muted, small, style, numberOfLines }: { children: ReactNode; muted?: boolean; small?: boolean; style?: StyleProp<TextStyle>; numberOfLines?: number }) {
  const t = useTheme();
  return <Text numberOfLines={numberOfLines} style={[{ color: muted ? t.muted : t.text, fontSize: small ? 13 : 15, lineHeight: small ? 18 : 21 }, style]}>{children}</Text>;
}

export function Bullets({ items, small }: { items: string[]; small?: boolean }) {
  return (
    <View style={{ gap: 4 }}>
      {items.map((x, i) => (
        <View key={i} style={{ flexDirection: "row", gap: 8 }}>
          <P small={small}>•</P>
          <P small={small} style={{ flex: 1 }}>{x}</P>
        </View>
      ))}
    </View>
  );
}

export function Button({ title, onPress, kind = "primary", disabled, busy, small }: {
  title: string; onPress: () => void; kind?: "primary" | "plain" | "danger"; disabled?: boolean; busy?: boolean; small?: boolean;
}) {
  const t = useTheme();
  const bg = kind === "primary" ? t.accent : kind === "danger" ? t.red : t.input;
  const fg = kind === "plain" ? t.text : t.accentText;
  return (
    <Pressable onPress={onPress} disabled={disabled || busy} accessibilityRole="button" accessibilityState={{ disabled: !!(disabled || busy), busy: !!busy }}
      style={({ pressed }) => ({ backgroundColor: bg, opacity: disabled ? 0.45 : pressed ? 0.8 : 1, borderRadius: 12,
        paddingVertical: small ? 8 : 13, paddingHorizontal: small ? 12 : 18, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 8,
        alignSelf: small ? "flex-start" : "stretch" })}>
      {busy ? <ActivityIndicator color={fg} /> : null}
      <Text style={{ color: fg, fontWeight: "700", fontSize: small ? 14 : 16 }}>{title}</Text>
    </Pressable>
  );
}

export function Chip({ label, on, onPress }: { label: string; on?: boolean; onPress?: () => void }) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole={onPress ? "button" : "text"} accessibilityState={{ selected: !!on }}
      style={{ backgroundColor: on ? t.accent : t.input, borderRadius: 999, paddingVertical: 7, paddingHorizontal: 12 }}>
      <Text style={{ color: on ? t.accentText : t.text, fontWeight: "600", fontSize: 14 }}>{label}</Text>
    </Pressable>
  );
}

export function Field({ label, hint, ...props }: TextInputProps & { label?: string; hint?: string }) {
  const t = useTheme();
  return (
    <View style={{ gap: 4, flex: props.multiline ? undefined : 1 }}>
      {label ? <Text style={{ color: t.muted, fontSize: 13, fontWeight: "600" }}>{label}</Text> : null}
      <TextInput placeholderTextColor={t.muted} {...props}
        style={[{ backgroundColor: t.input, color: t.text, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16,
          minHeight: props.multiline ? 80 : undefined, textAlignVertical: props.multiline ? "top" : "center" }, props.style]} />
      {hint ? <Text style={{ color: t.muted, fontSize: 12 }}>{hint}</Text> : null}
    </View>
  );
}

/** A row of numbered buttons for a 0–10 or 1–5 scale; tap again to clear. */
export function Scale({ lo, hi, value, onChange, label, hint }: { lo: number; hi: number; value: string; onChange: (v: string) => void; label: string; hint?: string }) {
  const t = useTheme();
  const vals = Array.from({ length: hi - lo + 1 }, (_, i) => String(lo + i));
  return (
    <View style={{ gap: 6 }} accessibilityLabel={label}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
        <Text style={{ color: t.text, fontWeight: "600", fontSize: 15 }}>{label}</Text>
        {hint ? <Text style={{ color: t.muted, fontSize: 12, flexShrink: 1, textAlign: "right" }}>{hint}</Text> : null}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {vals.map(v => (
          <Pressable key={v} onPress={() => onChange(value === v ? "" : v)} accessibilityRole="button" accessibilityLabel={`${label} ${v}`}
            accessibilityState={{ selected: value === v }}
            style={{ minWidth: 40, height: 40, borderRadius: 10, alignItems: "center", justifyContent: "center",
              backgroundColor: value === v ? t.accent : t.input }}>
            <Text style={{ color: value === v ? t.accentText : t.text, fontWeight: "700" }}>{v}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export function Row({ children, gap = space.s, wrap }: { children: ReactNode; gap?: number; wrap?: boolean }) {
  return <View style={{ flexDirection: "row", alignItems: "center", gap, flexWrap: wrap ? "wrap" : "nowrap" }}>{children}</View>;
}

export function Divider() {
  const t = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.line }} />;
}

/** Plain text with **bold**, "- " bullets and paragraphs: enough for the Coach's answers. */
export function Rich({ text }: { text: string }) {
  const t = useTheme();
  const blocks = text.split(/\n{2,}/);
  const inline = (s: string, key: number) => (
    <Text key={key} style={{ color: t.text, fontSize: 15, lineHeight: 21 }}>
      {s.split(/(\*\*[^*]+\*\*)/g).map((part, i) => part.startsWith("**") && part.endsWith("**")
        ? <Text key={i} style={{ fontWeight: "700" }}>{part.slice(2, -2)}</Text> : part.replace(/`/g, ""))}
    </Text>
  );
  return (
    <View style={{ gap: 8 }}>
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        if (lines.every(l => /^\s*([-*•]|\d+\.)\s/.test(l))) {
          return <View key={i} style={{ gap: 4 }}>{lines.map((l, k) => (
            <View key={k} style={{ flexDirection: "row", gap: 8 }}>
              <Text style={{ color: t.text }}>{/^\s*\d+\./.test(l) ? l.trim().split(/\s/)[0] : "•"}</Text>
              <View style={{ flex: 1 }}>{inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, ""), 0)}</View>
            </View>))}</View>;
        }
        if (/^#{1,4}\s/.test(b)) return <Text key={i} style={{ color: t.text, fontWeight: "800", fontSize: 16 }}>{b.replace(/^#+\s*/, "")}</Text>;
        return inline(b, i);
      })}
    </View>
  );
}
