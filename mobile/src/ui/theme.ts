// Colours and spacing, light and dark. Status colours always come with a word ("Green", "Recovery day"), never alone.

import { useColorScheme } from "react-native";

const light = {
  bg: "#F4F3EF", card: "#FFFFFF", text: "#1B1D1F", muted: "#646A70", line: "#E2E0DA", accent: "#2F6B4F", accentText: "#FFFFFF",
  soft: "#E9F1EC", green: "#2F7D4F", amber: "#B7791F", red: "#B4432F", warnBg: "#FBF1E1", stopBg: "#F9E4DF", input: "#F7F6F3",
};
const dark: typeof light = {
  bg: "#121314", card: "#1C1E20", text: "#ECEDEE", muted: "#9BA1A6", line: "#2C2F32", accent: "#6FBF94", accentText: "#0E1A13",
  soft: "#1F2B24", green: "#6FBF94", amber: "#E0A84A", red: "#E07A66", warnBg: "#2E2617", stopBg: "#33201C", input: "#232628",
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}

export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24 };
export const radius = 14;

export function statusColor(t: Theme, status?: string | null): string {
  return status === "green" ? t.green : status === "amber" ? t.amber : status === "red" ? t.red : t.muted;
}
