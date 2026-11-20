// Fresh wearable data: Apple Health and Oura, pulled when the app opens and when the person pulls to refresh.
// The first pull takes 90 days so the recovery rules have a baseline; later ones the last two weeks.

import { serverUrl } from "../coach/connection.ts";
import * as apple from "../health/apple.ts";
import * as oura from "../health/oura.ts";
import { getState, update } from "./store.ts";
import { mergeDaily } from "./model.ts";

let running: Promise<string[]> | null = null;

/** Returns what went wrong, if anything (one line per source). */
export function refreshWearables(): Promise<string[]> {
  if (running) return running;
  running = (async () => {
    const problems: string[] = [];
    const s = getState();
    if (s.settings.sources.apple_health && apple.available()) {
      try {
        const rows = await apple.pull(s.daily["Apple Health"]?.length ? 14 : 90);
        update(st => mergeDaily(st, "Apple Health", rows));
      } catch (e) { problems.push(`Apple Health: ${(e as Error).message}`); }
    }
    if (s.settings.sources.oura && (await oura.isConnected())) {
      try {
        const rows = await oura.pull(serverUrl(s), s.daily.Oura?.length ? 14 : 90);
        update(st => mergeDaily(st, "Oura", rows));
      } catch (e) { problems.push(`Oura: ${(e as Error).message}`); }
    }
    return problems;
  })().finally(() => { running = null; });
  return running;
}
